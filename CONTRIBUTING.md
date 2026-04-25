# Contributing

Thanks for helping improve Blackcrab. This project is early, so focused,
well-described changes are much easier to review than broad rewrites.

## Development Setup

Install dependencies:

```sh
npm ci
```

Run checks:

```sh
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Run the desktop app:

```sh
npm run tauri -- dev
```

The app expects a working local Claude Code CLI. Install and authenticate it
before testing session flows.

## Pull Requests

- Keep changes scoped to one behavior, bug, or document area.
- Open an issue first for large UI, architecture, security, or process-lifecycle
  changes.
- Include manual test notes for Tauri UI behavior.
- Run `npm run typecheck` and `cargo check --manifest-path src-tauri/Cargo.toml --locked`.
- Do not include generated dependency, build, or editor files unless they are
  intentionally part of the change.

## Code Style

- Prefer existing patterns over new abstractions.
- Keep Tauri commands small and explicit.
- Keep subprocess ownership rules clear. A Claude session JSONL should have one
  live writer at a time.
- Add comments only when they explain a non-obvious invariant or failure mode.
- Avoid unrelated formatting churn in large files.

## Manual QA Checklist

For UI changes, test the relevant flows:

- Start a new session.
- Resume an existing session.
- Send a message and receive streamed output.
- Interrupt a running turn.
- Switch permission modes.
- Toggle grid mode and open at least two panels.
- Open and close the integrated terminal.
- Open a local preview URL if the change touches preview behavior.

## Documentation

Update docs when behavior changes. User-visible features should be reflected in
`README.md`; process, release, or security changes should update the matching
top-level document.
