# pi-mono Agent Guide

This document contains everything an AI coding agent needs to know to work effectively in the `pi-mono` repository.

## Project Overview

`pi-mono` is a TypeScript monorepo for building AI agents. Its flagship product is the **`pi` coding agent CLI** — an interactive terminal-based agent with file editing, bash execution, and multi-provider LLM support.

The project is maintained by Mario Zechner, MIT licensed, and published to npm under the `@mariozechner` scope.

## Technology Stack

- **Runtime**: Node.js >=20 (>=20.6.0 for `packages/coding-agent`)
- **Language**: TypeScript 5.7+ with `strict: true`
- **Package Manager**: npm with workspaces
- **Build Tools**:
  - `tsgo` (`@typescript/native-preview`) — fast TypeScript compiler used by most packages
  - `tsc` — used by `packages/web-ui` (requires DOM lib types)
  - `tailwindcss` — used by `packages/web-ui`
  - `bun` — used to compile standalone binaries for releases
- **Linting / Formatting**: Biome 2.3.5
- **Testing**:
  - Vitest for `packages/agent`, `packages/ai`, `packages/coding-agent`
  - Node.js built-in test runner (`node --test`) for `packages/tui`
- **Git Hooks**: Husky pre-commit hook runs `npm run check` and browser-smoke checks

## Monorepo Structure

The repository uses npm workspaces. All source lives under `packages/`:

| Package | Published Name | Purpose |
|---------|---------------|---------|
| `packages/ai` | `@mariozechner/pi-ai` | Unified multi-provider LLM streaming API (OpenAI, Anthropic, Google, Bedrock, Mistral, etc.) |
| `packages/agent` | `@mariozechner/pi-agent-core` | General-purpose agent runtime with tool calling, transport abstraction, and state management |
| `packages/coding-agent` | `@mariozechner/pi-coding-agent` | **`pi` CLI** — interactive coding agent with TUI, print mode, and RPC mode |
| `packages/tui` | `@mariozechner/pi-tui` | Terminal UI library with differential rendering, editor components, and keybinding system |
| `packages/web-ui` | `@mariozechner/pi-web-ui` | Reusable web components for AI chat interfaces (Lit / mini-lit based) |
| `packages/mom` | `@mariozechner/pi-mom` | Slack bot that delegates messages to the pi coding agent |
| `packages/pods` | `@mariozechner/pi-pods` | CLI for managing vLLM deployments on GPU pods |
| `packages/trading-agent` | `@mariozechner/pi-trading-agent` | LLM-assisted investment analysis agent with market data and backtesting |
| `packages/skills` | — | Shared skill packages distributed with the project |

### Dependency Order

Builds must happen in this order because packages depend on each other:

```
tui -> ai -> agent -> coding-agent -> mom -> web-ui -> pods
```

The root `npm run build` script enforces this order manually.

## Build, Development, and Test Commands

### Building

```bash
npm install          # Install all dependencies
npm run build        # Build all packages in dependency order
npm run dev          # Watch all core packages concurrently (tui, ai, agent, coding-agent, mom, web-ui)
```

> `npm run check` requires `npm run build` to be run first because `web-ui` uses `tsc` which needs compiled `.d.ts` files from dependencies.

### Checking Code Quality

```bash
npm run check                    # Biome format/lint + tsgo type check + browser smoke + web-ui check
npm run check:browser-smoke      # Smoke test for browser bundles
```

The Husky pre-commit hook runs `npm run check`. If files under `packages/ai/`, `packages/web-ui/`, `package.json`, or `package-lock.json` are staged, it also runs `npm run check:browser-smoke`.

### Testing

```bash
npm test           # Run all workspace tests
./test.sh          # Run tests with API keys stripped (safe for CI/local without keys)
./pi-test.sh       # Run pi from source via tsx (can be run from any directory)
```

To run a specific test file:

