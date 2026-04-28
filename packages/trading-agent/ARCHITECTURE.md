# Trading Agent — Investment Analysis Architecture

> **Positioning**: LLM-assisted Investment Analyser  
> **Focus**: Market analysis, sentiment, sector/concept tracking, stock/futures screening, factor analysis, strategy backtesting & tracking  
> **Non-goal**: Real-time trade execution, broker integration, portfolio P&L tracking, simulated trading  
> **Date**: 2026-04-27 (Revised)

---

## 1. Design Philosophy

### 1.1 Relationship to Coding Agent

The Trading Agent and the Coding Agent are **siblings** sharing the same `pi` infrastructure (`pi-agent-core`, `pi-ai`, `pi-tui`).

| Dimension | Coding Agent | Trading Agent (Revised) |
|-----------|-------------|------------------------|
| **Core interaction** | Human + agent collaborative coding | Human + agent collaborative investment analysis |
| **Session model** | Long-running, multi-turn, file-centric | Long-running, multi-turn, analysis-centric |
| **Context pressure** | Large files + tool outputs | Multi-day market data + analysis conclusions |
| **Compaction** | Code-block summarization | Daily analysis summary (日复盘) |
| **Scheduled tasks** | None | Pre-market scan, post-market review, weekly summary |
| **Primary UI** | Chat + file tree + editor | Chat + report viewer + chart (optional) |
| **Tool domain** | bash, read, edit, write | market-data, screening, backtest, factor, sentiment |

### 1.2 Core Principles

1. **Analysis first, execution never**. We do not execute trades, manage positions, or track P&L. We analyse, screen, backtest, and track strategies.
2. **Local-first data**. All market data lives in local SQLite. External APIs are only for sync.
3. **Natural language interface**. Users describe strategies and screens in plain language; the agent translates to tool calls.
4. **Event-driven**. All subsystems communicate via the session event bus.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Interface Layer                            │
│  ┌─────────────────────────────────┐  ┌─────────────────────────────────────┐│
│  │ ReportPanel                     │  │ Chat / Analysis Panel               ││
│  │ (markdown + tables + charts)    │  │ (streaming, collapsible tool cards) ││
│  └─────────────────────────────────┘  └─────────────────────────────────────┘│
│                                    ▲                                        │
│                                    │ render / events                         │
│                         ┌──────────┴──────────┐                             │
│                         │   TradingApp (TUI)  │                             │
│                         │   (pi-tui Component)│                             │
│                         └──────────┬──────────┘                             │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │
┌────────────────────────────────────┼────────────────────────────────────────┐
│                         Core Layer │                                        │
│                                    ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      TradingSession (~120 lines)  [IMPLEMENTED]         │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐ │ │
│  │  │   Agent     │  │   Memory    │  │  Scheduler  │  │MarketSnapshot │ │ │
│  │  │ (pi-agent-  │  │  (Session-  │  │  (node-     │  │  (market      │ │ │
│  │  │   core)     │  │   Memory)   │  │  schedule)  │  │  sentiment)   │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └───────────────┘ │ │
│  │         ▲                                                          │    │ │
│  │         │ subscribe / prompt                                       │    │ │
│  │  ┌──────┴──────┐  ┌─────────────┐  ┌──────────────────────────┐  │    │ │
│  │  │ Event Bus   │  │ TradingMode │  │   System Prompt Builder  │  │    │ │
│  │  │ (EventEmitter│  │ (analysis   │  │  (skills + context +     │  │    │ │
│  │  │  wrapper)   │  │  phases)    │  │   mode-specific prompts) │  │    │ │
│  │  └─────────────┘  └─────────────┘  └──────────────────────────┘  │    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                                    ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Tool Registry                                   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │ │
│  │  │market-data│ │screening │ │ backtest │ │  factor  │ │  sentiment   │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────────────────┐ │ │
│  │  │  compare │ │  sector  │ │  futures │ │     strategy-tracker        │ │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Persistence Layer                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  Session Logs   │  │  Analysis Memory│  │     Config / Settings       │  │
│  │  (.jsonl)       │  │  (summaries/    │  │  (.trading-agent/           │  │
│  │                 │  │   daily/)       │  │   settings.json)            │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  DataStore (SQLite)  [IMPLEMENTED — 11 tables, 62k+ rows]              │  │
│  │  stocks | klines | quotes | fundamentals | sectors | concepts | macro   │  │
│  │  stock_pools | stock_pool_items | adjust_factors                       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Module Design

