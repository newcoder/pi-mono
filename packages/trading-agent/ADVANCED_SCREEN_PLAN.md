# advanced_screen 增强开发计划

> 对应需求文档: `advanced_screen_cases.md`
> 目标: 补齐 10 条缺失的选股条件，使 advanced_screen 成为真正的多因子组合选股引擎

---

## 架构现状速览

```
TypeScript Wrapper (advanced-screening.ts)
    ↓ 生成 JSON config，调用 Python
screen.py (orchestrator)
    ↓ 批量加载 (db_utils.py)
    - get_klines_batch → DataFrame[code, market, date, open, high, low, close, volume...]
    - get_quotes_batch → DataFrame[所有 quotes 字段]
    - get_fundamentals_batch → DataFrame[所有 fundamentals 字段]
    ↓ 向量化计算 (indicators_vectorized.py)
    - _compute_one_stock: numba 逐股循环计算信号
    ↓ 逐股过滤 (screen.py per-stock loop)
    - AND 逻辑: 所有条件通过才保留
    - 评分截断: score 排序后取 target_count
```

---

## 需求映射与实现策略

| # | 需求 | 类型 | 实现策略 | 复杂度 |
|---|------|------|---------|--------|
| 4 | 涨跌幅/涨停/突破 | 字段扩展 | 开放 `quote` 类型字段 | 低 |
| 5 | ROE/毛利率/营收增长/股息率 | 字段扩展 | 开放 `fundamental` 类型字段 + 动态计算 | 低 |
| 7 | 换手率/资金流向 | 字段扩展 | 开放 `quote` 类型字段 | 低 |
| 1 | 均线多头排列 | 新指标 | `ma_trend` indicator | 中 |
| 8 | 均线乖离率(BIAS) | 新指标 | `bias` indicator | 中 |
| 3 | 量价关系(放量/缩量) | 新指标 | `volume_price` indicator | 中 |
| 2 | MACD即将金叉/底背离 | 新指标 | `macd_status` indicator | 中 |
| 6 | K线形态(锤子线/吞噬) | 新指标 | `candlestick` indicator | 高 |
| 9 | 行业/概念板块筛选 | 范围扩展 | 扩展 `scope` 参数 | 高 |
| 10 | 多指标共振评分 | 架构升级 | 新增 `scoring` 配置 | 高 |

---

## Phase 1: 字段扩展（quote + fundamental）

**目标**: 实现 #4, #5, #7 — 仅需配置映射，零算法开发

### 1.1 Python 层 — `screen.py` & `db_utils.py`

当前 `check_fundamental_condition` 已支持通用 operator 比较 (`>, <, >=, <=, ==, between`)。只需扩展数据源字段映射。

**新增 QUOTE_FIELDS** (from `quotes` 表):
```python
QUOTE_FIELDS = {
    "market_cap", "pe", "pb", "change_pct",
    "turnover",        # 换手率
    "volume",          # 成交量
    "latest",          # 最新价
    "high_52w",        # 52周高
    "low_52w",         # 52周低
    "total_cap",       # 总市值
    "float_cap",       # 流通市值
}
```

**新增 FUNDAMENTAL_FIELDS** (from `fundamentals` 表):
当前已加载全部 fundamentals 字段到 DataFrame，但 schema 未暴露。需要暴露并支持动态计算字段：

- 直接字段: `total_revenue`, `operate_revenue`, `operate_cost`, `operate_profit`, `total_profit`, `net_profit`, `parent_net_profit`, `eps`, `diluted_eps`, `total_assets`, `total_equity`, `parent_equity`, `total_liabilities`, `total_current_assets`, `total_current_liab`, `inventory`, `accounts_rece`, `fixed_asset`, `short_loan`, `long_loan`, `monetary_funds`, `operate_cash_flow`, `invest_cash_flow`, `finance_cash_flow`

- 动态计算字段 (由 Python 在运行时计算):
  - `roe` = `parent_net_profit` / `parent_equity` * 100
  - `gross_margin` = (`operate_revenue` - `operate_cost`) / `operate_revenue` * 100
  - `revenue_growth` — 需要跨期数据，标记为 Phase 2 或要求用户提供同比值
  - `dividend_yield` — 需要分红数据，当前 schema 未包含，标记为待实现

### 1.2 TypeScript 层 — `advanced-screening.ts`

