# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the **pi-mono** monorepo containing the `pi` coding agent and related packages. It is a TypeScript/npm monorepo using workspaces.

| Package | Path | Description |
|---------|------|-------------|
| `@mariozechner/pi-ai` | `packages/ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Bedrock, etc.) |
| `@mariozechner/pi-agent-core` | `packages/agent` | Agent runtime with tool calling and state management |
| `@mariozechner/pi-coding-agent` | `packages/coding-agent` | Interactive coding agent CLI (`pi` command) |
| `@mariozechner/pi-tui` | `packages/tui` | Terminal UI library with differential rendering |
| `@mariozechner/pi-web-ui` | `packages/web-ui` | Web components for AI chat interfaces |
| `@mariozechner/pi-mom` | `packages/mom` | Slack bot that delegates to the coding agent |
| `@mariozechner/pi-pods` | `packages/pods` | CLI for managing vLLM deployments on GPU pods |
| `@mariozechner/pi-trading-agent` | `packages/trading-agent` | Trading agent with market data tools and portfolio management |

**Lockstep versioning**: All packages share the same version number. Every release updates all packages together.

## Development Commands

### Setup
```bash
npm install          # Install all dependencies
npm run build        # Build all packages (required before check)
```

**Build order dependency**: The root `build` script compiles packages in a specific order: `tui` → `ai` → `agent` → `coding-agent` → `mom` → `web-ui` → `pods`. `web-ui` requires compiled `.d.ts` files from dependencies, so order matters. `npm run check` requires `npm run build` to be run first.

### Quality Checks
```bash
npm run check        # Lint, format, and type check with Biome + TypeScript
```

### Testing
```bash
./test.sh            # Run all tests without API keys (moves auth.json aside, unsets all API keys)
npm test             # Run tests directly (requires API keys for some tests)
```

`test.sh` temporarily moves `~/.pi/agent/auth.json` to a backup and unsets all known API key environment variables so that LLM-dependent tests are skipped. The original auth file is restored on exit.

**Running specific tests** (from package root, not repo root):
```bash
cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
cd packages/ai && npx vitest --run test/stream.test.ts
```

### Development Server
```bash
npm run dev          # Watch mode for all packages (compiles on change)
npm run dev:tsc      # Watch mode type checking for ai and web-ui packages only
./pi-test.sh         # Run pi from sources (can be run from any directory)
./pi-test.sh --no-env  # Run pi without API keys (unsets all known env vars)
```

### Releases
```bash
npm run release:patch    # Bug fixes and features
npm run release:minor    # API breaking changes
```

## Code Standards

### TypeScript
- **NEVER use inline imports** - No `await import("./foo.js")`, no `import("pkg").Type` in type positions. Always use standard top-level imports.
- No `any` types unless absolutely necessary.
- Check `node_modules` for external API type definitions instead of guessing.
- Uses `tsgo` (TypeScript Go) for faster compilation instead of `tsc`.

### Linting/Formatting
- Uses **Biome** for linting and formatting (configured in `biome.json`).
- Indent: tabs, line width: 120.
- Always run `npm run check` after code changes and fix all errors, warnings, and infos.

### Style
- No emojis in commits, issues, PR comments, or code.
- Technical prose only, be kind but direct.
- Keep answers short and concise.

## Architecture

### Package Dependencies
```
pi-ai (base layer - no internal deps)
  ↑
pi-agent-core (depends on pi-ai)
  ↑
pi-coding-agent (depends on pi-ai, pi-agent-core, pi-tui)
pi-tui (independent, no internal deps)
pi-web-ui (independent)
pi-mom (depends on pi-coding-agent)
pi-pods (independent)
pi-trading-agent (depends on pi-ai, pi-agent-core, pi-coding-agent, pi-tui)
```

### Key Architectural Patterns

**Provider Pattern (packages/ai)**: LLM providers are implemented in `packages/ai/src/providers/`. Each provider exports a `stream<Provider>()` function returning `AssistantMessageEventStream` with standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`). Providers are registered lazily in `register-builtins.ts` via dynamic imports to avoid loading unused provider code.