### 3.1 TradingSession

**Status**: ✅ Implemented (~120 lines)

The central orchestrator wrapping `Agent` from `pi-agent-core`. It is intentionally thin — analysis logic lives in tools and skills, not in the session itself.

**Responsibilities:**
- Initialize and configure the underlying `Agent`
- Manage the event bus (Agent → UI)
- Route prompts with mode-specific system prompt suffixes
- Track analysis sessions and delegate persistence to `SessionMemory`
- Coordinate with `TaskScheduler` for automated routines

**Intentionally omitted (vs original plan):**
- Broker integration → out of scope
- Simulated trading → out of scope
- Real-time position tracking → out of scope

```ts
export class TradingSession extends EventEmitter {
  private agent: Agent;
  private mode: TradingMode = "research";
  constructor(config: TradingSessionOptions);
  async prompt(input: string, opts?: PromptOptions): Promise<void>;
  setMode(mode: TradingMode): void;
  get messages(): AgentMessage[];
  dispose(): void;
}
```

### 3.2 SessionMemory → AnalysisMemory (Rename Planned)

**Status**: ⚠️ Partially Implemented (basic daily compaction)

Replaces the coding agent's generic compaction with an **analysis-domain memory model** organized by calendar day.

**Why analysis-domain?**
- Analysis context pressure comes from multi-day conversations, screening results, backtest conclusions, and strategy evaluations.
- We need **structured recall** ("what did I screen on Monday?", "how did the MA-cross backtest perform?") rather than generic summarization.

**Memory hierarchy:**

```
AnalysisMemory
├── activeWindow: Message[]           # Current session, full fidelity
├── dailySummaries: AnalysisSummary[] # Compressed daily records
│   └── AnalysisSummary
│       ├── date: string
│       ├── screens: ScreenRecord[]       # Screening conditions + results
│       ├── backtests: BacktestRecord[]   # Strategy + metrics
│       ├── keyConclusions: string[]      # LLM-generated key takeaways
│       └── marketSnapshot: MarketSnapshot # Sentiment, macro, sector heat
└── strategyTracking: StrategyTrackRecord[] # Cross-period strategy performance
```

**Key methods:**
```ts
class AnalysisMemory {
  async loadContext(): Promise<{ summaries: AnalysisSummary[]; recentMessages: Message[] }>;
  async recordScreen(name: string, conditions: unknown, results: unknown): Promise<void>;
  async recordBacktest(config: BacktestConfig, metrics: BacktestMetrics): Promise<void>;
  async dailyCompaction(): Promise<AnalysisSummary>;
  async getRelevantContext(query: string): Promise<string>;
}
```

### 3.3 TaskScheduler

**Status**: ⚠️ Partially Implemented (2/5 routines)

Manages time-based routines using `node-schedule`. All schedules are **market-aware** (A-share calendar by default, US/HK configurable).

**Planned routines:**

| Time | Routine | Status | Description |
|------|---------|--------|-------------|
| 08:00 Mon-Fri | `pre-market` | ✅ Implemented | Overnight data scan, macro snapshot, morning briefing |
| 15:35 Mon-Fri | `post-market` | ✅ Implemented | Daily compaction, market summary, evening report |
| 20:00 Sunday | `weekly-review` | ❌ Planned | Weekly factor performance, strategy tracking update |
| Every 30m 10-15 | `sentiment-scan` | ❌ Planned | Market sentiment snapshot (advance/decline, limit-up/down) |
| 1st of month | `monthly-report` | ❌ Planned | Factor performance, sector rotation review |

