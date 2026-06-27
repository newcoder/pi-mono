# A-Share 本地数据同步与使用指南

本文说明 `pi-trading-agent` 如何利用本地 SQLite 数据库 `~/.trading-agent/data/market.db` 缓存 A 股数据，以及各类数据应该何时同步、如何查询、有哪些使用原则。

---

## 1. 数据库位置

```
~/.trading-agent/data/market.db
```

所有数据都集中在这一个 SQLite 文件里，便于 SQL 查询和跨工具复用。

---

## 2. 数据表概览

| 表名 | 内容 | 更新策略 | 建议同步频率 |
|------|------|----------|--------------|
| `stocks` | A 股全市场股票列表（代码、名称、行业等） | 全量 | 每天一次 |
| `quotes` | 个股最新行情（价格、涨跌幅、市值等） | 全量 | 盘中可多次，收盘后一次 |
| `klines` | 个股日/周/月 K 线 | 增量 | 每天一次 |
| `fundamentals` | 利润表、资产负债表、现金流量表 | 增量 | 每周或财报季后 |
| `industries` / `industry_klines` / `industry_quotes` | 行业指数与行情 | 增量/全量 | 每天一次 |
| `concepts` | 概念板块成分股 | 按需 | 分析某概念时 |
| `stock_news` | 个股新闻（标题、正文摘要、来源、分类、情感） | 增量 | 每天一次 |
| `market_news` | 市场宏观新闻（政策、行业、国际） | 增量 | 每天一次 |
| `hot_stocks` | 同花顺当日热点强势股（含题材 reason tags） | 当日快照 | 每天一次 |
| `macros` | 宏观经济指标 | 增量 | 每月 |

---

## 3. 同步方式

### 3.1 命令行全量同步

```bash
cd packages/trading-agent/skills/a-share-analysis/scripts
python daily_sync.py
```

默认会按依赖顺序跑完所有阶段：

```
stocks → quotes → klines → fundamentals → indicators → industry_momentum → size_ic
→ industries → concepts → hot_stocks → stock_news → market_news → validation
```

只跑某几个阶段：

```bash
python daily_sync.py --phase stocks,quotes,klines,hot_stocks
```

跳过财务数据（最慢）：

```bash
python daily_sync.py --skip-fundamentals
```

### 3.2 历史强势股某日同步

```bash
python daily_sync.py --phase hot_stocks --date 2026-06-25
```

**原则**：`hot_stocks` 只做当日快照，历史上某天能取到就写，取不到或没有数据就留空，不要跨日期填充。

### 3.3 TypeScript 层工具（运行时 / 交互模式）

| 工具 | 说明 | 示例参数 |
|------|------|----------|
| `sync_kline` | 同步全市场 K 线 | `period=daily/weekly/monthly` |
| `sync_fundamentals` | 同步财务数据 | `historyLimit=12`, `force=true`, `sinceYear=2019` |
| `sync_news` | 同步市场+个股新闻 | `scope=market/watchlist/all`, `sources=eastmoney,cls` |
| `sync_hot_stocks` | 同步强势股 | `date=2026-06-27` |

例如：

```text
/sync_news scope=watchlist sources=eastmoney,cls limit=20
/sync_hot_stocks
```

---

## 4. 核心使用原则

### 4.1 优先使用本地数据

- 分析行情、回测、选股时，先查 `klines`、`quotes`、`fundamentals`。
- 需要热点题材时，查 `hot_stocks` 表的 `reason` 字段。
- 需要事件驱动时，查 `stock_news` / `market_news` 的 `event_type`、`sentiment`。

### 4.2 增量同步，不要重复全量拉取

- `klines`、`fundamentals` 默认是增量：只补本地缺失的日期。
- 除非数据错乱或需要重跑，否则不要频繁用 `force=true`。

### 4.3 没有数据就留空

- `hot_stocks`、`stock_news`、`market_news` 都是“能取到才写”。
- 不要用一个交易日的数据去填充另一个交易日，也不要用均值/插值虚构数据。

### 4.4 同步范围按需求选择

- `scope=market`：只同步宏观新闻，最快。
- `scope=watchlist`：只同步关注列表里的股票新闻，推荐日常使用。
- `scope=all`：全市场 5500 只股票新闻，慢且容易被限流，谨慎使用。

### 4.5 数据 freshness

- `quotes`：盘中 1 分钟级，收盘后 1 小时级。
- `klines`：收盘后稳定，盘中可能有延迟。
- `fundamentals`：财报季后更新，平时变化很小。
- `hot_stocks`：同花顺每日收盘后生成，盘中可能不稳定。

---

## 5. 查询示例

### 5.1 SQL 直接查询

最近 5 天强势股数量：

```sql
SELECT date, COUNT(*) AS cnt
FROM hot_stocks
GROUP BY date
ORDER BY date DESC
LIMIT 5;
```

某只股票最近的新闻：

```sql
SELECT title, content, source_type, sentiment, pub_time
FROM stock_news
WHERE code = '600519'
ORDER BY pub_time DESC
LIMIT 10;
```

某概念近期出现次数：

```sql
SELECT date, COUNT(*) AS cnt
FROM hot_stocks
WHERE reason LIKE '%PCB%'
GROUP BY date
ORDER BY date DESC
LIMIT 10;
```

### 5.2 TypeScript DataStore API

```typescript
import { getDataStore } from "@mariozechner/pi-trading-agent/data";

const store = getDataStore();

// 某日强势股
const hot = await store.getHotStocks("2026-06-27");

// 个股 K 线
const klines = await store.getKlines("600519", 1, "daily", "2025-01-01", "2026-06-27");

// 最新行情
const quote = await store.getQuote("600519", 1);
```

---

## 6. 故障排查

### 6.1 中文乱码

Windows 下运行 Python 脚本时若中文乱码，确保环境变量：

```bash
set PYTHONIOENCODING=utf-8
```

TypeScript 层的 `runPython` 已经自动设置此变量。

### 6.2 网络/代理超时

若日志出现 `127.0.0.1:1080` 代理超时，检查系统代理环境变量（`HTTP_PROXY` / `HTTPS_PROXY`），必要时临时取消：

```bash
set HTTP_PROXY=
set HTTPS_PROXY=
```

### 6.3 某日期无数据

`hot_stocks` 的某些历史日期可能返回 0 条，这是正常的。脚本会跳过这些日期，不会写入空数据。

### 6.4 表结构升级

`news_sync.py` / `market_news_sync.py` 等脚本启动时会自动 `ALTER TABLE` 新增字段（如 `content`、`source_type`），无需手动删库。

---

## 7. 推荐日常流程

1. 收盘后运行一次 `daily_sync.py`（或调度器自动运行）。
2. 盘中需要实时行情时，用 `sync_kline` / `sync_quotes` 按需刷新。
3. 做题材分析时，先 `sync_hot_stocks` 再查 `hot_stocks.reason`。
4. 做事件分析时，用 `sync_news scope=watchlist` 更新新闻后查 `stock_news` / `market_news`。
5. 回测或深度研究时，直接用 SQL 或 `DataStore` 读取本地数据，避免重复请求网络。