更新 tool schema description，告知 LLM 新增可用字段：
- `quote` 类型可用字段: `change_pct`, `turnover`, `volume`, `latest`, `high_52w`, `low_52w`, `market_cap`, `pe`, `pb`, `total_cap`, `float_cap`
- `fundamental` 类型可用字段: `roe`, `gross_margin`, `total_revenue`, `net_profit`, `parent_net_profit`, `eps`, `total_assets`, `parent_equity`, `operate_cash_flow`, `total_liabilities` 等

### 1.3 验证示例

```json
{"type": "quote", "field": "change_pct", "operator": ">", "value": 7}
{"type": "quote", "field": "turnover", "operator": ">", "value": 5}
{"type": "fundamental", "field": "roe", "operator": ">", "value": 15}
{"type": "fundamental", "field": "gross_margin", "operator": ">", "value": 40}
```

---

## Phase 2: 技术指标扩展（4个新 indicator）

**目标**: 实现 #1, #8, #3, #2 — 需要扩展向量化计算 + 条件判断

### 2.1 新增指标计算 — `indicators_vectorized.py`

在 `_compute_one_stock` 函数中添加以下指标块：

#### `ma_trend` — 均线多头排列/空头排列
```python
if "ma_trend" in needed_indicators:
    ma_trend_params = indicator_params.get("ma_trend", {})
    fast = ma_trend_params.get("fast", 5)
    mid = ma_trend_params.get("mid", 10)
    slow = ma_trend_params.get("slow", 20)
    trend = ma_trend_params.get("trend", "bull")  # "bull" or "bear"
    if len(closes) >= slow + 1:
        ma_fast = np.convolve(closes, np.ones(fast) / fast, mode='valid')[-1]
        ma_mid = np.convolve(closes, np.ones(mid) / mid, mode='valid')[-1]
        ma_slow = np.convolve(closes, np.ones(slow) / slow, mode='valid')[-1]
        if trend == "bull":
            row["ma_trend"] = bool(ma_fast > ma_mid > ma_slow)
        else:
            row["ma_trend"] = bool(ma_fast < ma_mid < ma_slow)
```

#### `bias` — 均线乖离率
```python
if "bias" in needed_indicators:
    bias_params = indicator_params.get("bias", {})
    ma_period = bias_params.get("ma_period", 20)
    if len(closes) >= ma_period:
        ma = np.mean(closes[-ma_period:])
        bias_val = (closes[-1] - ma) / ma * 100 if ma != 0 else 0
        row[f"bias{ma_period}"] = float(bias_val)
```

#### `volume_price` — 量价关系
```python
if "volume_price" in needed_indicators:
    vp_params = indicator_params.get("volume_price", {})
    pattern = vp_params.get("pattern", "volume_surge")  # "volume_surge", "volume_shrink"
    ma_period = vp_params.get("ma_period", 5)
    ratio = vp_params.get("ratio", 1.5)
    if volumes is not None and len(volumes) >= ma_period + 1:
        recent_vol = volumes[-1]
        ma_vol = np.mean(volumes[-(ma_period+1):-1])
        if pattern == "volume_surge":
            row["volume_surge"] = bool(recent_vol > ma_vol * ratio)
        elif pattern == "volume_shrink":
            row["volume_shrink"] = bool(recent_vol < ma_vol / ratio)
```

#### `macd_status` — MACD 即将金叉 / 底背离
```python
if "macd_status" in needed_indicators:
    macd_params = indicator_params.get("macd_status", {})
    status = macd_params.get("status", "near_golden")
    if len(closes) >= 27:
        dif, dea, hist = _macd_numba(closes)
        if status == "near_golden":
            threshold = macd_params.get("threshold", 0.005)
            # DIF 在 DEA 下方但距离很近
            passed = dif[-1] < dea[-1] and abs(dif[-1] - dea[-1]) / abs(dea[-1]) < threshold
            row["macd_near_golden"] = bool(passed)
        elif status == "bullish_divergence":
            # 股价创新低但 MACD 绿柱收敛 (简化: 近5日)
            if len(closes) >= 10 and len(hist) >= 5:
                price_lower = closes[-1] < np.min(closes[-5:-1])
                hist_converge = hist[-1] > hist[-2] > hist[-3]  # 绿柱收敛（负数变大）
                row["macd_bullish_divergence"] = bool(price_lower and hist_converge)
```