```ts
export class TaskScheduler {
  register(routine: Routine): void;
  start(session: TradingSession, memory?: AnalysisMemory): void;
  stop(): void;
  async runNow(name: string, session: TradingSession, memory?: AnalysisMemory): Promise<void>;
}
```

### 3.4 MarketSnapshot (New, replaces MarketContext)

**Status**: ❌ Not Implemented

Injects **market-wide analytical context** (not personal portfolio context) into the system prompt or user prompt.

```ts
export interface MarketSnapshot {
  advanceDecline: { advance: number; decline: number; flat: number };
  limitUpDown: { limitUp: number; limitDown: number };
  northboundFlow: number | null;  // 北向资金净流入
  sectorHeat: SectorRow[];        // Top/bottom 5 sectors
  macroSnapshot: MacroRow;        // VIX, US indices, A50, FX
  sentimentIndex: number;         // Composite 0-100
}

export class MarketSnapshotProvider {
  async getSnapshot(): Promise<MarketSnapshot>;
  async enrichPrompt(input: string, snapshot: MarketSnapshot): Promise<string>;
}
```

Context is injected **selectively** to avoid token bloat:
- Always for pre-market / post-market routines
- On-demand when user asks market-wide questions ("今天市场情绪如何？")
- Cached with 5-minute TTL during market hours

### 3.5 TradingMode (Analysis Phases)

**Status**: ✅ Implemented (4 modes, no layout switching yet)

| Mode | Purpose | System Prompt Bias |
|------|---------|-------------------|
| `research` | Deep single-stock analysis, backtesting, factor exploration | Thorough, evidence-based, cautious |
| `pre-market` | Overnight scan, macro briefing, watchlist check | Concise, risk-aware, macro-focused |
| `market` | Intraday sentiment tracking, sector heat monitoring | Fast, data-driven, alert to anomalies |
| `post-market` | Daily summary, screening review, strategy tracking | Reflective, pattern-seeking, forward-looking |

Mode transitions are manual (`/mode research`) or automatic (scheduler).

---

## 4. Tool Layer

All tools use `AgentTool` from `pi-agent-core` with TypeBox schemas.

### 4.1 Data Tools — ✅ Implemented

| Tool | Source | Purpose |
|------|--------|---------|
| `get_quote` | akshare / local SQLite | Real-time price, PE, market cap, 52w range |
| `get_kline` | JoinQuant / local SQLite | Historical OHLCV (daily/weekly/monthly/minute) |
| `get_fundamentals` | Eastmoney / local SQLite | 3-statement financials (39 fields) |

### 4.2 Analysis Tools — ✅ Implemented

| Tool | Source | Purpose |
|------|--------|---------|
| `screen_stocks` | akshare / local SQLite | Fundamental screening (PE/PB/ROE/market cap) |
| `advanced_screen` | nl-stock-screener (Python/Numba) | Natural language technical + fundamental combo screening |
| `compare_stocks` | Tencent API | 2-5 stock side-by-side comparison |
| `get_sector_rotation` | Eastmoney | Sector performance ranking |
| `get_concept_stocks` | Local SQLite / Eastmoney | Concept/theme stock constituents |
| `list_concepts` | Local SQLite | List all concept categories |
| `list_industries` | Local SQLite | List industry classifications (sw/zjw/jq) |
| `get_industry_stocks` | Local SQLite | Get stocks by industry |
| `get_stock_industries` | Local SQLite | Get industries for a stock |
| `get_macro` | Sina Finance | US indices, A50, FX rates |

### 4.3 Backtest Tool — ✅ Implemented

| Tool | Engine | Purpose |
|------|--------|---------|
| `backtest_strategy` | Local JS engine | 4 strategies (MA/MACD/RSI/Bollinger) with equity curve + metrics |

**Metrics**: Total return, annualized return, Sharpe, max drawdown, win rate, profit factor, avg holding days.

### 4.4 Portfolio Tools — ✅ Implemented (renamed from "portfolio" to "stock pool")

