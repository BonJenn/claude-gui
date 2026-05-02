# Privacy

Blackcrab is designed as a local desktop app.

## What Blackcrab Reads

- Claude Code session JSONL files under `~/.claude/projects`.
- Project directories and file paths you choose in the UI.
- Git metadata for selected project directories, such as branches and remotes.
- Files you explicitly attach by drag-and-drop.

## What Blackcrab Sends

Blackcrab sends messages to your local `claude` CLI subprocess. The CLI is
responsible for any network requests to Anthropic or configured providers.

Blackcrab does not proxy Claude traffic or ask for Anthropic credentials.

If anonymous analytics are enabled, Blackcrab sends app launch and updater
events to `https://www.blackcrab.app/api/events`. Those events include platform,
current version, update target version when applicable, event type, and a
locally generated anonymous install id. The server hashes that install id before
storage. Prompts, transcripts, project paths, file contents, and Anthropic
credentials are not included. This can be turned off in Settings.

## Local Storage

Blackcrab stores UI preferences in browser localStorage, including theme,
sidebar/grid sizing, grid panel state, and short-lived composer drafts.

Composer drafts are keyed by session id and pruned after 30 days by the app.

## Preview Webview

The preview panel can open HTTP and HTTPS URLs. Local development URLs may be
auto-detected from transcript output. Content loaded in the preview panel is
controlled by the website or local server you open.

## Logs and Transcripts

Claude Code transcripts may contain prompts, file paths, command output, and
tool results. Treat exported Markdown transcripts and session JSONL files as
potentially sensitive.
