# Roadmap

This roadmap tracks the next product push for Blackcrab. Each item should land
as a separate pull request with its own tests and focused review surface.

## Operating Rules

- Keep one user-visible feature or infrastructure improvement per PR.
- Merge each PR before starting the next dependent PR.
- Prefer shared data/model fixes before adding UI on top of shaky state.
- Update this roadmap when scope changes during implementation.

## PR Sequence

### 1. Native Build And Release Ergonomics

**Goal.** Local native builds should complete cleanly without requiring the
private updater signing key, while release builds should still fail loudly when
release signing is missing.

**Scope.**

- Add an explicit local native build command that disables updater artifacts.
- Add an explicit signed release build command that requires updater signing.
- Document when to use each path.
- Keep the existing GitHub release workflow strict about signing and
  notarization.

**Done when.** A contributor can run one local command to produce a `.app` and
`.dmg`, and maintainers still have a separate signed release path.

### 2. Global Session Search

**Goal.** Make conversations discoverable across projects.

**Scope.**

- Search session titles, cwd/project, model, dates, and transcript text.
- Show result snippets with project/session context.
- Open a result directly in single mode.
- Keep the index local and derived from existing session files.

**Done when.** A user can find an old conversation without knowing its project
or exact title.

### 3. Session Metadata Reliability Layer

**Goal.** Sidebar, grid, and single mode should read session metadata from one
consistent source.

**Scope.**

- Centralize session metadata updates for title, timestamps, costs, tokens, and
  active ownership.
- Reduce direct ad hoc `sessions` array edits in UI handlers.
- Add focused helpers for replacing, refreshing, and removing session metadata.

**Done when.** Renaming or updating a session reflects consistently in sidebar,
grid, command palette, usage dashboard, and active transcript chrome.

### 4. Project Dashboard

**Goal.** Give each project a real operational home.

**Scope.**

- Add a project dashboard view grouped by cwd/project.
- Show sessions, recent activity, token/cost totals, active tasks, and quick
  launch actions.
- Support opening sessions and starting a new session in a project.

**Done when.** A user can answer "what is happening in this project?" without
manually scanning the sidebar.

### 5. Usage Dashboard V2

**Goal.** Turn the first usage dashboard into a more useful cost management
surface.

**Scope.**

- Add saved usage history over time rather than relying only on current session
  summaries.
- Add monthly/project/model breakdowns.
- Add budget thresholds and visible warnings.
- Preserve CSV and JSON export.

**Done when.** A user can identify cost trends and high-spend projects over
time, then export the underlying data.

### 6. Backup And Restore

**Goal.** Make local-first data portable and recoverable.

**Scope.**

- Export sessions, settings, project metadata, usage data, and drafts.
- Import a backup with conflict handling.
- Document what is included and what is intentionally excluded.

**Done when.** A user can move Blackcrab data to another machine or recover from
an accidental data loss.

### 7. Session Conflict UX

**Goal.** Replace confusing "session is being used somewhere else" failures
with clear choices.

**Scope.**

- Show where the session is currently open.
- Offer appropriate actions: focus existing view, open read-only, or request a
  handoff.
- Keep backend single-writer protections intact.

**Done when.** Attempting to open a busy session explains the conflict and gives
the user a safe next action.

### 8. Command Palette Expansion

**Goal.** Make common workflows keyboard reachable.

**Scope.**

- Add commands for project switching, usage, rename, archive, duplicate/open
  panel, export, backup, and diagnostics.
- Add aliases and useful hints.
- Keep destructive commands confirm-gated.

**Done when.** A power user can navigate and operate the app without reaching
for the mouse for routine actions.

### 9. Diagnostics And Logs View

**Goal.** Make failures explainable from inside the app.

**Scope.**

- Expand diagnostics into a support/debug console.
- Show recent Tauri command failures, Claude process state, stderr snippets,
  app version, OS, and copyable reports.
- Avoid exposing secrets in copied diagnostics.

**Done when.** A user can produce a useful bug report without opening devtools.

### 10. Saved Layouts And Workspaces

**Goal.** Let users preserve grid setups for repeated work.

**Scope.**

- Save named grid layouts per project.
- Restore panel counts, session assignments, cwd, and relevant view state.
- Add commands for saving, loading, and deleting layouts.

**Done when.** A user can reopen a project-specific working layout with one
action.

## Current Priority

Start with PR 1, then PR 2. Release/build reliability protects every future
change, and global search is the highest daily-use product feature after the
recent grid and usage work.