| Tool | Purpose |
|------|---------|
| `manage_stock_pool` | Create/list/show/delete named stock sets for tracking and batch analysis |

**Important**: Stock pools are **analysis sets**, not trading positions. They hold no cost basis, shares, or P&L.

### 4.5 Planned Tools — ❌ Not Implemented

| Tool | Purpose | Priority |
|------|---------|----------|
| `analyze_sentiment` | Market sentiment from advance/decline, limit-up/down, northbound flow | High |
| `analyze_factor` | Single/multi-factor IC/IR analysis, factor correlation | High |
| `track_strategy` | Compare backtest predictions vs subsequent real performance | Medium |
| `analyze_futures` | Futures basis, term structure, open interest analysis | Medium |
| `nl_backtest` | Natural language strategy description → backtest config + execution | Medium |
| `batch_backtest` | Run backtest across a stock pool, aggregate metrics | Medium |

---

## 5. Data Layer

### 5.1 Current Schema — ✅ Implemented (11 tables)

| Table | Rows | Purpose |
|-------|------|---------|
| `stocks` | ~5,500 | A-share master list |
| `klines` | ~4.3M | OHLCV (bfq stored, qfq/hfq applied on read) |
| `quotes` | ~5,500 | Real-time snapshot (cached) |
| `fundamentals` | ~62,332 | 39-field financial statements |
| `sectors` | ~100 | Sector performance snapshots |
| `concept_stocks` | ~10,000 | Concept-to-stock mapping |
| `macro` | ~1/day | US indices, A50, FX |
| `stock_pools` | user data | Named stock sets |
| `stock_pool_items` | user data | Pool constituents |
| `adjust_factors` | ~50K | QFQ/HFQ adjustment factors |

### 5.2 Planned Schema Additions

| Table | Purpose | Priority |
|-------|---------|----------|
| `market_sentiment` | Daily advance/decline, limit-up/down, northbound flow | High |
| `factor_values` | Per-stock factor scores (value, momentum, quality) | High |
| `strategy_tracking` | Backtest config + subsequent real performance | Medium |
| `futures` | Futures contract master list | Medium |
| `futures_klines` | Futures OHLCV | Medium |

---

## 6. UI Architecture

### 6.1 Design Constraints

- Built on `pi-tui` Component interface
- Standard terminals only (no web view)
- Charts use ASCII / Unicode block characters
- All panels optional; layout adapts to terminal size

### 6.2 Component Hierarchy

```
TradingApp (root)  [IMPLEMENTED]
├── HeaderRow  [IMPLEMENTED]
│   └── ModeIndicator (current mode + market status)
├── MainContent (flex direction switches by mode)
│   ├── ResearchLayout  [PLANNED]
│   │   ├── ReportViewer (markdown rendering)  [PLANNED]
│   │   └── ChartPanel (OHLCV + indicators)  [PLANNED]
│   ├── MarketLayout  [PLANNED]
│   │   ├── SentimentBar (market heat snapshot)  [PLANNED]
│   │   └── SectorHeatmap (top/bottom sectors)  [PLANNED]
│   └── ChatPanel (always visible)  [IMPLEMENTED]
└── StatusBar  [IMPLEMENTED]
    ├── Connection status
    ├── Last data update time
    └── Current model
```

### 6.3 Key Components

**ChatPanel** — ✅ Implemented
- Streaming markdown rendering
- Collapsible tool result cards
- `/command` support (`/mode`, `/pre-market`, `/post-market`)

**ReportViewer** — ❌ Planned
- Renders structured analysis reports (screening results, backtest reports, comparison tables)
- Supports ASCII tables and simple bar charts

**ChartPanel** — ❌ Planned (optional)
- Accepts kline data from tool `details`
- Renders ASCII candlesticks or sparklines
- Overlay indicators (MA, volume)

**SentimentBar** — ❌ Planned
- Compact horizontal bar: 上涨/下跌/平盘 + 涨停/跌停 count
- Updates on `tool_end` events from sentiment tools

**StatusBar** — ✅ Implemented
- Mode, model, last sync time

---

## 7. Skills System

