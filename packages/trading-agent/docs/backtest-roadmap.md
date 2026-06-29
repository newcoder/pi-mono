# backtest_strategy 现状与优化路线图

> 目标：把当前能跑通的回测工具，演进成**准确、快速、信号丰富、极易扩展**的 A 股回测框架。

---

## 1. 当前能力总结

### 1.1 入口与配置

- 入口：`packages/trading-agent/src/backtest/engine.ts` 中的 `runPoolBacktest()`。
- 配置接口：`PoolBacktestConfig`（`src/backtest/types.ts`）。
- 支持标的类型：
  - 单只股票 `code`
  - 静态股池 `pool_id`
  - 动态股池 `dynamic_pool_id`

### 1.2 信号与策略

`buyStrategies` / `sellStrategies` 可任意组合，任一条件触发即产生交易信号。

当前已实现的策略（`src/backtest/strategies.ts`）：

| 类别 | 策略 |
|---|---|
| 趋势 | `ma_cross`、`macd_cross`、`supertrend`、`breakout` |
| 反转/超买超卖 | `rsi_reversal`、`rsi_overbought_sell` |
| 波动/通道 | `bollinger_breakout`、`volume_contraction` |
| K 线形态 | `hammer`、`bullish_engulf`、`morning_star`、`three_soldiers`、`shooting_star`、`bearish_engulf`、`evening_star`、`three_crows` |
| 综合 | `tech_composite` |
| 辅助/测试 | `time_exit`、`always_buy` |

### 1.3 排序因子

股票池排名因子（`engine.ts` 中的 `computeRankScore`）：

`momentum`、`value`、`turnover`、`technical`、`low_volatility`、`signal_recency`、`ma_alignment`、`weekly_ma_alignment`、`random`。

### 1.4 仓位与风控

- 满仓 / 等权 / 加仓模式（`fullPosition`、`fullPositionMode`）
- `maxPositions`、`maxPositionWeight`
- `maxHoldingDays`
- `rebalanceThreshold`：持仓权重偏离阈值才调仓
- `rebalanceFrequency`：每隔 N 个交易日才重新排名
- `rebalanceFullPortfolio`：调仓日是否强制清仓重建

### 1.5 交易细节

- 次日开盘执行（当前 K 线收盘信号 → 下一根 K 线开盘买入）
- 涨跌停过滤：买入时若下一日涨停、卖出时若下一日跌停，则跳过
- 滑点 `slippage`、佣金 `commission`
- 100 股整数手 `minLot`
- 最小成交金额 `minTradeAmount`

### 1.6 输出

- 收益曲线、关键指标（`metrics.ts`）
- 与基准对比（`benchmark.ts`）
- HTML 报告（`report.ts`）
- 保存最终持仓为股池
- 保存回测结果到组合（portfolio）

---

## 2. 主要短板

### 2.1 性能瓶颈

- `runPoolBacktest` 目前是一只一只地调用 `getKlines()` 读取 K 线。
- 大股池（500~1000 只）全历史回测时，IO 开销很大。
- 常用指标（MA、MACD、RSI、布林带、Supertrend）每次回测都重新计算，没有缓存。

### 2.2 可扩展性不足

- 新增一种策略：需要改 `types.ts`、`strategies.ts`、tool schema、可能还要加测试。
- 新增一种排序因子：需要改 `engine.ts` 中的 `computeRankScore`。
- 策略和排序因子没有统一的注册机制，核心代码与具体信号紧耦合。

### 2.3 成本模型过于简化

- 只有 `slippage` + `commission` 两个百分比。
- 缺少 A 股真实的印花税、过户费、融资/融券成本。
- 没有按成交额或市场深度的冲击成本模型。

### 2.4 策略表达力有限

- 没有原生的止损 / 止盈 / 移动止损配置。
- 仓位管理只有等权和固定权重，缺少风险平价、ATR 仓位、信号强度仓位等。
- 缺少截面（cross-sectional）信号：比如行业相对强弱、市值分位、波动率分位。
- 多周期组合不自然，目前 ranking 仅基于日线。

### 2.5 缺少验证与工程化能力

- 没有参数敏感性分析。
- 没有 walk-forward / 滚动窗口回测。
- 没有统计显著性检验（如蒙特卡洛置换）。
- 策略和排序因子缺少统一单元测试覆盖。

---

## 3. 下一阶段路线图

### Phase 1：性能与准确性（优先，1~2 周）

目标：**让大股池回测跑得又快又真**。