**Agent Session (packages/coding-agent)**: The core `AgentSession` class in `core/agent-session.ts` manages conversation state, tool execution, compaction (context window management), and branching. It uses an event-driven architecture via `AgentSessionEvent`. Session logic is split across three layers:
- `AgentSession` - pure session logic (state, messages, compaction, branching)
- `AgentSessionServices` - cwd-bound services (auth, settings, model registry, resource loader)
- `AgentSessionRuntime` - owns the session + services lifecycle, handles session replacement and diagnostics

**Event Bus (packages/coding-agent)**: A typed `EventBus` wrapper around Node's `EventEmitter` (`core/event-bus.ts`) provides the pub/sub backbone. Extensions and internal components communicate via named channels. Handlers are wrapped in async error boundaries so one failing handler does not crash others.

**Extension System (packages/coding-agent)**: Extensions in `core/extensions/` provide hooks into the agent lifecycle (`BeforeAgentStartEvent`, `TurnEndEvent`, `ToolCallEvent`, etc.). Extensions can add tools, commands, and UI widgets. The `ExtensionRunner` loads extensions and routes lifecycle events to registered handlers. Extension factories receive an `ExtensionContext` with APIs for registering tools, commands, and UI components.

**Tool System (packages/coding-agent)**: Built-in tools live in `core/tools/` and include: `bash`, `edit`, `find`, `grep`, `ls`, `read`, `write`. Each tool exports a schema (Typebox), operations interface, and a `create*Tool()` factory. Tools are wrapped into `ToolDefinition` objects that the extension system consumes. The `bash` tool supports pluggable `BashOperations` for different execution environments (local spawn, remote, etc.).

**TUI Differential Rendering (packages/tui)**: The TUI library uses differential rendering for efficient terminal updates. Components implement the `Component` interface with a `render(width)` method returning string arrays. The `TUI` class diffs rendered lines against the previous frame and writes only changed cells. Focusable components emit `CURSOR_MARKER` in their output for IME positioning.

### Testing Patterns

**Faux Provider**: Tests in `packages/ai/test/faux-provider.test.ts` and `packages/coding-agent/test/test-harness.ts` use a mock LLM provider for deterministic testing without API calls. The faux provider accepts a sequence of `FauxResponse` objects describing text, tool calls, thinking, and usage to emit.

**Test Harness**: For coding-agent tests, use `test-harness.ts` which provides `createTestAgentSession()` for creating a fully wired `AgentSession` with in-memory dependencies and faux LLM responses.

**Suite Tests**: Regression tests for specific issues go in `packages/coding-agent/test/suite/regressions/<issue-number>-<short-slug>.test.ts`.

### Session Storage
Sessions are stored in `~/.pi/sessions/` as JSONL files with a custom entry format (see `SessionEntry` types in `core/session-manager.ts`). Sessions support branching, compaction (summarizing old messages), and model switching mid-conversation.

## Changelog Format

Each package has its own `CHANGELOG.md`. Use these sections under `## [Unreleased]`:
- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

Attribution format:
- Internal: `Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- External: `Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## Adding a New LLM Provider

See `AGENTS.md` section "Adding a New LLM Provider (packages/ai)" for the full checklist. Key files to modify:
- `packages/ai/src/types.ts` - Add to `Api` type union and `ApiOptionsMap`
- `packages/ai/src/providers/<provider>.ts` - Implement streaming
- `packages/ai/src/providers/register-builtins.ts` - Register lazy loader
- `packages/ai/src/env-api-keys.ts` - Add credential detection
- `packages/coding-agent/src/core/model-resolver.ts` - Add default model ID

## Git Workflow

- Work in feature branches, merge to `main`, push.
- Do not open PRs yourself; the maintainer handles external PRs.
- When closing issues via commit, include `fixes #<number>` or `closes #<number>`.
- **Never** use `git add -A` or `git add .` in parallel agent environments.
- **Never** use `git reset --hard`, `git checkout .`, or `git stash` (destroys other agents' work).