Skills follow the Agent Skills specification. Since the trading agent does not use the `read` tool for file editing, `<available_skills>` is manually injected into the system prompt builder.

### 7.1 Planned Skills

| Skill | Trigger | Content | Status |
|-------|---------|---------|--------|
| `value-analysis` | "分析基本面", "估值", "财务" | ROE/PB/PE/DCF workflow | ❌ Planned |
| `technical-analysis` | "技术分析", "K线", "指标" | Pattern recognition, indicator workflow | ❌ Planned |
| `macro-analysis` | "宏观", "利率", "流动性" | Macro factor framework | ❌ Planned |
| `sector-analysis` | "板块", "热点", "轮动" | Sector rotation, concept tracking | ❌ Planned |
| `backtesting-guide` | "回测", "策略测试" | Backtest design, overfitting avoidance | ❌ Planned |
| `factor-analysis` | "因子", "多因子", "IC" | Factor construction, IC/IR analysis | ❌ Planned |
| `sentiment-analysis` | "情绪", "市场热度" | Sentiment indicators, market breadth | ❌ Planned |

### 7.2 Skill Injection

```ts
function buildSystemPrompt(skills: Skill[]): string {
  const skillDescriptions = skills.map(s =>
    `<skill name="${s.name}">\n${s.description}\n</skill>`
  ).join("\n");

  return `
You are a professional quantitative investment analyst.
You help the user analyse markets, screen securities, backtest strategies, and evaluate investment ideas.

## Available Skills
Load a skill by reading its SKILL.md when relevant.
${skillDescriptions}

## Current Mode
{{mode}}

## Market Snapshot
{{marketSnapshot}}

## Analysis Memory
{{recentSummaries}}
`.trim();
}
```

---

## 8. Natural Language Interface

### 8.1 NL Screener — ✅ Implemented

Users describe screening conditions in natural language:
- "日线MA5金叉MA10且PE小于20"
- "布林带收缩后放量突破，市值大于100亿"

The agent parses to `advanced_screen` tool parameters. Auto-tune (`autoTune: true`) adjusts thresholds to hit `targetCount`.

### 8.2 NL Backtest — ❌ Planned

Users describe strategies in natural language:
- "回测茅台，MA5上穿MA10买入，下穿卖出，持有一年"
- "RSI低于30买入，高于70卖出，最大持仓30天"

The agent translates to `backtest_strategy` parameters. If the description is ambiguous, the agent asks clarifying questions before running.

### 8.3 NL Factor Query — ❌ Planned

Users query factor performance:
- "过去三年价值因子在沪深300里的IC是多少？"
- "动量因子和市值因子的相关性"

The agent translates to `analyze_factor` parameters.

---

## 9. Data Flow

### 9.1 User-Driven Analysis Flow

```
User input → TradingApp → TradingSession.prompt()
    → MarketSnapshot.enrichPrompt() (if market-wide query)
    → Agent.prompt() with mode-specific system prompt
        → LLM streams response
        → Tool call (e.g., advanced_screen)
            → Tool executes → result with text + details
            → Agent continues
        → Final analysis
    → TradingSession records analysis conclusion
    → Event: "stream" → ChatPanel renders
    → Event: "tool_end" → ReportViewer/ChatPanel updates
```

### 9.2 Scheduled Analysis Flow

```
Cron trigger → TaskScheduler → TradingSession.runRoutine("pre-market")
    → Set mode: pre-market
    → Sequential tool calls (macro, sector rotation, sentiment)
    → Generate briefing via LLM
    → Event: "routine_end" → ChatPanel displays / log file written
```

### 9.3 Memory Compaction Flow

```
Post-market routine → AnalysisMemory.dailyCompaction()
    → Load today's messages
    → Extract screens, backtests, conclusions
    → Save AnalysisSummary
    → Archive raw messages
    → Event: "memory_compacted" → Status bar update
```

---

## 10. Implementation Roadmap (Revised)

