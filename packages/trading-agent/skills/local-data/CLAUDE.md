# CLAUDE.md

This file provides guidance to Claude Code when working in the `local-data` skill.

## Project Overview

`local-data` is a Claude Code skill that owns the local SQLite data infrastructure for the A-share trading agent. It lives at `packages/trading-agent/skills/local-data/`.

Its responsibilities are strictly limited to:

1. **Data ingestion** — downloading quotes, klines, fundamentals, industries, concepts, news, etc. into the local database.
2. **Data storage** — schema creation, table management, and the canonical DB path.
3. **Derived metrics** — computing pre-computed indicator tables from raw data.
4. **Data access** — providing a unified read interface (`data_fetcher.py`) that other skills consume.
5. **Validation** — checking data completeness and quality after sync.

This skill does **not** perform investment analysis, valuation, or strategy research. Those tasks belong to `a-share-analysis` and other analysis skills.

## Common Commands

All scripts are executed directly with Python. There is no build step.

### Install dependencies

```bash
pip install akshare pandas numpy mootdx requests beautifulsoup4
```

### Daily sync

```bash
python scripts/daily_sync.py
```

### Fetch data from local DB

```bash
python scripts/data_fetcher.py --code 600519 --data-type all --years 5 --output tmp/600519.json
```

### Validate data

```bash
python scripts/sync_validator.py
```

### Sync one table only

```bash
python scripts/sync_industries.py
python scripts/sync_concepts.py
python scripts/news_sync.py --days 7
python scripts/market_news_sync.py --days 3
```

## Architecture

### Directory layout

```
packages/trading-agent/skills/local-data/
├── SKILL.md                  # Skill manifest
├── CLAUDE.md                 # This file
├── scripts/                  # Executable Python scripts
└── local_data/               # Shared Python package
    ├── __init__.py
    ├── db.py                 # Canonical DB path and get_db() helper
    └── market.py             # Canonical A-share market judgment
```

### Shared database utilities

All scripts that touch the database should import from `local_data.db`:

```python
from local_data.db import get_db, get_db_path, db_exists
```

Avoid duplicating the hard-coded `~/.trading-agent/data/market.db` path in new scripts.

### Market judgment

All scripts must use `local_data.market` for market-code inference:

```python
from local_data.market import market_from_code, market_label, market_prefix
```

Do not inline `code.startswith(...)` market checks.

### Data read interface

`scripts/data_fetcher.py` is the canonical consumer-facing API. It reads from the local DB first and falls back to remote APIs (Eastmoney / akshare) only when local data is missing. Every JSON result includes a `_source` field.

### Data write interface

`scripts/daily_sync.py` is the main orchestrator. It creates tables, runs each sync phase, computes derived indicators, and runs validation. Individual sync scripts (e.g. `sync_industries.py`, `news_sync.py`) can also be run standalone for targeted updates.

## Coding Guidelines

1. **Keep analysis out** — Do not add valuation, screening, or strategy logic here. Redirect those requests to `a-share-analysis`.
2. **Use `local_data.db`** — Centralise database path and connection helpers; do not hard-code `market.db` paths in new scripts.
3. **Prefer idempotent writes** — Sync scripts should be safe to re-run on the same day without corrupting data.
4. **Minimal dependencies** — Do not introduce new Python packages unless required for a data source.
5. **Match existing style** — Follow the conventions of the script you are editing.

## Notes

- There is no formal test suite. Validate changes by running `data_fetcher.py` and `sync_validator.py` against known data (e.g. code `600519`).
- The database file may be large and locked by other processes. Use the busy timeout configured in `local_data.db.get_db()`.
- When copying scripts from `a-share-analysis`, update imports to use `local_data.db` and adjust relative import paths.
