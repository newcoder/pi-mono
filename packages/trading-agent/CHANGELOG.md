# Changelog

## [Unreleased]

### Added

- Added `sector-leader-selection` agent skill for selecting sector/concept leaders. Primary workflow uses `iwencai_screen` for direct leader pre-screening, followed by `compare_stocks` multi-metric pairwise selection. Selection criteria focus on sector-related revenue, revenue growth, and sentiment/attention (iwencai `个股热度` or turnover as proxy); PE/PB and short-term momentum rank thresholds are not used. Final pool contains up to 6 leaders split into two categories: up to 3 market-cap/revenue leaders and up to 3 high-growth/high-attention leaders. Saves results to a stock pool named `<sector>_龙头_<YYYYMMDD>`.
- Added multi-session chat to the Web UI with per-session file persistence (`~/.trading-agent/sessions/`), auto-generated titles (first-message truncation + background LLM refinement), and a session dropdown list with new/switch/delete.

### Fixed

- Fixed `findIndustryByName()` SQL generation to keep parameters quoted and sort matches by exact/prefix/substring priority, so names like `白酒II` match `白酒II` before `非白酒II`.
- Fixed `compare_stocks` tencent quote parsing to sanitize null bytes from API fields before downstream processing.