### Phase 1: Foundation ✅ COMPLETE
- [x] Scaffold `packages/trading-agent/` with package.json, tsconfig
- [x] Workspace dependencies on `pi-agent-core`, `pi-tui`, `pi-ai`
- [x] Minimal `TradingSession` (prompt + stream + event bus)
- [x] Console-based hello-world: prompt → LLM response

### Phase 2: Data Infrastructure ✅ COMPLETE
- [x] SQLite DataStore with 11 tables
- [x] Incremental kline sync from JoinQuant
- [x] Full-market fundamentals sync (5,207 stocks, 62,332 rows)
- [x] Quote caching, sector sync, macro sync
- [x] Adjustment factor handling (bfq storage + dynamic qfq/hfq)

### Phase 3: Analysis Tools ⚠️ PARTIAL
- [x] `get_quote`, `get_fundamentals`, `get_kline` (data tools)
- [x] `screen_stocks` (fundamental screening)
- [x] `advanced_screen` (NL technical + fundamental screener with Numba)
- [x] `compare_stocks` (multi-stock comparison)
- [x] `get_sector_rotation`, `get_concept_stocks`, `list_concepts` (sector/concept)
- [x] `list_industries`, `get_industry_stocks`, `get_stock_industries` (industry classification)
- [x] `get_macro` (macro data)
- [x] `backtest_strategy` (4 strategies + metrics + ASCII equity curve)
- [x] `manage_stock_pool` (analysis sets)
- [ ] `analyze_sentiment` — market sentiment (advance/decline, northbound)
- [ ] `analyze_factor` — IC/IR analysis, factor correlation
- [ ] `track_strategy` — backtest vs real performance tracking
- [ ] `analyze_futures` — futures basis, term structure
- [ ] `nl_backtest` — natural language strategy backtest

### Phase 4: Memory & Scheduling ⚠️ PARTIAL
- [x] `SessionMemory` with daily compaction (basic)
- [x] `TaskScheduler` with node-schedule
- [x] Pre-market routine (macro + watchlist briefing)
- [x] Post-market routine (compaction + reflection)
- [ ] `AnalysisMemory` upgrade (screen/backtest tracking, structured recall)
- [ ] `MarketSnapshotProvider` (sentiment, sector heat, macro injection)
- [ ] Weekly review routine
- [ ] Sentiment scan routine

### Phase 5: TUI & Reporting ❌ NOT STARTED
- [x] `TradingApp` root component
- [x] `ChatPanel` (stream rendering)
- [x] `StatusBar` (mode + model + time)
- [ ] `ReportViewer` (structured analysis reports)
- [ ] `ChartPanel` (ASCII candlesticks, optional)
- [ ] `SentimentBar` (market heat snapshot)
- [ ] Mode-specific layouts (research / market)

### Phase 6: Skills & Knowledge Base ❌ NOT STARTED
- [ ] `value-analysis` skill
- [ ] `technical-analysis` skill
- [ ] `macro-analysis` skill
- [ ] `sector-analysis` skill
- [ ] `backtesting-guide` skill
- [ ] `factor-analysis` skill
- [ ] `sentiment-analysis` skill

### Phase 7: Polish & Distribution ❌ NOT STARTED
- [ ] Headless mode (`--headless`)
- [ ] Config file support (`.trading-agent/settings.json`)
- [ ] Package as `pi-package`
- [ ] README + documentation

---

## 11. Open Questions

1. **Futures data source**: JoinQuant supports futures klines. Do we reuse the kline sync infrastructure or build a separate pipeline?
2. **Factor calculation performance**: Large-universe factor calc (5,500 stocks x 10 factors) may be slow. Consider caching daily factor snapshots in `factor_values` table.
3. **Sentiment data source**: Advance/decline and limit-up/down counts can be computed from quote table. Northbound flow requires external API (akshare).
4. **NL backtest ambiguity**: How to handle ambiguous strategy descriptions? Clarifying questions vs. best-effort defaults?
5. **Chart rendering fidelity**: ASCII art is universal but limited. Evaluate `sixel` support for higher fidelity, with ASCII fallback.

