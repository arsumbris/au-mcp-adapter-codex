---
type: au.engine.readme::au-engine
tldr: The Codex CLI adapter for the au-mcp kernel. It bridges tools, lifecycle hooks, transcripts, and generated capabilities.
---

# Repo Overview

## General Context

`arsumbris` is a framework for agentic knowledge work.

- `au-engine` serves the graph of typed workspace files.
- `au-host` is the framework's UI.
- `au-mcp` is the agent layer's kernel daemon.
- `au-mcp-sdk` defines the contract between the kernel, plugins, and adapters.
- `au-mcp-core` supplies the baseline tools and governance.

## What this is

`au-mcp-adapter-codex` is the **Codex CLI adapter** for the `au-mcp` kernel.
It declares Codex's native tools and file access, and translates between Codex and the daemon.
Tool policy lives in the daemon and its plugins.

### What it binds

- **The MCP-server shim** (`src/mcp-server.ts`) exposes the daemon's tools under `au` and forwards calls.
- **The hook bridge** (`src/bridge.ts`, `hooks/`) connects lifecycle events, mediation, and startup context.
- **The transcript lifter** (`src/lift.ts`) captures conversation events and replays history on resume.
- **The launch surface** (`bin/launch.ts`) generates skills and instructions, configures an app-server, and connects the Codex terminal to it.

The adapter declares its discoverable `mcp.adapter.codex` node and launcher entries in `type/`.
Governed actions remain blocked when daemon communication or startup initialization fails.

## How to use this

Requires macOS, Node 24.19+, Codex CLI (tested with 0.154.0), and sibling `au-mcp`, `au-mcp-sdk`, and
`au-engine-sdk` checkouts. Use current `main` revisions of the SDK and kernel, then install with `pnpm install`.

A launcher assembles the Codex invocation.

- The workspace's engine and MCP daemons must be running.
- `bin/launch.ts` takes `--workspace`, an absolute `--binary` path, and an optional `--profile`.
- It generates skills and instructions, builds the launch environment, and prints one JSON launch.
- The caller runs `command`, or spawns `binary` with `argv`, removing `unsetEnv` keys before merging `env` into the parent environment.
- Codex prompts for approval of the AU hooks.

Codex keeps conversations, credentials, and configuration in its existing `CODEX_HOME`
(default `~/.codex`). Shared AU materializers generate capabilities and collect unused caches.
Launches with the same selections share generated files; adapter bookkeeping and
disposable transcript cursors live under `~/.arsumbris/au-mcp/adapters/codex/`.

Resume through the same launcher with `--resume <thread-id-or-reference>` and the original
workspace and Codex home. It restores the recorded selections and regenerates their content.

Consumed as **TypeScript source**, with no build step.
Use `pnpm typecheck` and `pnpm test` for development checks.
Set `CODEX_TEST_BINARY` and `AU_ENGINE_TEST_BINARY` to absolute executable paths to enable their runtime tests.

## How to extend this

Keep Codex-specific translation in this adapter. Author reusable tools, hooks, skills,
and instructions against `au-mcp-sdk` and include their repositories in the workspace.
