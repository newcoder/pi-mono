# @mariozechner/pi-trading-agent

LLM-assisted investment analysis agent for A-share (Chinese stock) markets. Built on the `pi` agent infrastructure (`pi-agent-core`, `pi-ai`, `pi-tui`).

**Positioning**: Analysis-only. No trade execution, no broker integration, no portfolio P&L tracking.

## Features

- **Market Data**: Real-time quotes, historical K-lines (daily/weekly/monthly), fundamentals (39 financial fields), macro data
- **Stock Screening**: Fundamental screening (PE/PB/ROE) and natural language technical + fundamental combo screening
- **News Analysis**: Individual stock news and market-wide macro news with sentiment classification
- **Backtesting**: 4 built-in strategies (MA/MACD/RSI/Bollinger) with equity curves and risk metrics
- **Sector & Concept Tracking**: Sector rotation, concept stocks, industry classification (SW/ZJW/JQ)
- **Stock Pools**: Named sets of stocks for batch analysis and tracking
- **Scheduled Routines**: Pre-market scan and post-market review via `node-schedule`
- **Data Sync Tools**: Incremental sync of K-lines, fundamentals, and news to local SQLite

## Quick Start

### Prerequisites

- Node.js >= 20
- Python 3 with `akshare`, `jqdatasdk` (for data sync scripts)
- A configured LLM provider (OpenAI, Anthropic, DeepSeek, etc.)

### Installation

```bash
npm install -g @mariozechner/pi-trading-agent
```

Or run from the monorepo:

```bash
cd packages/trading-agent
npm run build
node dist/main.js
```

### Configuration

Add models to `~/.pi/agent/models.json` (shared with pi coding agent).

Create `~/.trading-agent/settings.json` for watchlists and preferences:

```json
{
  "watchlist": [
    { "code": "000001", "name": "平安银行" },
    { "code": "600519", "name": "贵州茅台" }
  ],
  "timezone": "Asia/Shanghai"
}
```

### Usage

```bash
trading-agent           # Start interactive TUI
trading-agent --repl    # Start REPL mode
```

### Data Sync Commands

```bash
# Sync all daily klines (incremental)
trading-agent --sync-all-kline

# Sync weekly klines
trading-agent --sync-all-kline --period weekly

# Sync fundamentals
trading-agent --sync-all-fundamentals

# Sync quotes
trading-agent --sync-quotes

# Database stats
trading-agent --db-stats
```

## Available Tools

### Market Data

| Tool | Description |
|------|-------------|
| `get_quote` | Real-time price, PE, market cap, 52w range |
| `get_kline` | Historical OHLCV (daily/weekly/monthly) |
| `get_fundamentals` | 3-statement financials (39 fields) |
| `get_macro` | US indices, A50, FX rates |

### Screening & Analysis

| Tool | Description |
|------|-------------|
| `screen_stocks` | Fundamental screening (PE/PB/ROE/market cap) |
| `advanced_screen` | Natural language technical + fundamental screening |
| `compare_stocks` | 2-5 stock side-by-side comparison |
| `get_sector_rotation` | Sector performance ranking |
| `get_concept_stocks` | Concept/theme stock constituents |
| `list_concepts` | List all concept categories |
| `list_industries` | List industry classifications |
| `get_industry_stocks` | Get stocks by industry |
| `get_stock_industries` | Get industries for a stock |

### News

| Tool | Description |
|------|-------------|
| `get_stock_news` | Recent news for a specific stock with sentiment |
| `get_market_news` | Market-wide macro news with classification |
| `screen_by_news` | Screen stocks by news events |

### Data Sync

| Tool | Description |
|------|-------------|
| `sync_kline` | Sync all A-share K-lines (incremental) |
| `sync_fundamentals` | Sync all A-share fundamentals (incremental) |
| `sync_news` | Sync market news and watchlist stock news |

### Backtest & Portfolio

| Tool | Description |
|------|-------------|
| `backtest_strategy` | Backtest MA/MACD/RSI/Bollinger strategies |
| `manage_stock_pool` | Create/manage named stock sets |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design docs.

## Data Layer

Local SQLite database at `~/.trading-agent/data/market.db`:

| Table | Description |
|-------|-------------|
| `stocks` | A-share master list (~5,500) |
| `klines` | OHLCV with adjustment factors (~4.3M rows) |
| `quotes` | Real-time snapshots |
| `fundamentals` | 39-field financial statements (~62K rows) |
| `sectors` | Sector performance |
| `concept_stocks` | Concept-to-stock mappings |
| `macro` | US indices, A50, FX |
| `stock_pools` | User-defined stock sets |
| `market_news` | Classified market macro news |

## License

MIT
