---
name: stock-radar
description: A股个股机会风险雷达 V3（事件驱动），扫描有事件/新闻动静的股票，分析利好利空，输出机会榜和风险榜。支持全市场或指定指数成分股扫描。
version: 3.0.0
tools:
  - scan_stock_radar
---

# 个股机会风险雷达 V3

## 技能概述

**事件驱动架构**：不再遍历全市场5000+只股票，而是从多个渠道（iwencai事件查询 + 财联社/东财新闻）找出**"最近有动静"的股票**，只分析这些有事件/公告/新闻的个股，大幅提高效率。

### 覆盖事件类型（10类 iwencai 查询）

| 事件类型 | 数据来源 | 评分 |
|----------|----------|------|
| 高管增持/减持 | iwencai query2data | +3 / -3 |
| 大股东增持/减持 | iwencai query2data | +2 / -3 |
| 减持计划 | iwencai query2data | -2 |
| 业绩预告（预增/预亏） | iwencai query2data | +3 / -3 |
| 限售解禁 | iwencai query2data | -2 |
| 定向增发 | iwencai query2data | -1 |
| 重大合同/中标 | iwencai query2data | +2 |
| 回购 | iwencai query2data | +2 |
| 股权激励 | iwencai query2data | +1 |
| 机构调研 | iwencai query2data | +1 |
| 全市场新闻（利好/利空） | 财联社 + 东财全球资讯 | 按情感分析打分 |
| 个股新闻补充 | 东财个股新闻（TOP股） | 按情感分析打分 |

### 扫描范围

- `all` — 全市场（默认）
- `zz1000` — 中证1000成分股
- `zz500` — 中证500成分股
- `hs300` — 沪深300成分股
- `cyb` — 创业板成分股
- `kcb` — 科创板成分股

### 评分规则

- **事件评分**：基于事件类型固定分值（如高管增持+3，限售解禁-2）
- **新闻评分**：基于情感词典匹配，正负面关键词计数，分值范围 -3 到 +3
- **总分计算**：同一只股票的所有事件和新闻评分累加
- **方向判定**：
  - >= +3：强烈利好
  - +1 ~ +2.9：利好
  - -0.9 ~ +0.9：中性
  - -2.9 ~ -1：利空
  - <= -3：强烈利空

## 数据源策略（混合降低API消耗）

由于全市场股票数量庞大，采用**混合数据源策略**降低iwencai API调用：

1. **iwencai（仅事件数据）**：5次 query2data 调用获取结构化事件
   - 高管增减持、业绩预告、限售解禁、定增、重大合同
2. **免费新闻API（全市场新闻）**：
   - 财联社电报（cls.cn）— 实时全市场快讯，无需鉴权
   - 东财全球资讯（eastmoney）— 7×24财经快讯，无需鉴权
3. **东财个股新闻（补充）**：对TOP排名股票补充个股新闻，JSONP接口免费

## 使用方法

### 命令行

```bash
# 默认扫描（事件驱动，全市场，Markdown输出到控制台）
python scripts/stock_radar.py

# 只扫描中证1000成分股
python scripts/stock_radar.py --universe zz1000

# 增量模式（加载历史缓存+只采当天数据，适合每日定时运行）
python scripts/stock_radar.py --incremental --output radar.md

# 输出前50名，保存为Markdown文件
python scripts/stock_radar.py --top 50 --format md --output radar.md

# 输出JSON格式
python scripts/stock_radar.py --format json --output radar.json

# 对TOP30补充个股新闻
python scripts/stock_radar.py --enrich 30

# 调高敏感度（更低的最小评分门槛）
python scripts/stock_radar.py --min-score 0.3
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--universe` | 扫描范围：all/zz1000/zz500/hs300/cyb/kcb | all |
| `--top` | 机会/风险榜各显示多少只 | 30 |
| `--format` | 输出格式：json / markdown / md | markdown |
| `--output` | 输出文件路径 | stdout |
| `--min-score` | 最小绝对评分过滤 | 0.5 |
| `--enrich` | 对TOP N个股补充东财个股新闻 | 20 |
| `--incremental` | 增量模式：加载历史缓存，只获取当天新数据 | false |
| `--no-cache` | 不保存缓存（增量模式时仍读取已有缓存） | false |
| `--debug` | 调试模式 | false |

