# Blackcrab

Blackcrab is a local desktop GUI for Claude Code sessions. It wraps your local
`claude` CLI, indexes saved conversations from `~/.claude/projects`, and gives
you a faster interface for resuming, searching, exporting, and running multiple
sessions side by side.

This project is early, macOS-first, and intended for people already comfortable
with Claude Code, Tauri, and local developer tools.

![Blackcrab logo](blackcrab_logo.png)

## Features

- Resume and search local Claude Code sessions by title, project, model, date,
  or transcript text.
- Run a single conversation or a grid of up to six live panels.
- Rename, delete, and export sessions as Markdown.
- View tool calls, diffs, command output, thinking blocks, and permission
  prompts in a structured transcript.
- Open local preview URLs in a side webview.
- Use an integrated terminal backed by a native PTY.
- Launch an interactive Claude Code computer-use session from Blackcrab.
- Attach dropped files to messages.
- Track context and output-token usage per session.

## Requirements

- macOS for the currently tested desktop experience.
- Node.js 20 or newer.
- Rust stable and Cargo.
- The Claude Code CLI installed and authenticated.
- Tauri 2 system dependencies for your target platform.

Install and authenticate Claude Code first:

```sh
npm install -g @anthropic-ai/claude-code
claude auth login --claudeai
```

API-billing users can use the Claude Code console login flow instead.

## Development

```sh
npm ci
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml --locked
npm run dev
```

Other useful commands:

```sh
npm run dev:web
npm run build
npm run build:native
npm run build:native:signed
npm run check
npm run dev:desktop
npm run tauri -- build
```

`npm run dev` starts the Tauri desktop app. `npm run dev:web` starts only the
Vite frontend in a browser, primarily for browser-only UI debugging. The dev
desktop script picks an open port between 1420 and 1520 and passes it to both
Tauri and Vite.

Use `npm run build:native` for local `.app` / installer packaging. It disables
Tauri updater artifacts so it does not require the private updater signing key.
Use `npm run build:native:signed` for release-style builds; it requires
`TAURI_SIGNING_PRIVATE_KEY` and produces updater artifacts.

## Downloads and Updates

Release installers are published through GitHub Releases. The landing site can
link to `https://github.com/BonJenn/blackcrab/releases/latest`, or to its own
stable redirect route such as `/download/macos`.

Blackcrab is wired for Tauri's updater plugin. Release builds generate updater
artifacts and `latest.json` when `TAURI_SIGNING_PRIVATE_KEY` is available to
the build environment. The app checks the latest release endpoint:

```text
https://github.com/BonJenn/blackcrab/releases/latest/download/latest.json
```

See `RELEASE.md` for the full release, signing, notarization, and download
tracking workflow.

## How It Works

The frontend is React and Vite. The desktop shell and native commands are Tauri
2 with a Rust backend.

Blackcrab starts `claude -p` subprocesses with stream-json input/output. Each
live panel owns one subprocess, and the Rust backend enforces one active writer
per Claude session file so two panels do not append to the same JSONL at once.

Claude Code computer use currently requires an interactive Claude Code session,
so Blackcrab launches it through the PTY terminal instead of the structured
`claude -p` transcript path. Use the Computer Use button or command palette
entry, then use the terminal banner's `open /mcp` action to enable the built-in
`computer-use` MCP server if needed. The composer `GUI` action runs a hidden
interactive computer-use sidecar and streams it back into the main chat, with
inline controls for `/mcp`, menu navigation, and replies. Browser/search
handoffs tell Claude to prefer WebSearch or Claude-in-Chrome because Safari is
read-only for computer-use mouse and keyboard control.

Saved sessions are discovered from Claude Code's local JSONL files under
`~/.claude/projects`. Blackcrab reads those files to build the sidebar, search
history, render transcript tails quickly, and export conversations.

## Repository Map

- `src/App.tsx`: main application state, transcript UI, sidebar, command
  palette, grid mode, preview panel, and top-level Claude event handling.
- `src/LivePanel.tsx`: self-contained grid panel with its own subprocess,
  composer, transcript, and permission state.
- `src/Terminal.tsx`: xterm.js wrapper for the Rust PTY backend.
- `src/markdown.ts`: Markdown rendering, syntax highlighting, and PR
  linkification.
- `src-tauri/src/lib.rs`: Tauri commands for Claude process management,
  session indexing/search, git helpers, native preview navigation, and PTY I/O.
- `ROADMAP.md`: current stability and feature priorities.

## Privacy

Blackcrab is a local app. It does not proxy Claude traffic, ask for Anthropic
credentials, or run its own hosted backend.

It does read local Claude Code session files and pass messages to your local
`claude` CLI. Network requests to Anthropic, MCP servers, websites, package
registries, or other services come from the Claude CLI, tools it runs, opened
URLs, or commands you execute locally.

See `PRIVACY.md` for more detail.

## Security

Blackcrab intentionally coordinates powerful local tools: shells, Claude Code,
file paths, webviews, and git commands. Treat it like a developer tool with
local machine access, not a sandbox.

Please report vulnerabilities privately. See `SECURITY.md`.

## Contributing

Issues and pull requests are welcome, especially for stability, packaging,
documentation, tests, and focused UX improvements. Start with
`CONTRIBUTING.md`, and open an issue before large behavior or architecture
changes.

## License

Apache-2.0. See `LICENSE`.