| 编号 | 任务 | 具体工作 | 关键文件 |
|---|---|---|---|
| P1-1 | 批量 K 线加载 | 把逐只 `getKlines` 改为按 code 列表批量读取，或一次性加载全部 K 线后按 `(code, market, date)` 索引。 | `engine.ts`、`DataStore` |
| P1-2 | 指标缓存层 | 在 `DataStore` 或内存中缓存 MA/MACD/RSI/布林带/Supertrend 等指标，key 为 `(code, market, period, params)`。 | `src/backtest/indicator-cache.ts` |
| P1-3 | 真实成本模型 | 增加 `taxRate`（印花税）、`transferFee`（过户费）、`impactModel`（可选冲击成本函数）。默认仍保持现有百分比，但可配置。 | `types.ts`、`engine.ts` |
| P1-4 | 成交规则完善 | 增加停牌、ST、一字板、熔断等过滤，并在报告中输出被过滤交易的比例。 | `engine.ts`、`metrics.ts` |

### Phase 2：可扩展架构（2~3 周）

目标：**加策略、加因子像加文件一样简单**。

| 编号 | 任务 | 具体工作 | 关键文件 |
|---|---|---|---|
| P2-1 | 策略注册表 | 把 `strategies.ts` 拆成 `StrategyRegistry`，每个策略一个文件 `src/backtest/strategies/<name>.ts`，实现 `generateSignals(klines, params): Signal[]` 接口。新增策略只需新建文件并注册。 | `src/backtest/strategy-registry.ts`、`src/backtest/strategies/*.ts` |
| P2-2 | 排序因子注册表 | 类似地把 `computeRankScore` 拆成 `RankerRegistry`，每个 rank_by 一个文件 `src/backtest/rankers/<name>.ts`。 | `src/backtest/ranker-registry.ts`、`src/backtest/rankers/*.ts` |
| P2-3 | 配置化组合信号 | 支持 `strategy: "composite"`，通过 JSON/YAML 配置组合子条件（如 `ma_cross AND volume > ma20`），无需写代码。 | `src/backtest/composite-strategy.ts` |
| P2-4 | 插件加载 | 支持从 `.pi/extensions` 或项目外目录按约定加载策略/排序因子，不修改核心代码。 | `src/backtest/plugin-loader.ts` |

### Phase 3：策略能力升级（2~3 周）

目标：**支持更多成熟、专业的策略范式**。

| 编号 | 任务 | 具体工作 |
|---|---|---|
| P3-1 | 止损止盈模块 | 增加 `stopLossPct`、`takeProfitPct`、`trailingStopPct`，作为通用风控层，独立于具体策略。 |
| P3-2 | 仓位管理 | 支持 `positionSizing` 配置：`equal_weight`、`risk_parity`、`volatility_targeting`、`signal_strength`、`atr_based`。 |
| P3-3 | 截面信号 | 支持基于全市场截面的排序/筛选：行业相对强度、市值分位、波动率分位、流动性分位。 |
| P3-4 | 事件与基本面信号 | 接入财报、分红、解禁、大宗交易等事件表，支持事件驱动买卖。 |
| P3-5 | 多周期支持 | 统一处理日线/周线/月线信号，支持“日线买入、周线过滤”的多周期策略。 |

### Phase 4：验证与工程化（持续）

目标：**让回测结果可信、可复现、可维护**。

| 编号 | 任务 | 具体工作 |
|---|---|---|
| P4-1 | 参数优化 | 实现网格搜索 / 随机搜索，输出参数敏感性热图。 |
| P4-2 | 滚动回测 | 实现 walk-forward 回测：滚动训练窗口 + 样本外验证窗口。 |
| P4-3 | 统计检验 | 对比基准计算 alpha、beta、信息比率、Calmar；增加蒙特卡洛置换检验。 |
| P4-4 | 双模式运行 | `fast` 模式：向量化、简化成本，用于快速筛查；`accurate` 模式：事件驱动、完整成本，用于最终验证。 |
| P4-5 | 测试与文档 | 为每个策略/排序因子增加单元测试；编写 `BACKTEST.md` 说明引擎行为、成本假设、扩展方式。 |

---

## 4. 优先级建议

1. **Phase 1 先做**：性能是最大瓶颈，成本模型不完善会直接影响策略结论。
2. **Phase 2 紧接着做**：解耦后加策略/因子才快，后续工作才不会反复改动核心引擎。
3. **Phase 3、4 按实际需求推进**：止损止盈、仓位管理、walk-forward 可以分批实现。

---

## 5. 验收标准

- 500 只成分股、5 年日线回测耗时 < 10 秒（当前目标，后续可再优化）。
- 新增一个策略只需新增 1 个文件 + 1 行注册，无需改 `types.ts`/`tool schema`。
- 新增一个排序因子只需新增 1 个文件 + 1 行注册。
- 回测报告能清晰展示：总收益、年化收益、夏普、最大回撤、胜率、盈亏比、平均持仓天数、换手率、被过滤交易比例、与基准对比。
- 所有策略和排序因子都有单元测试覆盖。
