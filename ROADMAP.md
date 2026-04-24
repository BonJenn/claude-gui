# Roadmap

Two buckets: stability first (paying down risk you've already seen), then features.
Each item has an effort estimate (S <1d, M 1–3d, L 3d+) and the tradeoff
worth knowing before starting.

## Stability

### 1. CI: `tsc --noEmit` + `tauri build` on PRs — S
**Why.** The `permission_mode` / `RefObject<T|null>` / unused-function drift that
broke `npm run tauri build` earlier this branch should not have been mergeable.
A GitHub Actions job running `npx tsc --noEmit` plus a cached `npm ci && npm run
tauri build` on every PR catches all of it.
**Tradeoff.** Adds ~5 min to PR turnaround on a cold cache; most of that is the
Rust build, so cache `~/.cargo` and `src-tauri/target` aggressively.
**Done when.** A PR that breaks `tsc` fails checks and cannot be merged without
override.

### 2. Canonicalize `gridPanels` semantics — M
**Why.** Entries are currently a mix of real session ids and `new:uuid:ts`
placeholders. The placeholder→session mapping lives in `panelSessionIds` and
has to be consulted from four places (sidebar pin, topbar sync, title edit,
remove cleanup). Every one of those consults is a landmine — the dedup bug I
fixed in #37 is one example. Redesign so `gridPanels` holds opaque panel-ids
only and the session id is always looked up via one helper.
**Tradeoff.** Touches the trickiest file in the repo. Needs a careful audit of
every `startsWith("new:")` callsite and every `gridPanels.includes(sid)` check.
Worth doing in one pass with solid manual test of all grid flows before/after.
**Done when.** No call site outside a single `resolvePanelSession(panelId)`
helper needs to care whether a panel is "new:" or real.

### 3. Stale-entry cleanup on `refreshSessions` — S
**Why.** If a session file is deleted (or never hydrates), its pinned tile in
`gridPanels` renders `loading session…` forever. After every `refreshSessions`,
drop any `gridPanels` entry that is neither a known `new:` placeholder nor a
hydrated session in the `sessions` array.
**Tradeoff.** Risk of a brief hydration race (session file exists but
`list_sessions` hasn't returned it yet) wiping a valid pin. Mitigate by only
pruning entries that have been unknown for > 1 refresh cycle (`useRef`
tracker), not on the first miss.
**Done when.** Deleting a session JSONL on disk and refreshing removes the
tile instead of leaving a permanent "loading…" slot.

### 4. Toast-based error surfacing — S
**Why.** Every backend call `console.error`s and the UI stays silent. Users see
a half-broken state with no explanation. A minimal toast (top-right, auto-
dismiss) wired to a `notify(msg, kind)` helper, called from every `invoke(...)
.catch`, would tell users when `start_session` / `set_session_title` /
`send_message` fail.
**Tradeoff.** Adds visual noise if overused — avoid toasting transient events
(stream interrupts, stop_session). Reserve for terminal failures the user
needs to know about.
**Done when.** Killing the claude CLI externally produces a visible toast, not
just a dead panel.

### 5. Single-writer enforcement per session — M
**Why.** With the empty-grid seed, the single-mode "main" subprocess stays
alive and hidden while the grid's LivePanel also resumes the same session. Two
subprocesses appending to the same JSONL will drift: messages from one will
be invisible to the other, and on reload the transcript reassembly is
undefined. Move session ownership to Rust: track `sid -> panel_id` at the
backend, and refuse a second `start_session` for a session already held by
another panel until the first panel stops.
**Tradeoff.** Tightens an invariant that was previously lax — a legitimate
"same session in grid and main" flow would now need an explicit handoff
(stop_session on main, then start_session on the grid panel). Worth it.
**Done when.** Two LivePanels on the same session id is a loud Rust error, not
a silent divergence.

## Features

### 6. Grid keyboard shortcuts — S
**Why.** `⌘K` and `⌘J` exist; grid has no first-class keyboard vocabulary.
- ⌘1–⌘6: focus panel N
- ⌘W: close focused panel
- ⌘⇧D: duplicate focused panel (new tile, resume same session id — gated on
  the single-writer work above, otherwise it dupes a running subprocess)
**Tradeoff.** ⌘W can conflict with "close window" on macOS. Scope to grid-mode
only and confirm it doesn't swallow the shortcut elsewhere.
**Done when.** Jonathan can navigate a 6-tile grid without the mouse.

### 7. Session deletion from sidebar — S
**Why.** Renaming lands in #13; you can only prune sessions by deleting JSONL
files manually. Add a Rust `delete_session(session_id, cwd)` command (trash,
not unlink, so recovery is possible) + sidebar context menu item. Confirm
modal before firing.
**Tradeoff.** Trashing a file the user is resuming elsewhere would strand the
subprocess. Gate on "no active panel attached to this session" — or, after
single-writer work, refuse in Rust if the session is running.
**Done when.** Right-click → Delete → trash → session disappears from sidebar
and from disk.

### 8. In-transcript search (⌘F) — M
**Why.** Full-text search across sessions is in (⌘K → search); but once a
session is open, you can't find "that line about websockets" without scrolling.
Add an overlay bar with incremental match, next/prev, and highlight in the
rendered transcript. Works against compiled plaintext from the markdown, not
raw jsonl.
**Tradeoff.** Needs care around the virtualized transcript (entries outside
the viewport need to scroll into view for highlighting). If it ends up fighting
react-virtuoso / the keep-alive slots, fall back to scrolling without
highlighting matches outside the mounted window.
**Done when.** ⌘F over an open session highlights matches and n/N cycles
through them.

### 9. Per-session composer draft persistence — S
**Why.** Switching sessions mid-typing drops the draft. Persist `input` in
localStorage keyed by session id (with a short max length to avoid clobbering
the tab on huge pasted blobs).
**Tradeoff.** Tiny risk of drafts piling up in localStorage — evict on session
delete and on app start for sessions older than 30 days.
**Done when.** Type into the composer, click another session, return —
draft is still there.

## Suggested order

1. **#1 CI** — smallest change, broadest return. Catches everything else.
2. **#4 Toasts** — decouples future debugging from me staring at console logs.
3. **#3 Stale cleanup** — quick win, stops one common ghost-state source.
4. **#2 Canonicalize** — invest here before more grid features land on top of
   the two-namespace design.
5. **#5 Single-writer** — unlocks #6's "duplicate panel" safely.
6. **#6–#9** — all independent, can land in any order.
