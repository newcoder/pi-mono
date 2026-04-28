# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Claude Code skill (`china-stock-analysis`) for analyzing China A-shares (A股) using value investing principles. It is implemented as a set of Python CLI scripts under `scripts/` with no package manager or test suite. The primary documentation is in `SKILL.md`.

## Common Commands

All development is done via direct Python script execution. There is no build step, test runner, or package manager.

### Install Dependencies

```bash
pip install akshare pandas numpy jqdatasdk
```

Verify `akshare` is installed before running analysis:

```bash
python -c "import akshare; print(akshare.__version__)"
```

### Fetch Stock Data

```bash
# Basic info for a single stock
python scripts/data_fetcher.py --code 600519 --data-type basic --output tmp/600519_basic.json

# Full analysis dataset (excludes holder data for speed)
python scripts/data_fetcher.py --code 600519 --data-type all --years 5 --output tmp/600519.json

# Complete dataset including holder/dividend data
python scripts/data_fetcher.py --code 600519 --data-type complete --years 5 --output tmp/600519_full.json

# Multiple stocks
python scripts/data_fetcher.py --codes "600519,000858" --data-type basic --output tmp/multi.json

# List index constituents
python scripts/data_fetcher.py --scope hs300 --output tmp/hs300.json
```

### Analyze a Stock

```bash
python scripts/financial_analyzer.py --input tmp/600519.json --level standard --output tmp/analysis.json
```

Levels: `summary`, `standard`, `deep`.

### Run Valuation

```bash
python scripts/valuation_calculator.py --input tmp/600519.json --methods all --discount-rate 10 --terminal-growth 3 --margin-of-safety 30 --output tmp/valuation.json
```

Methods: `dcf`, `ddm`, `relative`, `all`.

### Screen Stocks

```bash
python scripts/stock_screener.py --scope hs300 --pe-max 15 --roe-min 15 --output tmp/screening.json
```

Scopes: `all`, `hs300`, `zz500`, `zz1000`, `cyb`, `kcb`, `custom:600519,000858`.

### Industry Comparison

```bash
# Fetch comparison data, then analyze
python scripts/data_fetcher.py --codes "600519,000858" --data-type comparison --output tmp/industry.json
python scripts/financial_analyzer.py --input tmp/industry.json --mode comparison --output tmp/comparison.json
```

## High-Level Architecture

### Hybrid Data Source Design

The skill uses a hybrid data architecture implemented in `scripts/data_fetcher.py`:

| Data Type | Primary Source | Fallback |
|-----------|----------------|----------|
| Real-time quotes / K-line | `stock-data` skill (JoinQuant `jqdatasdk`) | `akshare` |
| Basic info (industry, PB, listing date) | `akshare` | `stock-data` |
| Financial statements & indicators | `akshare` | — |
| Holder & dividend data | `akshare` | — |

`scripts/data_fetcher.py` dynamically adds `../../stock-data/scripts` to `sys.path` to import `jq_data.py`. If the `stock-data` skill is unavailable, it gracefully falls back to `akshare` only. Every JSON result includes a `_source` field indicating where that data came from.

### Four-Module Pipeline

1. **`scripts/data_fetcher.py`** — Data acquisition layer. Fetches and merges hybrid data, implements session-level in-memory caching plus same-day disk caching under `scripts/.cache/`.
2. **`scripts/financial_analyzer.py`** — Analysis engine. Runs profitability, solvency, growth, and DuPont analysis. Also detects financial anomalies (receivables, cash flow, inventory, gross margin).
3. **`scripts/valuation_calculator.py`** — Valuation layer. Computes DCF, DDM, and relative valuation. Calculates margin-of-safety prices.
4. **`scripts/stock_screener.py`** — Screening layer. Pulls live market data for an index or the full A-share market and filters by PE, PB, ROE, debt ratio, dividend yield, and market cap.

### Caching Strategy

`data_fetcher.py` maintains two tiers of cache:
- **Session memory cache** (`_SESSION_CACHE`): avoids redundant network calls within the same Python process.
- **Disk cache** (`scripts/.cache/{code}_{data_type}_{YYYYMMDD}.json`): persists for the calendar day.

Use `--no-cache` to force a fresh fetch.

### Key Supporting Scripts

- **`scripts/jq_data.py`** — Thin wrapper around `jqdatasdk` for authenticating, normalizing codes, and fetching price/K-line data. Used only when the `stock-data` skill is present.
- **`scripts/get_quote.py` / `get_kline.py` / `get_fundamentals.py`** — Stand-alone helper scripts that directly call `akshare` or `jq_data` for quick one-off lookups.
- **`scripts/analyze_002352.py`** — Example ad-hoc analysis script that merges manually fetched JSON files and performs technical analysis (MA, RSI) with `pandas`.

### Report Generation

`templates/analysis_framework.md` provides a systematic 10-module analysis framework (basic info, industry/competition, fundamentals, institutional views, consensus expectations, news sentiment, capital flow, technical analysis, bull/bear assessment, appendix). Reports are generated by selectively applying relevant modules based on analysis depth (summary/standard/deep) and filling in data from JSON analysis results.

### A-Share Specific Logic

- Index scope mapping is hardcoded in `stock_screener.py` (`INDEX_CODE_MAP`) for `hs300` (000300), `zz500` (000905), `zz1000` (000852), `cyb` (399006), and `kcb` (000688).
- Financial anomaly detection thresholds (e.g., receivables growth > revenue growth × 1.5) are embedded in `financial_analyzer.py`.
- Policy sensitivity hints (real estate, new energy, pharma, internet) are documented in `SKILL.md` and should be referenced when generating qualitative report sections.

## Coding Guidelines

When writing or modifying code in this repository, follow these guidelines:

1. **Think Before Coding** — State assumptions explicitly before coding. If uncertain, ask. If multiple interpretations exist, present them rather than picking silently. If a simpler approach exists, say so and push back when warranted.

2. **Simplicity First** — Write the minimum code that solves the problem. No features beyond what was asked. No abstractions for single-use code. No unrequested flexibility or configurability. No error handling for impossible scenarios.

3. **Surgical Changes** — Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken. Match existing style, even if you'd do it differently. Clean up only imports/variables/functions that your changes made unused.

4. **Goal-Driven Execution** — Transform vague tasks into verifiable goals. For multi-step tasks, state a brief plan with verification steps. Loop until the success criteria are met.

## Notes

- There is **no test suite**. Validate changes by running the scripts against a known stock code (e.g., `600519`) and inspecting the JSON output.
- There is **no package manifest** (`requirements.txt`, `pyproject.toml`, etc.). Dependencies are `akshare`, `pandas`, `numpy`, and optionally `jqdatasdk`.
- `jq_data.py` contains hardcoded JoinQuant credentials inside an `@assert_auth` decorator. Do not modify or expose them.
- Holder data (`--data-type holder` or `complete`) can be extremely slow due to paginated `akshare` requests. Prefer `--data-type all` (which excludes holders) for routine analysis.