```bash
cd packages/<package>
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

> **Never run `npm run dev`, `npm run build`, or `npm test` unless explicitly instructed.**

## Code Style and Quality

Biome configuration (`biome.json`):

- **Indent**: tabs, width 3
- **Line width**: 120
- **Formatter**: enabled, errors must be fixed
- **Linter rules**:
  - `noNonNullAssertion`: off
  - `useConst`: error
  - `useNodejsImportProtocol`: off
  - `noExplicitAny`: off (allowed but discouraged)
  - `noEmptyInterface`: off

TypeScript base config (`tsconfig.base.json`):

- Target: ES2022
- Module: Node16
- Strict: true
- Decorators enabled (`experimentalDecorators`, `emitDecoratorMetadata`)
- `useDefineForClassFields`: false
- Source maps and declarations enabled

### Hard Rules

- **No `any` types unless absolutely necessary.**
- **Never use inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions. Always use standard top-level imports.
- **Never remove or downgrade code** to fix type errors from outdated dependencies; upgrade the dependency instead.
- **Never hardcode key checks** (e.g., `matchesKey(keyData, "ctrl+x")`). All keybindings must be configurable via `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.
- Always ask before removing functionality that appears intentional.
- Do not preserve backward compatibility unless explicitly asked.

## Testing Strategy

### General Rules

- Run tests from the package root, not the repo root.
- If you create or modify a test file, you **must** run that test file and iterate until it passes.
- After code changes (not documentation): `npm run check`. Fix all errors, warnings, and infos before committing.

### Package-Specific Testing

**`packages/ai`** — Vitest with 30-second timeout for API calls. Tests hit real provider endpoints when API keys are present. The `test.sh` script unsets all API keys so only mocked/offline tests run.

**`packages/agent`** — Vitest with 30-second timeout. Includes `test/utils/` for shared test utilities.

**`packages/coding-agent`** — Two test layers:

1. **Regular tests** under `test/` — vitest with local package aliases for `@mariozechner/pi-ai`, `@mariozechner/pi-ai/oauth`, and `@mariozechner/pi-agent-core`.
2. **Suite tests** under `test/suite/` — deterministic, no-network tests using `test/suite/harness.ts` and the **faux provider** (`packages/ai/src/providers/faux.ts`).
   - Do **not** use real provider APIs, real API keys, or paid tokens in suite tests.
   - Put broad lifecycle tests directly under `test/suite/`.
   - Put issue-specific regressions under `test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.

**`packages/tui`** — Node.js built-in test runner (`node --test --import tsx`). Vitest config only includes `test/wrap-ansi.test.ts` for legacy reasons; most tests run via `node:test`.

**`packages/web-ui`** — No automated test runner configured. Verified via `npm run check` (type check + biome) and browser smoke tests.

### Running pi from Source

```bash
./pi-test.sh                    # Run pi CLI from source
./pi-test.sh --no-env           # Run with API keys unset
```

### Testing pi Interactive Mode with tmux

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s pi-test -x 80 -y 24

# Start pi from source
tmux send-keys -t pi-test "cd /Users/badlogic/workspaces/pi-mono && ./pi-test.sh" Enter

# Wait for startup, then capture output
sleep 3 && tmux capture-pane -t pi-test -p

# Send input
tmux send-keys -t pi-test "your prompt here" Enter

# Send special keys
tmux send-keys -t pi-test Escape
tmux send-keys -t pi-test C-o  # ctrl+o

# Cleanup
tmux kill-session -t pi-test
```

## Security Considerations

- **Credentials**: `auth.json` is stored in `~/.pi/agent/`. Never commit credential files.
- **API Keys**: The `test.sh` script unsets all known API key environment variables before running tests. Do not hardcode keys in source or tests.
- **Pre-commit hooks**: Husky enforces `npm run check` and browser-smoke checks on staged files.
- **No real network in suite tests**: `packages/coding-agent/test/suite/` must remain deterministic and offline.

## Contribution Gate