### 2.2 新增条件判断 — `screen.py`

在 per-stock filter loop 中添加：

```python
elif indicator == "ma_trend":
    trend_ok = inds_for_stock.get("ma_trend")
    passed = bool(trend_ok)

elif indicator == "bias":
    ma_period = params.get("ma_period", 20)
    bias_val = inds_for_stock.get(f"bias{ma_period}")
    if bias_val is not None:
        passed = eval(f"{bias_val} {operator} {value}")

elif indicator == "volume_price":
    pattern = params.get("pattern", "volume_surge")
    passed = bool(inds_for_stock.get(pattern))

elif indicator == "macd_status":
    status = params.get("status", "near_golden")
    passed = bool(inds_for_stock.get(f"macd_{status}"))
```

### 2.3 TypeScript schema 更新

更新 `advanced-screening.ts` 的 indicator 列表和参数说明。

---

## Phase 3: K线形态识别

**目标**: 实现 #6 — 需要 open/high/low 数据，算法较复杂

### 3.1 数据层

当前 `_compute_one_stock` 只接收 `closes` 和 `volumes`。需要扩展为接收完整 OHLC DataFrame，或至少增加 `opens`, `highs`, `lows` 参数。

修改 `compute_indicators_for_stocks`：
```python
for (code, market), group in df.groupby(grouper):
    closes = group["close"].dropna().values.astype(np.float64)
    opens = group["open"].dropna().values.astype(np.float64) if "open" in group.columns else None
    highs = group["high"].dropna().values.astype(np.float64) if "high" in group.columns else None
    lows = group["low"].dropna().values.astype(np.float64) if "low" in group.columns else None
    row = _compute_one_stock(code, market, closes, needed_indicators, params, volumes, opens, highs, lows)
```

### 3.2 形态算法 — 新增 `candlestick` indicator

```python
if "candlestick" in needed_indicators:
    candle_params = indicator_params.get("candlestick", {})
    pattern = candle_params.get("pattern", "hammer")
    if opens is not None and highs is not None and lows is not None and len(closes) >= 3:
        o, h, l, c = opens[-1], highs[-1], lows[-1], closes[-1]
        body = abs(c - o)
        lower_shadow = min(o, c) - l
        upper_shadow = h - max(o, c)
        total_range = h - l

        if pattern == "hammer":
            # 下影线 >= 2倍实体，上影线很短
            passed = lower_shadow >= 2 * body and upper_shadow <= 0.1 * total_range
            row["candlestick_hammer"] = bool(passed)
        elif pattern == "bullish_engulfing" and len(closes) >= 2:
            # 阳线吞噬: 今日阳线，昨日阴线，今日实体覆盖昨日实体
            prev_o, prev_c = opens[-2], closes[-2]
            passed = c > o and prev_c < prev_o and o <= prev_c and c >= prev_o
            row["candlestick_bullish_engulfing"] = bool(passed)
        elif pattern == "doji":
            # 十字星: 实体很小
            passed = body <= 0.1 * total_range
            row["candlestick_doji"] = bool(passed)
```

### 3.3 条件判断

```python
elif indicator == "candlestick":
    pattern = params.get("pattern", "hammer")
    passed = bool(inds_for_stock.get(f"candlestick_{pattern}"))
```

---

## Phase 4: 行业/概念板块范围筛选

**目标**: 实现 #9 — 扩展 `scope` 参数

### 4.1 数据层 — `db_utils.py`

当前 `get_stock_list` 支持 `all`, `hs300`, `zz500`, `zz1000`, `cyb`, `kcb`, `custom:`。需要扩展：

```python
if scope.startswith("industry:"):
    industry_name = scope.replace("industry:", "")
    rows = conn.execute(
        "SELECT code, name, market FROM stocks WHERE sw_industry = ? ORDER BY code",
        (industry_name,)
    ).fetchall()
    return [{"code": r["code"], "name": r["name"], "market": r["market"]} for r in rows]

if scope.startswith("concept:"):
    concept_name = scope.replace("concept:", "")
    rows = conn.execute(
        """SELECT s.code, s.name, s.market FROM stocks s
           JOIN stock_concepts sc ON s.code = sc.code AND s.market = sc.market
           WHERE sc.concept_name = ?""",
        (concept_name,)
    ).fetchall()
    return [{"code": r["code"], "name": r["name"], "market": r["market"]} for r in rows]
```

