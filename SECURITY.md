# Security Policy

## Supported Versions

Blackcrab is pre-1.0. Security fixes target the `main` branch until release
branches exist.

## Reporting a Vulnerability

Please do not open a public issue for a security vulnerability.

Use GitHub's private vulnerability reporting for this repository if it is
enabled. If private reporting is unavailable, open a minimal public issue asking
for a private contact path, without exploit details.

Helpful reports include:

- Affected version or commit.
- Operating system.
- Clear reproduction steps.
- Expected and actual impact.
- Whether the issue requires a malicious repository, malicious Claude session,
  malicious web page, or local attacker.

## Scope

In scope:

- Unsafe handling of local session JSONL files.
- Unexpected command execution caused by Blackcrab itself.
- Webview or preview behavior that exposes local data unexpectedly.
- Permission, session ownership, or process-lifecycle bugs that can corrupt
  local Claude session files.
- Secrets or credentials accidentally stored or exposed by Blackcrab.

Out of scope:

- Behavior of the Claude Code CLI itself.
- Behavior of tools, MCP servers, shells, or commands launched by Claude.
- Social engineering.
- Issues requiring full local account compromise.
- Denial-of-service reports without a realistic security impact.

## Security Model

Blackcrab is a local developer tool, not a sandbox. It can start shells and
Claude subprocesses, read local Claude session metadata, pass prompts to the
local Claude CLI, and open webviews. Only run it on machines and repositories
where that level of local access is acceptable.
