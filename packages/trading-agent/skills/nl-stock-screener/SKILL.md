---
name: nl-stock-screener
description: Natural language A-share stock screener. Converts user natural language conditions to structured filters, computes technical indicators from local SQLite database (with auto data sync), and outputs matching stocks. Supports MA/MACD/RSI crosses, fundamental filters (market cap, PE, PB), and multi-condition combinations.
---

# NL Stock Screener

自然语言A股股票筛选器。从本地 SQLite 数据库读取数据，自动计算技术指标，支持多条件组合筛选。

## Prerequisites

```bash
pip install pandas numpy
```

依赖: Python 3.9+, pandas, numpy, sqlite3 (内置)

## Database

使用 trading-agent 的本地数据库:
- 路径: `~/.trading-agent/data/market.db`
- 包含表: `stocks`, `klines`, `quotes`, `fundamentals`, `sectors`

## Workflow

### Step 1: Parse Natural Language to Structured Config

当用户提供自然语言筛选条件时，将其解析为如下 JSON 格式:

```json
{
  "scope": "all",
  "conditions": [
    {
      "type": "technical",
      "indicator": "ma_cross",
      "params": {"fast": 5, "slow": 10, "cross_type": "golden"},
      "periods": ["daily", "weekly"]
    },
    {
      "type": "fundamental",
      "field": "market_cap",
      "operator": ">",
      "value": 10000000000
    }
  ],
  "output": "screening_result.json"
}
```

**字段说明:**
- `scope`: 筛选范围 (`all`, `hs300`, `zz500`, `zz1000`, `cyb`, `kcb`, 或 `custom:code1,code2`)
- `conditions`: 筛选条件数组 (AND 关系)
- `output`: 结果输出文件路径 (可选)

**条件类型:**

| type | indicator/field | 说明 |
|------|----------------|------|
| `technical` | `ma_cross` | MA 均线金叉/死叉 |
| `technical` | `macd_cross` | MACD 金叉/死叉 |
| `technical` | `rsi` | RSI 超买/超卖 |
| `fundamental` | `market_cap` | 总市值 (元) |
| `fundamental` | `pe` | 市盈率 |
| `fundamental` | `pb` | 市净率 |
| `quote` | `change_pct` | 涨跌幅 (%) |

**operators:** `>`, `<`, `>=`, `<=`, `==`, `between`

### Step 2: Save Config and Execute

```bash
# Save config to temp file
cat > /tmp/screen_config.json << 'EOF'
{"scope":"all","conditions":[{"type":"technical","indicator":"ma_cross","params":{"fast":5,"slow":10,"cross_type":"golden"},"periods":["daily"]},{"type":"fundamental","field":"market_cap","operator":">=","value":10000000000}],"output":"/tmp/screen_result.json"}
EOF

# Run screener
python {baseDir}/scripts/screen.py --config /tmp/screen_config.json
```

### Step 3: Read Result

```bash
cat /tmp/screen_result.json
```

结果格式:
```json
{
  "screen_time": "2026-04-22T10:00:00",
  "config": {...},
  "total_checked": 5499,
  "matched": 23,
  "results": [
    {
      "code": "600519",
      "name": "贵州茅台",
      "market": 1,
      "signals": {
        "daily_ma_cross": {"value": true, "detail": "MA5 crossed above MA10 on 2026-04-21"},
        "market_cap": {"value": 2100000000000, "detail": "2100亿"}
      },
      "score": 85
    }
  ]
}
```

## Data Auto-Sync

如果本地数据库缺少某股票的 K 线数据，脚本会自动从 JoinQuant 获取并保存到本地数据库。

指标计算结果也会缓存到本地数据库 `indicators` 表中，供后续使用。

## Examples

**日线金叉 + 市值大于100亿:**
```json
{"scope":"all","conditions":[{"type":"technical","indicator":"ma_cross","params":{"fast":5,"slow":10,"cross_type":"golden"},"periods":["daily"]},{"type":"fundamental","field":"market_cap","operator":">=","value":10000000000}]}
```

**周线MACD金叉 + PE < 20:**
```json
{"scope":"hs300","conditions":[{"type":"technical","indicator":"macd_cross","params":{"cross_type":"golden"},"periods":["weekly"]},{"type":"fundamental","field":"pe","operator":"<","value":20}]}
```

**RSI超卖 (RSI < 30) +  PB < 2:**
```json
{"scope":"all","conditions":[{"type":"technical","indicator":"rsi","params":{"period":14,"operator":"<","value":30},"periods":["daily"]},{"type":"fundamental","field":"pb","operator":"<","value":2}]}
```

**沪深300中，日线和周线都金叉:**
```json
{"scope":"hs300","conditions":[{"type":"technical","indicator":"ma_cross","params":{"fast":5,"slow":10,"cross_type":"golden"},"periods":["daily","weekly"]}]}
```