---

## Appendix A: Directory Structure (Current + Planned)

```
packages/trading-agent/
├── package.json
├── tsconfig.build.json
├── ARCHITECTURE.md          <-- This file
├── README.md                [PLANNED]
├── verify-phase1.mjs
├── prompts/
│   └── system-prompt.md     [EXISTS — needs update for analysis focus]
├── docs/
│   └── design/
│       └── skill-vs-tool-tradeoffs.md
├── src/
│   ├── main.ts              [EXISTS]
│   ├── index.ts             [EXISTS]
│   ├── core/                [EXISTS]
│   │   ├── trading-session.ts
│   │   ├── types.ts
│   │   ├── session-memory.ts      [EXISTS — upgrade to AnalysisMemory]
│   │   ├── skill-loader.ts
│   │   ├── model-config.ts
│   │   └── market-snapshot.ts     [PLANNED]
│   ├── data/                [EXISTS — very complete]
│   │   ├── data-store.ts
│   │   ├── data-sync.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── tools/               [EXISTS — 11 tools]
│   │   ├── _utils.ts
│   │   ├── market-data.ts
│   │   ├── screening.ts
│   │   ├── advanced-screening.ts
│   │   ├── compare-stocks.ts
│   │   ├── sector-rotation.ts
│   │   ├── concept-stocks.ts
│   │   ├── macro-data.ts
│   │   ├── backtest.ts
│   │   ├── stock-pool.ts
│   │   ├── sentiment.ts           [PLANNED]
│   │   ├── factor.ts              [PLANNED]
│   │   ├── strategy-tracker.ts    [PLANNED]
│   │   └── futures.ts             [PLANNED]
│   ├── backtest/            [EXISTS]
│   │   ├── engine.ts
│   │   ├── strategies.ts
│   │   ├── metrics.ts
│   │   ├── report.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── indicators/          [EXISTS]
│   │   └── engine.ts
│   ├── scheduler/           [EXISTS]
│   │   ├── task-scheduler.ts
│   │   └── routines/
│   │       ├── pre-market.ts
│   │       ├── post-market.ts
│   │       ├── weekly-review.ts   [PLANNED]
│   │       └── sentiment-scan.ts  [PLANNED]
│   ├── ui/                  [EXISTS — partial]
│   │   ├── trading-app.ts
│   │   └── markdown-theme.ts
│   │   └── report-viewer.ts       [PLANNED]
│   │   └── chart-panel.ts         [PLANNED]
│   │   └── sentiment-bar.ts       [PLANNED]
│   ├── config/              [EXISTS]
│   │   ├── user-config.ts
│   │   └── prompt-templates.ts
│   └── scripts/             [EXISTS]
│       └── sync_all_klines.py
├── skills/                  [PLANNED]
│   ├── value-analysis/SKILL.md
│   ├── technical-analysis/SKILL.md
│   ├── macro-analysis/SKILL.md
│   ├── sector-analysis/SKILL.md
│   ├── backtesting-guide/SKILL.md
│   ├── factor-analysis/SKILL.md
│   └── sentiment-analysis/SKILL.md
└── themes/                  [PLANNED]
    └── trading-dark.json
```

---

## Appendix B: Glossary

| Term | Meaning |
|------|---------|
| **TradingSession** | Core orchestrator wrapping the LLM agent (thin, analysis-focused) |
| **AnalysisMemory** | Calendar-day-organized memory with screening/backtest tracking |
| **TradingMode** | Analysis phase: research / pre-market / market / post-market |
| **Routine** | Scheduled analysis task (cron-based) |
| **Daily Compaction** | End-of-day summarization of screens, backtests, and conclusions |
| **MarketSnapshot** | Real-time injection of market-wide sentiment and sector heat |
| **Stock Pool** | Named set of stocks for batch analysis (not a trading portfolio) |
| **Skill** | Agent Skills standard markdown package with analysis workflows |
| **NL Screener** | Natural language technical + fundamental screening engine |
| **NL Backtest** | Natural language strategy description → backtest execution |