### 4.2 TypeScript schema 更新

更新 scope 的 description，说明支持 `industry:xxx` 和 `concept:xxx`。

---

## Phase 5: 多指标共振评分系统

**目标**: 实现 #10 — 从严格 AND 升级到加权评分

### 5.1 当前行为

- 所有条件严格 AND，不满足即排除
- 结果数 > target_count 时，按 `_score` 排序截断

### 5.2 新行为

增加可选的 `scoring` 配置：

```json
{
  "conditions": [...],
  "scoring": {
    "weights": {"ma_cross": 30, "macd_cross": 30, "rsi": 20, "volume_surge": 20},
    "min_score": 70,
    "require_all": false
  }
}
```

### 5.3 实现方案

1. 条件分为两类:
   - **硬性条件** (`required: true` 或不配置 scoring): 必须满足
   - **评分条件** (在 `scoring.weights` 中): 满足则加分

2. 评分逻辑 (per-stock):
```python
score = 0
all_required_passed = True

for cond in conditions:
    indicator = cond.get("indicator")
    passed = check_condition(cond, stock_data)
    
    if scoring and indicator in scoring.get("weights", {}):
        if passed:
            score += scoring["weights"][indicator]
    else:
        # 硬性条件
        if not passed:
            all_required_passed = False
            break

if not all_required_passed:
    continue

if scoring:
    min_score = scoring.get("min_score", 0)
    if score < min_score:
        continue
    row["_score"] = score
```

3. 与 auto-tune 的兼容性:
   - `scoring` 模式下 auto-tune 逻辑需要调整：目标不是找参数使结果数 ≈ target_count，而是调整权重使评分分布合理
   - 建议: scoring 模式下禁用 auto-tune，或仅对硬性条件进行 auto-tune

---

## 实施优先级建议

| 阶段 | 内容 | 预估工作量 | 价值 |
|------|------|-----------|------|
| Phase 1 | 字段扩展 | 2h | 高 — 立刻解锁 40% 的新需求 |
| Phase 2 | 技术指标 | 4h | 高 — 核心量化能力 |
| Phase 4 | 行业/概念筛选 | 2h | 高 — 用户高频需求 |
| Phase 3 | K线形态 | 3h | 中 — 需要更多测试 |
| Phase 5 | 评分系统 | 4h | 中 — 架构改动较大 |

**推荐执行顺序**: Phase 1 → Phase 4 → Phase 2 → Phase 3 → Phase 5

理由: Phase 1 和 Phase 4 是"配置级"改动，风险低、见效快；Phase 2 是主体技术指标；Phase 3 需要扩展数据结构(OHLC)；Phase 5 是架构级改动，放在最后。

---

## 文件修改清单

| 文件 | 修改内容 |
|------|---------|
| `src/tools/advanced-screening.ts` | 更新 schema description，新增 indicator/field 说明 |
| `skills/nl-stock-screener/scripts/screen.py` | 扩展条件判断逻辑，新增 scoring 模式，扩展 scope 解析 |
| `skills/nl-stock-screener/scripts/indicators_vectorized.py` | 新增 ma_trend, bias, volume_price, macd_status, candlestick 计算 |
| `skills/nl-stock-screener/scripts/db_utils.py` | 扩展 get_stock_list 支持 industry/concept scope |
| `skills/nl-stock-screener/scripts/fundamental_fields.py` *(可选新建)* | 集中管理 fundamental 字段映射和动态计算规则 |

---

## 验证方案

每个 Phase 完成后，使用以下 JSON config 进行端到端测试：

```json
{
  "scope": "hs300",
  "conditions": [
    {"type": "quote", "field": "turnover", "operator": ">", "value": 3},
    {"type": "fundamental", "field": "roe", "operator": ">", "value": 10},
    {"type": "technical", "indicator": "ma_trend", "params": {"fast": 5, "mid": 10, "slow": 20, "trend": "bull"}},
    {"type": "technical", "indicator": "macd_status", "params": {"status": "near_golden", "threshold": 0.005}}
  ],
  "target_count": 20
}
```

---

*计划制定日期: 2026-04-29*