### Python API

```python
from scripts.stock_radar import (
    fetch_all_stocks, fetch_executive_changes, fetch_earnings_forecast,
    fetch_unlocks, fetch_private_placement, fetch_major_contracts,
    fetch_cls_telegraph, fetch_eastmoney_global_news,
    extract_stocks_from_news, build_radar, generate_markdown_report
)

stocks = fetch_all_stocks()
articles = fetch_cls_telegraph() + fetch_eastmoney_global_news()
stock_news = extract_stocks_from_news(articles)
events = fetch_executive_changes() + fetch_earnings_forecast() + fetch_unlocks()
radar = build_radar(stocks, events, stock_news)
report = generate_markdown_report(radar, top_n=30)
```

## 输出报告结构

### Markdown报告

1. **报告头**：生成时间、扫描股票数、机会/风险股数
2. **机会榜 TOP N**：表格 + 每只股票的详细事件/新闻拆解
3. **风险榜 TOP N**：表格 + 每只股票的详细事件/新闻拆解

### JSON报告

```json
{
  "meta": {
    "report_time": "2026-05-28 12:00:00",
    "total_stocks_scanned": 5200,
    "opportunity_count": 45,
    "risk_count": 38
  },
  "opportunity_top": [...],
  "risk_top": [...]
}
```

## 增量模式（每日定时运行推荐）

雷达支持**增量更新模式**，适合每日定时运行：

- **缓存机制**：每天 fetched 的数据自动保存到 `scripts/.cache/radar_daily_YYYYMMDD.json`
- **自动加载**：增量模式下自动加载最近14天的缓存数据
- **去重合并**：当天新数据与历史缓存自动去重合并
- **自动清理**：超过14天的旧缓存自动删除

### 增量模式工作流程

```
第1天运行: --incremental
  -> 无历史缓存，全量获取 -> 保存当天缓存

第2天运行: --incremental  
  -> 加载第1天缓存 + 只获取当天新数据 -> 合并去重 -> 保存第2天缓存

第N天运行: --incremental
  -> 加载最近14天缓存 + 只获取当天新数据 -> 合并去重 -> 保存当天缓存
```

### 每日定时任务配置示例

```bash
# crontab - 每日下午3:30运行（收盘后）
30 15 * * * cd /path/to/stock-radar && python scripts/stock_radar.py --incremental --top 30 --output reports/radar_$(date +\%Y\%m\%d).md
```

## 文件结构

```
stock-radar/
├── SKILL.md                          # 技能定义
├── radar_test.md                     # 示例输出报告
└── scripts/
    ├── stock_radar.py                # 主脚本 (~750行)
    └── .cache/
        └── radar_daily_YYYYMMDD.json # 每日数据缓存
```

## 依赖

- Python 3.8+
- `requests`（HTTP请求）
- `akshare`（获取A股全市场列表）
- iwencai API Key（仅事件数据需要，新闻数据免费）

## 注意事项

1. **iwencai API配额**：脚本仅调用5次query2data获取事件数据，远低于18次新闻查询，大幅降低API消耗
2. **免费新闻覆盖**：财联社+东财全球资讯覆盖全市场主要新闻，但个股粒度不如iwencai精准
3. **个股新闻补充**：对TOP排名股票会额外调用东财个股新闻，增加覆盖度但耗时稍长
4. **情感分析**：基于规则词典，可能存在误判，建议结合人工判断
5. **时效性**：新闻和事件数据具有时效性，建议每日运行
6. **股票列表获取**：优先使用akshare获取全市场列表，若失败则回退到东财API，再失败则使用内置136只龙头股列表（仅用于测试/降级）
7. **增量缓存**：缓存文件保存在 `scripts/.cache/` 目录，14天自动清理

## 更新日志

### v1.0.0
- 初始版本
- 混合数据源策略（iwencai事件 + 免费新闻API）
- 机会/风险双榜排名
- 个股新闻补充机制
- 增量更新模式（缓存+每日增量）
- 多层级股票列表获取回退（akshare -> 东财API -> 内置列表）
- 新闻按股票名称匹配（财联社使用股票名而非代码）
