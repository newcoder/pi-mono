# Advanced Screen 后续需求清单

## 背景

当前 `advanced_screen` 支持的技术指标仅有：均线交叉（`ma_cross`）、MACD 交叉（`macd_cross`）、RSI（`rsi`）、布林带收缩（`bollinger_squeeze`）。基本面仅支持 `market_cap`、`pe`、`pb`。以下列出 10 条常用但尚未实现的选股条件，用于指导后续迭代。

---

## 1. 均线多头排列（持续状态）

**场景**：MA5 > MA10 > MA20，且均线向上发散，确认强势趋势。

**缺失原因**：`ma_cross` 只能检测交叉瞬间，无法判断"已持续在上方"的状态。

**建议实现**：
```json
{"type": "technical", "indicator": "ma_trend", "params": {"fast": 5, "mid": 10, "slow": 20, "trend": "bull"}}
```

---

## 2. MACD 即将金叉 / 底背离

**场景**：DIF 无限接近 DEA（距离<0.5%），或股价创新低但 MACD 绿柱收敛（底背离）。

**缺失原因**：`macd_cross` 只有严格的 golden/death 布尔判断，没有"接近金叉"或"背离"模式。

**建议实现**：
```json
{"type": "technical", "indicator": "macd_status", "params": {"status": "near_golden", "threshold": 0.005}}
```
或
```json
{"type": "technical", "indicator": "macd_status", "params": {"status": "bullish_divergence"}}
```

---

## 3. 量价关系筛选（放量上涨 / 缩量回调）

**场景**：突破时成交量 > 5 日均量 1.5 倍，或回调时成交量萎缩至地量。

**缺失原因**：`bollinger_squeeze` 虽有 `volume_ratio`，但仅用于布林带收缩后的放量突破，无法独立作为通用量价条件。

**建议实现**：
```json
{"type": "technical", "indicator": "volume_price", "params": {"pattern": "volume_surge", "ma_period": 5, "ratio": 1.5}}
```

---

## 4. 涨跌幅 / 涨停 / 突破筛选

**场景**：当日涨跌幅 > 7%、涨停、创 20 日新高、突破年线。

**缺失原因**：`advanced_screen` 不支持 `quotes` 表中的 `change_pct` 作为筛选条件。

**建议实现**：
```json
{"type": "quote", "field": "change_pct", "operator": ">", "value": 7}
```
或
```json
{"type": "technical", "indicator": "price_break", "params": {"level": "20d_high"}}
```

---

## 5. Deeper 财务指标（ROE / 毛利率 / 营收增长 / 股息率）

**场景**：ROE > 15%、毛利率 > 40%、营收同比增长 > 20%、股息率 > 3%。

**缺失原因**：`fundamental` 类型仅支持 `market_cap`、`pe`、`pb` 三个字段，无法访问利润表、现金流量表数据。

**建议实现**：
```json
{"type": "fundamental", "field": "roe", "operator": ">", "value": 15}
```
等，打通 `fundamentals` 表全字段。

---

## 6. K 线形态识别（阳线吞噬 / 锤子线 / 十字星）

**场景**：底部出现锤子线、阳线吞噬（Bullish Engulfing）、晨星形态。

**缺失原因**：目前无任何 K 线形态识别指标，只有均线/MACD/RSI/布林带四种。

**建议实现**：
```json
{"type": "technical", "indicator": "candlestick", "params": {"pattern": "hammer", "location": "bottom"}}
```

---

## 7. 资金流向（主力净流入 / 北向资金 / 换手率）

**场景**：主力连续 3 日净流入、北向资金增持、换手率 > 5%（活跃股）。

**缺失原因**：本地数据库 `quotes` 表虽有换手率，但 `advanced_screen` 未开放 `quote` 类型的条件筛选。

**建议实现**：
```json
{"type": "quote", "field": "turnover", "operator": ">", "value": 5}
```
或新增
```json
{"type": "technical", "indicator": "capital_flow", "params": {"flow_type": "main_net_in", "days": 3}}
```

---

## 8. 偏离度 / 均线乖离率

**场景**：股价跌破年线但偏离度 > 15%（超卖反弹），或股价远离 MA20 > 20%（过热回调）。

**缺失原因**：无均线偏离率（BIAS）指标。

**建议实现**：
```json
{"type": "technical", "indicator": "bias", "params": {"ma_period": 20, "operator": ">", "value": 15}}
```

---

## 9. 行业 / 概念板块内技术指标筛选

**场景**：只筛选"人工智能"概念股中的日线 MACD 金叉，或"白酒"行业中周线 RSI < 30 的股票。

**缺失原因**：`scope` 仅支持指数成分股（hs300/zz500/cyb 等）和自定义代码列表，不支持按申万行业或概念主题筛选。

**建议实现**：
```json
{"scope": "industry:白酒"}
```
或
```json
{"scope": "concept:人工智能"}
```

---

## 10. 多指标共振评分排序

**场景**：同时满足 MA 金叉 + MACD 金叉 + RSI 强势 + 放量，按综合得分排序，不是简单 AND 截断。

**缺失原因**：当前多条件是严格 AND 关系，且只有 `score` 排序但不可自定义评分权重。

**建议实现**：增加 `scoring` 配置，如
```json
{"weights": {"ma_cross": 30, "macd_cross": 30, "rsi": 20, "volume_surge": 20}, "min_score": 70}
```

---

## 缺失能力总结

| 维度 | 当前支持 | 缺失 |
|------|---------|------|
| 均线 | 交叉事件 | 多头排列、空头排列、乖离率 |
| MACD | 金叉/死叉 | 即将金叉、背离、柱状体收敛 |
| 量价 | 布林带收缩后放量 | 独立放量/缩量、量比、换手率 |
| K 线 | 无 | 阳线吞噬、锤子线、十字星等形态 |
| 基本面 | PE/PB/市值 | ROE、毛利率、营收增长、股息率 |
| 资金 | 无 | 主力净流入、北向资金、融资融券 |
| 价格行为 | 无 | 涨跌幅、涨停、突破新高、偏离度 |
| 范围 | 指数/全市场/自定义 | 行业板块、概念主题 |

> 如果这些功能补齐，`advanced_screen` 将是一个真正强大的多因子组合选股引擎。