- New issues from new contributors are auto-closed by `.github/workflows/issue-gate.yml`.
- New PRs from new contributors without PR rights are auto-closed by `.github/workflows/pr-gate.yml`.
- Maintainer approval comments are handled by `.github/workflows/approve-contributor.yml`.
- Maintainers review auto-closed issues daily.
- Issues that do not meet the quality bar in `CONTRIBUTING.md` are not reopened and do not receive a reply.
- `lgtmi` approves future issues.
- `lgtm` approves future issues and rights to submit PRs.

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects.
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`
  - If an issue spans multiple packages, add all relevant labels.

When posting issue/PR comments:

- Write the full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`.
- Never pass multi-line markdown directly via `--body` in shell commands.
- Preview the exact comment text before posting.
- Post exactly one final comment unless the user explicitly asks for multiple comments.
- If a comment is malformed, delete it immediately, then post one corrected comment.
- Keep comments concise, technical, and in the user's tone.

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message.
- This automatically closes the issue when the commit is merged.

## PR Workflow

- Analyze PRs without pulling locally first.
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone.
- You never open PRs yourself. Work in feature branches until everything is according to the user's requirements, then merge into main and push.

## Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text.
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!").

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own).

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` — API changes requiring migration
- `### Added` — New features
- `### Changed` — Changes to existing functionality
- `### Fixed` — Bug fixes
- `### Removed` — Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist.
- New entries ALWAYS go under `## [Unreleased]` section.
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates.
- NEVER modify already-released version sections (e.g., `## [0.12.2]`).
- Each version section is immutable once released.

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## Adding a New LLM Provider (`packages/ai`)

Adding a new provider requires changes across multiple files.

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `Api` type union (e.g., `"bedrock-converse-stream"`).
- Create options interface extending `StreamOptions`.
- Add mapping to `ApiOptionsMap`.
- Add provider name to `KnownProvider` type union.

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `packages/ai/package.json` pointing at `./dist/providers/<provider>.js`.
- Add `export type` re-exports in `packages/ai/src/index.ts` for provider option types that should remain available from the root entry.
- Register the provider in `packages/ai/src/providers/register-builtins.ts` via lazy loader wrappers. Do not statically import provider implementation modules there.
- Add credential detection in `packages/ai/src/env-api-keys.ts`.

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source.
- Map to standardized `Model` interface.

### 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API implementation such as `openai-completions`.
- Add the provider to the broader provider matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.
- For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: Add default model ID to `defaultModelPerProvider`.
- `src/modes/interactive/interactive-mode.ts`: Add API-key login display name to `API_KEY_LOGIN_PROVIDERS` so `/login` shows the provider for built-in API-key auth.
- `src/cli/args.ts`: Add env var documentation.
- `README.md`: Add provider setup instructions.
- `docs/providers.md`: Add setup instructions, env var, and `auth.json` key.

### 7. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth, add env vars.
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`.

## Releasing

**Lockstep versioning**: All packages always share the same version number. Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

### Steps

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's `CHANGELOG.md`.

2. **Run release script**:
   ```bash
   npm run release:patch    # Fixes and additions
   npm run release:minor    # API breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

Binaries are built automatically on release tags via `.github/workflows/build-binaries.yml` using Bun, producing `pi` binaries for darwin/linux/windows (x64 and arm64).

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**.
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR.
- NEVER use `git add -A` or `git add .` — these sweep up changes from other agents.
- ALWAYS use `git add <specific-file-paths>` listing only files you modified.
- Before committing, run `git status` and verify you are only staging YOUR files.
- Track which files you created/modified/deleted during the session.
- It is always fine to include `packages/ai/src/models.generated.ts` in a commit alongside the actual files you want to commit.

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` — destroys uncommitted changes
- `git checkout .` — destroys uncommitted changes
- `git clean -fd` — deletes untracked files
- `git stash` — stashes ALL changes including other agents' work
- `git add -A` / `git add .` — stages other agents' uncommitted work
- `git commit --no-verify` — bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only.
- If conflict is in a file you didn't modify, abort and ask the user.
- NEVER force push.

### User Override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
