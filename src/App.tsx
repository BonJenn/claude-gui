import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { TerminalPanel, type TerminalInitialWrite } from "./Terminal";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Webview, getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { compileMarkdown } from "./markdown";
import blackcrabLogo from "../blackcrab_logo.png";
import {
  LivePanel,
  setPermissionModeOnPanel,
  respondPermission,
  type PermissionRequest,
} from "./LivePanel";
import { subscribeToasts, type Toast, notify, notifyErr } from "./toast";
import "./App.css";

type AvailableUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

export type TextBlock = {
  type: "text";
  text: string;
  _streaming?: boolean;
  _html?: string;
  _repo?: string;
};
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  _inputJson?: string;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
};
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  _streaming?: boolean;
  _html?: string;
  _repo?: string;
};
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | { type: string; [k: string]: unknown };

export type ToolMeta = { name: string; input: unknown };

export type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; blocks: Block[] }
  | {
      kind: "tool_result";
      id: string;
      toolUseId: string;
      content: ToolResultBlock["content"];
      isError?: boolean;
    }
  | { kind: "system"; id: string; text: string }
  | { kind: "result"; id: string; text: string; isError?: boolean }
  | {
      kind: "computer_use";
      id: string;
      terminalId: string;
      title: string;
      output: string;
      status: "starting" | "running" | "done" | "error";
      error?: string;
    };

export type StreamEvent =
  | {
      type: "system";
      subtype: string;
      session_id?: string;
      tools?: string[];
      model?: string;
      cwd?: string;
      mcp_servers?: Array<{ name: string; status: string }>;
    }
  | {
      type: "assistant";
      message: { id: string; content: Block[] };
      session_id?: string;
    }
  | {
      type: "user";
      message: { content: string | Block[] };
      session_id?: string;
    }
  | {
      type: "result";
      subtype: string;
      is_error?: boolean;
      total_cost_usd?: number;
      duration_ms?: number;
      session_id?: string;
    }
  | {
      type: "stream_event";
      event: PartialEvent;
      session_id?: string;
    };

export type PartialEvent =
  | { type: "message_start"; message: { id: string } }
  | { type: "content_block_start"; index: number; content_block: Block }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: unknown }
  | { type: "message_stop" }
  | { type: string; [k: string]: unknown };

type SessionInfo = {
  id: string;
  title: string;
  cwd: string;
  mtime_ms: number;
  message_count: number;
  context_tokens: number;
  context_limit: number;
  total_cost_usd: number;
  output_tokens: number;
  model: string;
  permission_mode: string;
};

type BranchInfo = {
  is_repo: boolean;
  current: string;
  branches: string[];
  dirty: boolean;
};

type ClaudePreflight = {
  installed: boolean;
  authenticated: boolean;
  version: string;
  path: string;
  auth_method: string;
  api_provider: string;
  error: string;
};

type AppTheme = "light" | "dark" | "jet";
type PermissionMode = "bypassPermissions" | "acceptEdits" | "default" | "plan";
type NewPanelWorktreeMode = "ask" | "always" | "never";

type AppSettings = {
  startupCwd: string;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  notifyOnTurnComplete: boolean;
  autoCheckUpdates: boolean;
  autoOpenPreview: boolean;
  newPanelWorktreeMode: NewPanelWorktreeMode;
};

type TerminalTab = {
  id: string;
  label: string;
  kind?: "shell" | "computer-use";
  initialWrites?: TerminalInitialWrite[];
  handoffText?: string;
  handoffAutoQueued?: boolean;
  handoffSent?: boolean;
};

const APP_SETTINGS_STORAGE_KEY = "blackcrab.settings";

const DEFAULT_APP_SETTINGS: AppSettings = {
  startupCwd: "",
  defaultModel: "",
  defaultPermissionMode: "bypassPermissions",
  notifyOnTurnComplete: true,
  autoCheckUpdates: true,
  autoOpenPreview: true,
  newPanelWorktreeMode: "ask",
};

const THEME_OPTIONS: Array<{ value: AppTheme; label: string; glyph: string }> = [
  { value: "light", label: "Light", glyph: "☀" },
  { value: "dark", label: "Dark", glyph: "◐" },
  { value: "jet", label: "Jet", glyph: "●" },
];

const MODEL_OPTIONS: Array<{ value: string; label: string; disabled?: boolean }> = [
  { value: "", label: "default (auto)" },
  { value: "opus", label: "Opus (latest)" },
  { value: "sonnet", label: "Sonnet (latest)" },
  { value: "haiku", label: "Haiku (latest)" },
  { value: "__sep__", label: "──────────", disabled: true },
  { value: "claude-opus-4-7", label: "claude-opus-4-7" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5" },
  { value: "claude-opus-4-5", label: "claude-opus-4-5" },
  { value: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
];

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "bypassPermissions", label: "bypass" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "default", label: "default" },
  { value: "plan", label: "plan" },
];

const NEW_PANEL_WORKTREE_OPTIONS: Array<{
  value: NewPanelWorktreeMode;
  label: string;
}> = [
  { value: "ask", label: "ask each time" },
  { value: "always", label: "always use worktrees" },
  { value: "never", label: "never use worktrees" },
];

export const REPLAY_SKIP = new Set([
  "queue-operation",
  "last-prompt",
  "ai-title",
  "custom-title",
  "attachment",
  "system",
]);

// How many recent messages to show when opening a session. Big enough to
// cover the recent context of most turns, small enough that parsing +
// rendering is essentially free on click.
export const SESSION_TAIL_LIMIT = 200;

// Per-session composer drafts in localStorage. Survives session switches
// and restarts. Keyed by session id (or NEW_SESSION_KEY before the user
// has started one). Pruned on app mount — drafts older than 30 days are
// discarded to keep the store bounded.
const DRAFTS_STORAGE_KEY = "composerDrafts";
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
type DraftStore = Record<string, { text: string; updated_ms: number }>;

function isPermissionMode(v: unknown): v is PermissionMode {
  return (
    v === "bypassPermissions" ||
    v === "acceptEdits" ||
    v === "default" ||
    v === "plan"
  );
}

function isNewPanelWorktreeMode(v: unknown): v is NewPanelWorktreeMode {
  return v === "ask" || v === "always" || v === "never";
}

function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      startupCwd:
        typeof parsed.startupCwd === "string"
          ? parsed.startupCwd
          : DEFAULT_APP_SETTINGS.startupCwd,
      defaultModel:
        typeof parsed.defaultModel === "string"
          ? parsed.defaultModel
          : DEFAULT_APP_SETTINGS.defaultModel,
      defaultPermissionMode: isPermissionMode(parsed.defaultPermissionMode)
        ? parsed.defaultPermissionMode
        : DEFAULT_APP_SETTINGS.defaultPermissionMode,
      notifyOnTurnComplete:
        typeof parsed.notifyOnTurnComplete === "boolean"
          ? parsed.notifyOnTurnComplete
          : DEFAULT_APP_SETTINGS.notifyOnTurnComplete,
      autoCheckUpdates:
        typeof parsed.autoCheckUpdates === "boolean"
          ? parsed.autoCheckUpdates
          : DEFAULT_APP_SETTINGS.autoCheckUpdates,
      autoOpenPreview:
        typeof parsed.autoOpenPreview === "boolean"
          ? parsed.autoOpenPreview
          : DEFAULT_APP_SETTINGS.autoOpenPreview,
      newPanelWorktreeMode: isNewPanelWorktreeMode(
        parsed.newPanelWorktreeMode,
      )
        ? parsed.newPanelWorktreeMode
        : DEFAULT_APP_SETTINGS.newPanelWorktreeMode,
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

function saveAppSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage full / private mode — treat settings persistence as best effort.
  }
}

function loadDrafts(): DraftStore {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as DraftStore;
  } catch {
    return {};
  }
}

function saveDrafts(d: DraftStore): void {
  try {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(d));
  } catch {
    // localStorage full / private mode — treat as best effort.
  }
}

function pruneDrafts(d: DraftStore): DraftStore {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  const out: DraftStore = {};
  let changed = false;
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v.updated_ms === "number" && v.updated_ms > cutoff) {
      out[k] = v;
    } else {
      changed = true;
    }
  }
  return changed ? out : d;
}

// gridPanels holds two kinds of entries: real session ids (for sidebar-
// pinned tiles) and "new:uuid:ts" placeholders (for tiles created via
// "+ new panel"). Once a placeholder's subprocess reports its real
// session id, the mapping lives in panelSessionIds — we keep the
// placeholder as the React key so the LivePanel doesn't remount.
//
// These two helpers centralize the "which session does this panel
// represent?" / "is this session already pinned in the grid?" queries
// so call sites don't have to know the placeholder convention.

/** Resolve a panel key to the session id it represents, or undefined
 *  if the panel is a placeholder whose subprocess hasn't reported yet. */
export function resolvePanelSession(
  panelId: string,
  panelSessionIds: Record<string, string>,
): string | undefined {
  if (!panelId.startsWith("new:")) return panelId;
  return panelSessionIds[panelId];
}

/** Return the panel key whose resolved session id matches `sid`, or
 *  undefined if no panel in the grid represents that session. Checks
 *  both direct entries and placeholder mappings so dup detection works
 *  whether the tile was pinned from the sidebar or started via +new. */
export function findPanelForSession(
  sid: string,
  panels: string[],
  panelSessionIds: Record<string, string>,
): string | undefined {
  for (const p of panels) {
    if (resolvePanelSession(p, panelSessionIds) === sid) return p;
  }
  return undefined;
}

export function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

// Fire a native OS notification when a turn finishes, but only if the
// window isn't already focused (no point interrupting the user who's
// watching the transcript). First call lazily requests permission;
// subsequent calls skip the IPC if the user ever denied.
let notificationPermissionState: "unknown" | "granted" | "denied" = "unknown";
export async function notifyTurnComplete(opts: {
  title: string;
  body: string;
  isError?: boolean;
}) {
  if (!isTauriRuntime()) return;
  if (!loadAppSettings().notifyOnTurnComplete) return;
  if (typeof document !== "undefined" && document.hasFocus()) return;
  if (notificationPermissionState === "denied") return;
  try {
    if (notificationPermissionState === "unknown") {
      const granted = await isPermissionGranted();
      if (!granted) {
        const res = await requestPermission();
        notificationPermissionState = res === "granted" ? "granted" : "denied";
      } else {
        notificationPermissionState = "granted";
      }
    }
    if (notificationPermissionState !== "granted") return;
    await sendNotification({
      title: opts.isError ? `Claude error — ${opts.title}` : opts.title,
      body: opts.body.slice(0, 240),
    });
  } catch (e) {
    // If the plugin bails (permission revoked mid-session, etc.) we
    // don't want to keep hammering it.
    notificationPermissionState = "denied";
    console.error("notifyTurnComplete failed:", e);
  }
}

// Convert a transcript's Entry[] into a markdown string suitable for
// saving / sharing. Assistant text blocks are written verbatim (they're
// already markdown); tool uses and tool results are rendered as fenced
// code blocks with the tool name for context. Ephemeral system lines
// are dropped to keep the export clean.
export function sessionEntriesToMarkdown(
  entries: Entry[],
  header: {
    title?: string;
    sessionId?: string;
    model?: string;
    cwd?: string;
  },
): string {
  const lines: string[] = [];
  const meta = [
    header.title ? `# ${header.title}` : undefined,
    "",
    header.sessionId ? `- session: \`${header.sessionId}\`` : undefined,
    header.model ? `- model: \`${header.model}\`` : undefined,
    header.cwd ? `- project: \`${header.cwd}\`` : undefined,
  ].filter((x): x is string => typeof x === "string");
  if (meta.length > 0) {
    lines.push(...meta, "");
  }
  for (const e of entries) {
    if (e.kind === "user") {
      lines.push("## You", "", e.text.trim(), "");
    } else if (e.kind === "assistant") {
      lines.push("## Claude", "");
      for (const b of e.blocks) {
        if (b.type === "text") {
          const t = (b as TextBlock).text ?? "";
          if (t.trim()) lines.push(t.trim(), "");
        } else if (b.type === "thinking") {
          const t = (b as ThinkingBlock).thinking ?? "";
          if (t.trim()) {
            lines.push("<details><summary>thinking</summary>", "", t.trim(), "", "</details>", "");
          }
        } else if (b.type === "tool_use") {
          const tu = b as ToolUseBlock;
          const name = tu.name || "tool";
          let inputStr = "";
          try {
            inputStr = JSON.stringify(tu.input ?? {}, null, 2);
          } catch {
            inputStr = String(tu.input ?? "");
          }
          lines.push(`### tool: ${name}`, "", "```json", inputStr, "```", "");
        }
      }
    } else if (e.kind === "tool_result") {
      const content = e.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .map((p) => (p.type === "text" ? p.text ?? "" : ""))
              .join("\n");
      if (text.trim()) {
        lines.push(
          `#### result${e.isError ? " (error)" : ""}`,
          "",
          "```",
          text.trim(),
          "```",
          "",
        );
      }
    } else if (e.kind === "computer_use") {
      const text = stripAnsi(e.output).trim();
      if (text) {
        lines.push("## Computer Use", "", "```text", text, "```", "");
      }
    }
    // Skip `system` and `result` marker lines — they're UI-only noise.
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Heuristic: does this assistant text look like it's asking the user a
// yes/no question? Used to render quick-reply buttons above the composer
// so the user can answer with one click. Stays loose — false positives
// are cheap (clicking "yes" still sends a sensible message) and false
// negatives just mean no buttons appear.
export function looksLikeYesNoQuestion(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.endsWith("?")) return false;
  // Take just the final sentence — earlier question marks in the body
  // (e.g. quoting the user) don't tell us about the *current* ask.
  const parts = t.split(/(?<=[.!?])\s+/);
  const last = (parts[parts.length - 1] || t).toLowerCase().trim();
  const stripped = last.replace(/^[\s"'*_`>-]+/, "");
  const leads =
    /^(should|do|does|did|can|could|will|would|shall|is|are|was|were|have|has|had|may|might|want|ready|ok|okay|sound)\b/;
  const phrases =
    /\b(want me to|shall i|should i|do you want|would you like|make sense|sound good|sound right|sound okay|sound ok|that (ok|okay|good)|go ahead)\b/;
  return leads.test(stripped) || phrases.test(last);
}

function truncateForHandoff(text: string, max = 1600): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 32).trimEnd()}\n[truncated]`;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function needsComputerUseEnablement(output: string): boolean {
  const text = stripAnsi(output).toLowerCase();
  return (
    text.includes("computer-use") &&
    (text.includes("not enabled") ||
      text.includes("enable the built-in computer-use") ||
      text.includes("don't see computer-use") ||
      text.includes("do not see computer-use") ||
      text.includes("no computer-use") ||
      text.includes("run /mcp"))
  );
}

function buildAttachmentBody(
  text: string,
  attachments: Array<{ id: string; path: string }>,
): string {
  const attachList = attachments.map((a) => `- ${a.path}`).join("\n");
  return attachments.length > 0
    ? `${text || "(see attached files)"}\n\n[Attached files]\n${attachList}`
    : text;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assistantTextForHandoff(blocks: Block[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text ?? "")
    .filter((text) => text.trim())
    .join("\n\n");
}

function buildComputerUseHandoffText(
  entries: Entry[],
  opts: {
    cwd: string;
    sessionId?: string;
    model?: string;
    composerText?: string;
  },
): string {
  const recent = entries
    .filter((e) => e.kind === "user" || e.kind === "assistant")
    .slice(-6);
  const lines: string[] = [
    "Continue this task from Blackcrab in interactive Claude Code.",
    "Use computer use only when the task needs direct GUI interaction, such as native apps, simulators, system dialogs, or tools without a CLI/API.",
    "For browser/search tasks, use WebSearch or the Claude-in-Chrome integration; Safari is read-only for computer use and should not be driven with mouse/keyboard.",
    "If computer-use is not enabled yet, ask me to run /mcp and enable the built-in computer-use server before proceeding.",
    "",
    `Project: ${opts.cwd || "(unknown)"}`,
  ];
  if (opts.sessionId) lines.push(`Blackcrab session: ${opts.sessionId}`);
  if (opts.model) lines.push(`Model shown in Blackcrab: ${opts.model}`);
  if (opts.composerText?.trim()) {
    lines.push("", "Current composer draft:", truncateForHandoff(opts.composerText));
  }
  if (recent.length) {
    lines.push("", "Recent Blackcrab context:");
    for (const entry of recent) {
      if (entry.kind === "user") {
        lines.push(`User: ${truncateForHandoff(entry.text, 900)}`);
      } else {
        const text = assistantTextForHandoff(entry.blocks);
        if (text.trim()) {
          lines.push(`Claude: ${truncateForHandoff(text, 900)}`);
        }
      }
    }
  }
  return lines.join("\n");
}

// Heuristic: match the couple of ways the claude CLI surfaces a bad
// credential — stderr prefix, stringified API error JSON, or the plain
// 401 message. Kept loose on purpose since we can't rely on exact wording
// across CLI versions.
export function isAuthErrorText(text: string): boolean {
  if (!text) return false;
  const s = text.toLowerCase();
  return (
    s.includes("authentication_error") ||
    s.includes("failed to authenticate") ||
    s.includes("invalid authentication credentials") ||
    (s.includes("401") && s.includes("auth"))
  );
}

// Module-level cache keyed by cwd. `undefined` = not yet queried.
const githubRepoCache = new Map<string, string>();

async function getGithubRepo(cwd: string): Promise<string> {
  if (!cwd) return "";
  if (!isTauriRuntime()) return "";
  const cached = githubRepoCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const repo = await invoke<string>("git_remote_url", { cwd });
    githubRepoCache.set(cwd, repo || "");
    return repo || "";
  } catch {
    githubRepoCache.set(cwd, "");
    return "";
  }
}

export function buildHistory(
  events: Array<Record<string, unknown>>,
  repo?: string,
  opts: { precompileMarkdown?: boolean } = {},
): {
  entries: Entry[];
  toolUseMap: Map<string, ToolMeta>;
} {
  const entries: Entry[] = [];
  const toolUseMap = new Map<string, ToolMeta>();
  const precompileMarkdown = opts.precompileMarkdown !== false;
  const markdownRepo = repo || undefined;
  // De-dup assistant entries: stored sessions can contain multiple rows with
  // the same message id (retries, continued turns). Keep the latest.
  const msgIdToIdx = new Map<string, number>();

  for (const ev of events) {
    const t = (ev.type as string) ?? "";
    if (REPLAY_SKIP.has(t)) continue;

    if (t === "assistant") {
      const msg = ev.message as { id?: string; content?: Block[] } | undefined;
      const msgId = msg?.id ?? randomId();
      const blocks = (msg?.content ?? []).map((b): Block => {
        if (b.type === "text") {
          const tb = b as TextBlock;
          return {
            ...tb,
            _repo: markdownRepo,
            _html: precompileMarkdown
              ? compileMarkdown(tb.text ?? "", repo)
              : undefined,
          };
        }
        if (b.type === "thinking") {
          const thb = b as ThinkingBlock;
          return {
            ...thb,
            _repo: markdownRepo,
            _html: precompileMarkdown
              ? compileMarkdown(thb.thinking ?? "", repo)
              : undefined,
          };
        }
        return b;
      });
      for (const b of blocks) {
        if (b.type === "tool_use") {
          const tu = b as ToolUseBlock;
          if (tu.id && tu.name) {
            toolUseMap.set(tu.id, { name: tu.name, input: tu.input });
          }
        }
      }
      const entry: Entry = { kind: "assistant", id: msgId, blocks };
      const existingIdx = msgIdToIdx.get(msgId);
      if (existingIdx !== undefined) {
        entries[existingIdx] = entry;
      } else {
        msgIdToIdx.set(msgId, entries.length);
        entries.push(entry);
      }
      continue;
    }

    if (t === "user") {
      const msg = ev.message as { content?: string | Block[] } | undefined;
      const content = msg?.content;
      if (typeof content === "string") {
        if (content.trim()) {
          entries.push({ kind: "user", id: randomId(), text: content });
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const b of content) {
          if (b.type === "text") {
            const text = (b as TextBlock).text ?? "";
            if (text) textParts.push(text);
          } else if (b.type === "tool_result") {
            const tr = b as ToolResultBlock;
            entries.push({
              kind: "tool_result",
              id: randomId(),
              toolUseId: tr.tool_use_id,
              content: tr.content,
              isError: tr.is_error,
            });
          }
        }
        if (textParts.length) {
          entries.push({
            kind: "user",
            id: randomId(),
            text: textParts.join("\n"),
          });
        }
      }
      continue;
    }

    if (t === "result") {
      const cost =
        (ev.total_cost_usd as number | undefined) != null
          ? ` • $${(ev.total_cost_usd as number).toFixed(4)}`
          : "";
      const dur =
        (ev.duration_ms as number | undefined) != null
          ? ` • ${((ev.duration_ms as number) / 1000).toFixed(1)}s`
          : "";
      entries.push({
        kind: "result",
        id: randomId(),
        text: `${(ev.subtype as string) ?? "done"}${cost}${dur}`,
        isError: ev.is_error as boolean | undefined,
      });
      continue;
    }
  }

  return { entries, toolUseMap };
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Stable-handler hook (a userland approximation of React's experimental
// useEffectEvent). Returns a callback whose identity never changes but
// whose body always sees the latest closure. Lets us pass handlers into
// React.memo'd children without busting their memo on every parent
// re-render.
function useEvent<A extends unknown[], R>(
  handler: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(handler);
  ref.current = handler;
  return useCallback((...args: A) => ref.current(...args), []);
}

// Promise-flavored requestIdleCallback. Falls back to a setTimeout
// macrotask in environments without native ric (older WebKit). Used to
// yield to the browser between background work units so user input
// doesn't queue up behind them.
function ric(timeout = 500): Promise<void> {
  return new Promise((resolve) => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(() => resolve(), { timeout });
    } else {
      setTimeout(resolve, 1);
    }
  });
}

function App() {
  const [appSettings, setAppSettings] = useState<AppSettings>(() =>
    loadAppSettings(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cwd, setCwd] = useState<string>(() => appSettings.startupCwd);
  const [model, setModel] = useState<string>(() => appSettings.defaultModel);
  const [permissionMode, setPermissionMode] = useState<string>(
    () => appSettings.defaultPermissionMode,
  );
  const [sessionOn, setSessionOn] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<{
    sessionId?: string;
    model?: string;
    cwd?: string;
    tools?: string[];
  } | null>(null);
  const [input, setInput] = useState("");
  // @file autocomplete state. Populated from git ls-files for the
  // current cwd; a lightweight case-insensitive substring match powers
  // the dropdown.
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const fileMentionsCwdRef = useRef<string>("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [attachments, setAttachments] = useState<{ id: string; path: string }[]>(
    [],
  );
  const [pendingPermission, setPendingPermission] =
    useState<PermissionRequest | null>(null);
  // In `claude -p` mode, claude doesn't delegate permissions via
  // control_request — it just auto-denies the tool and reports it in
  // the result event's `permission_denials` array. We surface those so
  // the user can flip the session to bypassPermissions and retry.
  const [pendingDenials, setPendingDenials] = useState<
    Array<{ tool_name: string; tool_input?: unknown }> | null
  >(null);
  // Modal state for the worktree-opt-in prompt. We used to call
  // window.confirm, but Tauri v2 webviews route it through the
  // dialog plugin and the capability blocks it — it was silently
  // returning truthy, enabling --worktree on non-git dirs and killing
  // the subprocess. A custom modal is both more reliable and nicer.
  const [worktreePrompt, setWorktreePrompt] = useState<{
    cwd: string;
    resolve: (choice: boolean | null) => void;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Once the user has opened the terminal panel at least once, we keep
  // its DOM mounted across toggles so the shells (and their scrollback,
  // running processes, edit history) survive close-and-reopen. Before
  // the first open we avoid paying the xterm + PTY cost.
  const [terminalMounted, setTerminalMounted] = useState(false);
  useEffect(() => {
    if (terminalOpen) setTerminalMounted(true);
  }, [terminalOpen]);
  // Per-terminal-tab state. Each entry's id becomes its PTY id; tabs
  // are unmounted when closed, killing their shells.
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>(() => [
    { id: `term-${randomId()}`, label: "1", kind: "shell" },
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>(
    () => `term-${randomId()}`,
  );
  // Keep activeTerminalId valid when tabs change.
  useEffect(() => {
    if (terminalTabs.length === 0) return;
    if (!terminalTabs.find((t) => t.id === activeTerminalId)) {
      setActiveTerminalId(terminalTabs[0].id);
    }
  }, [terminalTabs, activeTerminalId]);
  // Initialize active to the first tab on first mount.
  useEffect(() => {
    setActiveTerminalId(terminalTabs[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const saved = localStorage.getItem("terminalHeight");
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) ? Math.max(120, Math.min(900, n)) : 320;
  });
  useEffect(() => {
    localStorage.setItem("terminalHeight", String(terminalHeight));
  }, [terminalHeight]);
  const onTerminalResizerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = terminalHeight;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.body.dataset.resizing = "true";
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;cursor:row-resize;";
      document.body.appendChild(overlay);
      const move = (ev: PointerEvent) => {
        const dy = startY - ev.clientY;
        setTerminalHeight(Math.max(120, Math.min(900, startH + dy)));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        delete document.body.dataset.resizing;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [terminalHeight],
  );
  function addTerminalTab() {
    const id = `term-${randomId()}`;
    setTerminalTabs((prev) => {
      // Pick the next unused integer so fresh tabs default to a label
      // that doesn't collide with anything the user has renamed.
      const used = new Set(prev.map((t) => t.label));
      let n = prev.length + 1;
      while (used.has(String(n))) n++;
      return [...prev, { id, label: String(n) }];
    });
    setActiveTerminalId(id);
  }
  function closeTerminalTab(id: string) {
    // Preserve user-chosen labels on the remaining tabs — no renumber.
    setTerminalTabs((prev) => prev.filter((t) => t.id !== id));
  }
  function renameTerminalTab(id: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setTerminalTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, label: trimmed } : t)),
    );
  }
  const [editingTerminalTabId, setEditingTerminalTabId] = useState<
    string | null
  >(null);
  // Remember the most recent user message so "allow and retry" can
  // replay it after upgrading permission mode.
  const lastUserMessageRef = useRef<string>("");
  const [dragOver, setDragOver] = useState(false);
  // Set when we detect the claude CLI is running with bad credentials
  // (expired OAuth token, stale API key). Renders a blocking modal that
  // tells the user to re-auth and restart — the CLI only reloads its
  // auth file at startup.
  const [authErrorSeen, setAuthErrorSeen] = useState(false);
  const [claudePreflight, setClaudePreflight] =
    useState<ClaudePreflight | null>(null);
  const [claudePreflightLoading, setClaudePreflightLoading] = useState(true);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingForced, setOnboardingForced] = useState(false);
  const [availableUpdate, setAvailableUpdate] =
    useState<AvailableUpdate | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const updateCheckingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // When busy stays true for a long time with no new entries landing,
  // surface a banner so the user can interrupt / reset instead of
  // waiting forever on a wedged subprocess.
  const [stuckBusy, setStuckBusy] = useState(false);
  const [stderrLines, setStderrLines] = useState<string[]>([]);
  const [showStderr, setShowStderr] = useState(false);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSessionId, _setActiveSessionIdState] =
    useState<string | undefined>();
  const [sidebarSelectedSessionId, setSidebarSelectedSessionId] =
    useState<string | undefined>();
  // Ref mirror of activeSessionId so setEntries (called from event
  // listener closures that captured an older id) routes the update
  // to the right transcript slot before React commits.
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const setActiveSessionId = useCallback((id: string | undefined) => {
    activeSessionIdRef.current = id;
    setSidebarSelectedSessionId(id);
    _setActiveSessionIdState(id);
  }, []);
  useEffect(() => {
    saveAppSettings(appSettings);
  }, [appSettings]);
  const updateAppSettings = useCallback((patch: Partial<AppSettings>) => {
    setAppSettings((prev) => ({ ...prev, ...patch }));
  }, []);
  useEffect(() => {
    if (activeSessionId || sessionOn) return;
    setModel(appSettings.defaultModel);
  }, [appSettings.defaultModel, activeSessionId, sessionOn]);
  useEffect(() => {
    if (activeSessionId || sessionOn) return;
    setPermissionMode(appSettings.defaultPermissionMode);
  }, [appSettings.defaultPermissionMode, activeSessionId, sessionOn]);
  // Keep-alive map of recent sessions' transcripts. Holds the ACTIVE
  // session's live entries as well as a handful of recent inactive ones
  // so switching back to them is instant — no DOM teardown cost. Capped
  // at MAX_KEPT; oldest inactive gets evicted when exceeded.
  const MAX_KEPT = 4;
  const NEW_SESSION_KEY = "__new__";
  const [allTranscripts, setAllTranscripts] = useState<Map<string, Entry[]>>(
    () => new Map([[NEW_SESSION_KEY, []]]),
  );
  const entries = useMemo(
    () => allTranscripts.get(activeSessionId ?? NEW_SESSION_KEY) ?? [],
    [allTranscripts, activeSessionId],
  );
  // Watchdog: flip `stuckBusy` to true if busy stays true for 30s
  // without a new entry landing. Resets every time entries change.
  useEffect(() => {
    if (!busy) {
      setStuckBusy(false);
      return;
    }
    const handle = window.setTimeout(() => setStuckBusy(true), 30_000);
    return () => window.clearTimeout(handle);
  }, [busy, entries.length, activeSessionId]);
  const setEntries = useCallback(
    (update: Entry[] | ((prev: Entry[]) => Entry[])) => {
      setAllTranscripts((prev) => {
        const id = activeSessionIdRef.current ?? NEW_SESSION_KEY;
        const current = prev.get(id) ?? [];
        const newVal =
          typeof update === "function"
            ? (update as (p: Entry[]) => Entry[])(current)
            : update;
        if (newVal === current) return prev;
        const next = new Map(prev);
        next.set(id, newVal);
        return next;
      });
    },
    [],
  );
  const updateEntryInTranscript = useCallback(
    (
      transcriptId: string,
      entryId: string,
      updater: (entry: Entry) => Entry,
    ) => {
      setAllTranscripts((prev) => {
        const current = prev.get(transcriptId);
        if (!current) return prev;
        let changed = false;
        const nextEntries = current.map((entry) => {
          if (entry.id !== entryId) return entry;
          changed = true;
          return updater(entry);
        });
        if (!changed) return prev;
        const next = new Map(prev);
        next.set(transcriptId, nextEntries);
        return next;
      });
    },
    [],
  );
  const computerUseWorkersRef = useRef<
    Map<string, { entryId: string; transcriptId: string }>
  >(new Map());
  const activeTerminalTab = useMemo(
    () => terminalTabs.find((t) => t.id === activeTerminalId) ?? null,
    [terminalTabs, activeTerminalId],
  );
  const openComputerUseSession = useEvent(
    (opts: { handoff?: boolean } = {}) => {
      const handoffText = opts.handoff
        ? buildComputerUseHandoffText(entries, {
            cwd,
            sessionId: activeSessionId,
            model: sessionMeta?.model || model,
            composerText: input,
          })
        : undefined;

      if (!handoffText) {
        const existing = terminalTabs.find((t) => t.kind === "computer-use");
        if (existing) {
          setActiveTerminalId(existing.id);
          setTerminalOpen(true);
          setTerminalHeight((h) => Math.max(h, 360));
          return;
        }
      }

      const id = `term-cu-${randomId()}`;
      const tab: TerminalTab = {
        id,
        label: handoffText ? "computer-handoff" : "computer-use",
        kind: "computer-use",
        initialWrites: [
          { id: "start-claude", data: "claude\r", delayMs: 250 },
          ...(handoffText
            ? [
                {
                  id: "handoff",
                  data: `${handoffText}\r`,
                  delayMs: 2600,
                },
              ]
            : []),
        ],
        handoffText,
        handoffAutoQueued: !!handoffText,
      };
      setTerminalTabs((prev) => [...prev, tab]);
      setActiveTerminalId(id);
      setTerminalOpen(true);
      setTerminalHeight((h) => Math.max(h, 360));
    },
  );
  const sendComputerUseHandoff = useEvent((tab: TerminalTab) => {
    if (!tab.handoffText) return;
    invoke("terminal_write", {
      terminalId: tab.id,
      data: `${tab.handoffText}\r`,
    })
      .then(() => {
        setTerminalTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id ? { ...t, handoffSent: true } : t,
          ),
        );
      })
      .catch(notifyErr("failed to send handoff"));
  });
  const openComputerUseMcpMenu = useEvent((tab: TerminalTab) => {
    invoke("terminal_write", {
      terminalId: tab.id,
      data: "/mcp\r",
    }).catch(notifyErr("failed to open MCP menu"));
  });
  const onTerminalInitialWrite = useEvent(
    (tabId: string, write: TerminalInitialWrite) => {
      if (write.id !== "handoff") return;
      setTerminalTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, handoffSent: true } : t,
        ),
      );
    },
  );
  const updateComputerUseEntry = useCallback(
    (
      terminalId: string,
      updater: (
        entry: Extract<Entry, { kind: "computer_use" }>,
      ) => Extract<Entry, { kind: "computer_use" }>,
    ) => {
      const worker = computerUseWorkersRef.current.get(terminalId);
      if (!worker) return;
      updateEntryInTranscript(worker.transcriptId, worker.entryId, (entry) =>
        entry.kind === "computer_use" ? updater(entry) : entry,
      );
    },
    [updateEntryInTranscript],
  );
  useEffect(() => {
    computerUseControlsRef.current = {
      send: (terminalId, data) => {
        invoke("terminal_write", { terminalId, data }).catch(
          notifyErr("computer-use input failed"),
        );
      },
      stop: (terminalId) => {
        invoke("terminal_kill", { terminalId }).catch(() => {});
        updateComputerUseEntry(terminalId, (entry) => ({
          ...entry,
          status: "done",
        }));
      },
    };
    return () => {
      computerUseControlsRef.current = null;
    };
  }, [updateComputerUseEntry]);
  useEffect(() => {
    const pending: Promise<() => void>[] = [
      listen<{ terminal_id: string; data: string }>("terminal-output", (e) => {
        const terminalId = e.payload?.terminal_id;
        if (!terminalId?.startsWith("cu-inline-")) return;
        const data = e.payload?.data ?? "";
        updateComputerUseEntry(terminalId, (entry) => {
          const output = `${entry.output}${data}`;
          return {
            ...entry,
            status: entry.status === "starting" ? "running" : entry.status,
            output:
              output.length > 120_000
                ? output.slice(output.length - 120_000)
                : output,
          };
        });
      }),
      listen<{ terminal_id: string }>("terminal-exit", (e) => {
        const terminalId = e.payload?.terminal_id;
        if (!terminalId?.startsWith("cu-inline-")) return;
        updateComputerUseEntry(terminalId, (entry) => ({
          ...entry,
          status: entry.status === "error" ? entry.status : "done",
        }));
        computerUseWorkersRef.current.delete(terminalId);
      }),
    ];
    return () => {
      for (const p of pending) {
        p.then((u) => u()).catch(() => {});
      }
    };
  }, [updateComputerUseEntry]);
  const startInlineComputerUse = useEvent(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const body = buildAttachmentBody(text, attachments);
    const handoffText = buildComputerUseHandoffText(entries, {
      cwd,
      sessionId: activeSessionId,
      model: sessionMeta?.model || model,
      composerText: body,
    });
    const terminalId = `cu-inline-${randomId()}`;
    const entryId = `cu-entry-${randomId()}`;
    const transcriptId = activeSessionIdRef.current ?? NEW_SESSION_KEY;
    computerUseWorkersRef.current.set(terminalId, { entryId, transcriptId });

    setInput("");
    setAttachments([]);
    setMentionQuery(null);
    lastUserMessageRef.current = body;
    setEntries((es) => [
      ...es,
      { kind: "user", id: randomId(), text: body },
      {
        kind: "computer_use",
        id: entryId,
        terminalId,
        title: "Computer use",
        output: "",
        status: "starting",
      },
    ]);
    setStuckToBottom(true);
    setHasNewBelow(false);

    try {
      await invoke("terminal_spawn", {
        terminalId,
        cwd,
        cols: 120,
        rows: 40,
      });
      updateComputerUseEntry(terminalId, (entry) => ({
        ...entry,
        status: "running",
      }));
      await invoke("terminal_write", {
        terminalId,
        data: `claude ${shellQuote(handoffText)}\r`,
      });
    } catch (e) {
      updateComputerUseEntry(terminalId, (entry) => ({
        ...entry,
        status: "error",
        error: String(e),
      }));
      notifyErr("computer-use failed")(e);
    }
  });
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [sessionSearch, setSessionSearch] = useState<string>("");
  const [groupByProject, setGroupByProject] = useState<boolean>(() => {
    return localStorage.getItem("sidebar.groupByProject") === "1";
  });
  useEffect(() => {
    localStorage.setItem("sidebar.groupByProject", groupByProject ? "1" : "0");
  }, [groupByProject]);
  const [gridMode, setGridMode] = useState<boolean>(() => {
    return localStorage.getItem("gridMode") === "1";
  });
  const [gridPanels, setGridPanels] = useState<string[]>(() => {
    const saved = localStorage.getItem("gridPanels");
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved) as unknown;
      if (Array.isArray(parsed))
        return parsed.filter((v): v is string => typeof v === "string").slice(0, 6);
    } catch {}
    return [];
  });
  // Panels that don't correspond to an existing session yet — they come
  // from the "+ new panel" button and carry a user-picked cwd until a
  // session is spawned on first message. Keyed by synthetic panel id.
  // Parallel to newPanelCwds: whether a given new panel should spawn
  // claude with --worktree so it gets its own isolated git working
  // directory. Only meaningful on first spawn; claude creates the
  // worktree itself and subsequent --resume calls just use its cwd.
  const [newPanelWorktree, setNewPanelWorktree] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem("newPanelWorktree");
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem("newPanelWorktree", JSON.stringify(newPanelWorktree));
  }, [newPanelWorktree]);
  const [newPanelCwds, setNewPanelCwds] = useState<Record<string, string>>(
    () => {
      const saved = localStorage.getItem("newPanelCwds");
      if (!saved) return {};
      try {
        const parsed = JSON.parse(saved) as unknown;
        if (parsed && typeof parsed === "object")
          return parsed as Record<string, string>;
      } catch {}
      return {};
    },
  );
  useEffect(() => {
    localStorage.setItem("newPanelCwds", JSON.stringify(newPanelCwds));
  }, [newPanelCwds]);
  const [selectedGridPanelId, setSelectedGridPanelId] = useState<string | null>(
    null,
  );
  // Defer eviction of old kept-alive transcripts to idle time so the
  // click that pushed the map over the cap doesn't pay the teardown
  // cost of the slot we're evicting.
  useEffect(() => {
    if (allTranscripts.size <= MAX_KEPT) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const schedule = w.requestIdleCallback
      ? (cb: () => void) => w.requestIdleCallback!(cb, { timeout: 2000 })
      : (cb: () => void) => window.setTimeout(cb, 200);
    const cancel = w.cancelIdleCallback ?? window.clearTimeout;
    const handle = schedule(() => {
      setAllTranscripts((prev) => {
        if (prev.size <= MAX_KEPT) return prev;
        const id = activeSessionIdRef.current ?? NEW_SESSION_KEY;
        const next = new Map(prev);
        for (const k of Array.from(next.keys())) {
          if (next.size <= MAX_KEPT) break;
          if (k === id || k === NEW_SESSION_KEY) continue;
          next.delete(k);
        }
        return next;
      });
    });
    return () => cancel(handle as number);
  }, [allTranscripts]);
  // Maps a grid panel key (which may be a "new:..." placeholder) to the
  // real session id reported by the subprocess's first init event. Without
  // this, the topbar sync below can't find the session info for freshly
  // started panels because their panel key never matches a session id.
  const [panelSessionIds, setPanelSessionIds] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    if (!gridMode) return;
    if (gridPanels.length === 0) {
      if (selectedGridPanelId !== null) setSelectedGridPanelId(null);
      return;
    }
    if (!selectedGridPanelId || !gridPanels.includes(selectedGridPanelId)) {
      setSelectedGridPanelId(gridPanels[0]);
    }
  }, [gridMode, gridPanels, selectedGridPanelId]);

  // On entering grid mode with nothing pinned, drop the current
  // single-mode session into slot 0 so the conversation doesn't
  // disappear behind an empty-grid hint. Only fires on the off→on
  // transition — if the user removes the last panel later we honor
  // their intent and leave the grid empty.
  //
  // Hand off ownership: stop the "main" subprocess and clear the
  // single-mode session state before seeding. Otherwise the grid
  // LivePanel's start_session would be rejected by the single-writer
  // gate (main still holds this sid). The user trades "seamless return
  // to single-mode" for "no divergent JSONL appends" — any return from
  // grid leaves them in an empty single-mode they can re-populate from
  // the sidebar.
  const prevGridModeRef = useRef(gridMode);
  useEffect(() => {
    const entering = gridMode && !prevGridModeRef.current;
    prevGridModeRef.current = gridMode;
    if (entering && gridPanels.length === 0 && activeSessionId) {
      const handoffSid = activeSessionId;
      invoke("stop_session", { panelId: "main" }).catch(() => {});
      setSessionOn(false);
      setActiveSessionId(undefined);
      setGridPanels([handoffSid]);
      setSelectedGridPanelId(handoffSid);
    }
  }, [gridMode, gridPanels.length, activeSessionId]);

  // In grid mode, the topbar mirrors whichever panel is currently selected
  // so cwd/branch/model/permissions stay in sync with what the user is
  // looking at. Nothing here touches the main-session subprocess.
  useEffect(() => {
    if (!gridMode || !selectedGridPanelId) return;
    const realId =
      resolvePanelSession(selectedGridPanelId, panelSessionIds) ??
      selectedGridPanelId;
    const info = sessions.find((s) => s.id === realId);
    if (info) {
      if (info.cwd) setCwd(info.cwd);
      if (info.model) setModel(info.model);
      if (info.permission_mode) setPermissionMode(info.permission_mode);
      return;
    }
    // New panel that hasn't reported a session id yet (or the sessions
    // list hasn't refreshed). Pull the cwd the user picked at creation
    // so the topbar at least reflects where this panel will run.
    const pendingCwd = newPanelCwds[selectedGridPanelId];
    if (pendingCwd) setCwd(pendingCwd);
  }, [gridMode, selectedGridPanelId, sessions, panelSessionIds, newPanelCwds]);
  useEffect(() => {
    localStorage.setItem("gridMode", gridMode ? "1" : "0");
  }, [gridMode]);
  useEffect(() => {
    localStorage.setItem("gridPanels", JSON.stringify(gridPanels));
  }, [gridPanels]);


  // ⌘K / Ctrl+K opens the command palette; ⌘J / Ctrl+J toggles the
  // integrated terminal panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setTerminalOpen((v) => !v);
      } else if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        (e.key === "f" || e.key === "F")
      ) {
        // In-transcript find. Only scope to single-mode for now — grid
        // mode has multiple transcripts and would need per-panel wiring.
        // Browser's native find is intercepted by the WKWebView, so we
        // implement our own.
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Grid-scoped keyboard shortcuts. Only fire when gridMode is on and
  // focus isn't captured by an editable (composer, title input, etc.),
  // so typing "1" into a message body doesn't jump panels.
  //   ⌘1..6 / Ctrl+1..6  → focus panel N (1-indexed)
  //   ⌘⇧W / Ctrl+⇧W      → close focused panel (⌘W alone collides with
  //                        macOS's "close window" menu item)
  //   ⌘⇧D / Ctrl+⇧D      → duplicate focused panel (new tile in same cwd)
  useEffect(() => {
    if (!gridMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable)
      ) {
        return;
      }
      if (gridPanels.length === 0) return;

      if (/^[1-6]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < gridPanels.length) {
          e.preventDefault();
          setSelectedGridPanelId(gridPanels[idx]);
        }
        return;
      }

      if (e.shiftKey && (e.key === "w" || e.key === "W")) {
        if (!selectedGridPanelId) return;
        e.preventDefault();
        const id = selectedGridPanelId;
        setGridPanels((prev) => prev.filter((x) => x !== id));
        setNewPanelCwds((m) => {
          if (!(id in m)) return m;
          const next = { ...m };
          delete next[id];
          return next;
        });
        setNewPanelWorktree((m) => {
          if (!(id in m)) return m;
          const next = { ...m };
          delete next[id];
          return next;
        });
        setPanelSessionIds((m) => {
          if (!(id in m)) return m;
          const next = { ...m };
          delete next[id];
          return next;
        });
        return;
      }

      if (e.shiftKey && (e.key === "d" || e.key === "D")) {
        if (!selectedGridPanelId) return;
        if (gridPanels.length >= 6) return;
        // Duplicate reuses the focused panel's cwd + worktree flag so the
        // new tile starts in the same project without a dir prompt.
        // Always a fresh session (no resume_id) — single-writer would
        // reject attaching a second subprocess to the same sid anyway.
        const info = sessions.find((s) => s.id === selectedGridPanelId);
        const sourceCwd =
          newPanelCwds[selectedGridPanelId] ?? info?.cwd ?? cwd;
        if (!sourceCwd) return;
        e.preventDefault();
        const key = `new:${randomId()}:${Date.now()}`;
        setNewPanelCwds((m) => ({ ...m, [key]: sourceCwd }));
        if (newPanelWorktree[selectedGridPanelId]) {
          setNewPanelWorktree((m) => ({ ...m, [key]: true }));
        }
        setGridPanels((prev) => [...prev, key]);
        setSelectedGridPanelId(key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    gridMode,
    gridPanels,
    selectedGridPanelId,
    sessions,
    newPanelCwds,
    newPanelWorktree,
    cwd,
  ]);

  // Listen for native drag-drop on the window — this is the reliable way
  // to get real file paths instead of just File blobs.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    let currentWebview: ReturnType<typeof getCurrentWebview>;
    try {
      currentWebview = getCurrentWebview();
    } catch {
      return;
    }
    currentWebview
      .onDragDropEvent((e) => {
        if (e.payload.type === "enter" || e.payload.type === "over") {
          setDragOver(true);
        } else if (e.payload.type === "leave") {
          setDragOver(false);
        } else if (e.payload.type === "drop") {
          setDragOver(false);
          const paths = (e.payload as { paths?: string[] }).paths ?? [];
          if (paths.length === 0) return;
          // In grid mode, route the drop to whichever tile is under
          // the cursor. Tauri reports position in physical pixels, so
          // divide by devicePixelRatio to compare against CSS coords.
          const pos = (
            e.payload as { position?: { x: number; y: number } }
          ).position;
          let routed = false;
          if (pos) {
            const dpr = window.devicePixelRatio || 1;
            const cssX = pos.x / dpr;
            const cssY = pos.y / dpr;
            const stack = document.elementsFromPoint(cssX, cssY);
            for (const el of stack) {
              const tile = el.closest(".grid-panel.live");
              if (tile) {
                tile.dispatchEvent(
                  new CustomEvent<string[]>("blackcrab:drop-files", {
                    detail: paths,
                  }),
                );
                routed = true;
                break;
              }
            }
          }
          if (routed) return;
          setAttachments((prev) => {
            const existing = new Set(prev.map((a) => a.path));
            const additions = paths
              .filter((p) => !existing.has(p))
              .map((p) => ({ id: randomId(), path: p }));
            return [...prev, ...additions];
          });
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // DOM-level file drop handler. Tauri's `onDragDropEvent` only fires
  // when `dragDropEnabled: true` in tauri.conf.json, which is off so
  // the grid panel reorder can use HTML5 drag. This catches file
  // drops via `event.dataTransfer.files`, writes the bytes to a temp
  // file via the Rust `save_dropped_file` command, and appends the
  // path to attachments. Handles images from browsers / screenshot
  // tools too since we read the Blob directly.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        setDragOver(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      // Only clear when the pointer leaves the window entirely.
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      const dropX = e.clientX;
      const dropY = e.clientY;
      const paths: string[] = [];
      for (const f of files) {
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          const p = await invoke<string>("save_dropped_file", {
            name: f.name || "dropped.bin",
            bytes: Array.from(buf),
          });
          paths.push(p);
        } catch (err) {
          console.error("save_dropped_file failed:", err);
        }
      }
      if (paths.length === 0) return;
      // Grid-mode routing: same hit-test as the old Tauri handler.
      const stack = document.elementsFromPoint(dropX, dropY);
      for (const el of stack) {
        const tile = el.closest(".grid-panel.live");
        if (tile) {
          tile.dispatchEvent(
            new CustomEvent<string[]>("blackcrab:drop-files", {
              detail: paths,
            }),
          );
          return;
        }
      }
      setAttachments((prev) => {
        const existing = new Set(prev.map((a) => a.path));
        const additions = paths
          .filter((p) => !existing.has(p))
          .map((p) => ({ id: randomId(), path: p }));
        return [...prev, ...additions];
      });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const seenUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    linkClickHandlerRef.current = (url: string) => {
      // All links open in the preview panel. If a site blocks iframing (most
      // production sites do via X-Frame-Options), the panel shows a fallback
      // prompt to open it in the system browser.
      setPreviewUrl(normalizeLocalUrl(url));
      setPreviewOpen(true);
    };
    return () => {
      linkClickHandlerRef.current = null;
    };
  }, []);

  const autoDetectUrl = useCallback((text: string) => {
    if (!appSettings.autoOpenPreview) return;
    const urls = extractLocalUrls(text);
    if (!urls.length) return;
    for (const raw of urls) {
      const u = normalizeLocalUrl(raw);
      if (!seenUrlsRef.current.has(u)) {
        seenUrlsRef.current.add(u);
        setPreviewUrl((prev) => prev || u);
        setPreviewOpen(true);
      }
    }
  }, [appSettings.autoOpenPreview]);

  const [theme, setTheme] = useState<AppTheme>(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark" || saved === "jet") return saved;
    return "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const sidebarResize = useResizable(260, 200, 520, "right", "sidebarWidth");
  const previewResize = useResizable(480, 320, 900, "left", "previewWidth");

  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  // Stub ref + callback passed to inactive kept-alive transcripts so they
  // don't touch the real scroll-tracking state meant for the active one.
  const noopScrollRef = useRef<HTMLDivElement>(null);
  const noop = useCallback(() => {}, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingIdRef = useRef<string | null>(null);
  const toolUseMapRef = useRef<Map<string, ToolMeta>>(new Map());
  // Set to true when we're deliberately stopping the current subprocess to
  // start another (new / resumed session). The claude-done event checks this
  // so it doesn't show a stale "session ended" sysline mid-switch.
  const switchingSessionRef = useRef(false);
  // Parsed-history cache: flipping back to a session you've already opened
  // is instant. Keyed by session_id; the mtime_ms from list_sessions is used
  // to invalidate when the session file has grown on disk.
  const sessionCacheRef = useRef<
    Map<
      string,
      { entries: Entry[]; toolUseMap: Map<string, ToolMeta>; mtime_ms: number }
    >
  >(new Map());
  // Tracks which resume attempt is latest so an older slow load doesn't
  // clobber a newer one if the user clicks quickly.
  const resumeTokenRef = useRef(0);
  const sidebarResumeSeqRef = useRef(0);

  // In-flight start_session promise. resumeSession kicks one off in the
  // background and stores it here; send/sendQuickReply await it before
  // dispatching send_message so the visible session click doesn't block
  // on subprocess boot. Cleared once the promise settles.
  const startPromiseRef = useRef<Promise<unknown> | null>(null);
  const transcriptScrollSeqRef = useRef(0);
  const [transcriptScrollRequest, setTranscriptScrollRequest] = useState<{
    sessionId: string;
    seq: number;
  } | null>(null);
  const requestTranscriptBottom = useCallback((sessionId: string) => {
    transcriptScrollSeqRef.current += 1;
    setTranscriptScrollRequest({
      sessionId,
      seq: transcriptScrollSeqRef.current,
    });
  }, []);
  const scrollTranscriptToBottomNow = useCallback(() => {
    const snap = () => {
      const el = transcriptScrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      setStuckToBottom(true);
      setHasNewBelow(false);
    };
    snap();
    requestAnimationFrame(() => {
      snap();
      requestAnimationFrame(snap);
    });
    window.setTimeout(snap, 80);
  }, []);

  // Mirror live single-view entries into sessionCacheRef so that flipping
  // back to grid mode shows messages typed/streamed while in single view.
  // Without this, the grid LivePanel reads a snapshot frozen at the
  // resume-time replay and looks stale.
  useEffect(() => {
    if (!activeSessionId) return;
    sessionCacheRef.current.set(activeSessionId, {
      entries,
      toolUseMap: new Map(toolUseMapRef.current),
      mtime_ms: Date.now(),
    });
  }, [entries, activeSessionId]);

  useEffect(() => {
    if (appSettings.startupCwd) {
      setCwd(appSettings.startupCwd);
      return;
    }
    if (!isTauriRuntime()) {
      setCwd("/");
      return;
    }
    invoke<string>("default_cwd").then(setCwd).catch(() => setCwd("/"));
    // Only hydrate cwd on launch. Later settings changes are applied by the
    // settings modal handlers so they don't unexpectedly move an active session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshClaudePreflight = useCallback(async () => {
    setClaudePreflightLoading(true);
    if (!isTauriRuntime()) {
      setClaudePreflight({
        installed: true,
        authenticated: true,
        version: "browser preview",
        path: "",
        auth_method: "",
        api_provider: "",
        error: "",
      });
      setClaudePreflightLoading(false);
      return;
    }
    try {
      const status = await invoke<ClaudePreflight>("claude_preflight");
      setClaudePreflight(status);
      if (status.installed && status.authenticated) {
        setOnboardingDismissed(false);
      }
    } catch (e) {
      setClaudePreflight({
        installed: false,
        authenticated: false,
        version: "",
        path: "",
        auth_method: "",
        api_provider: "",
        error:
          typeof e === "string"
            ? e
            : e instanceof Error
              ? e.message
              : String(e),
      });
    } finally {
      setClaudePreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshClaudePreflight();
  }, [refreshClaudePreflight]);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (!isTauriRuntime()) {
      if (manual) notify("Updates are checked in the desktop app", "info");
      return;
    }
    if (updateCheckingRef.current) return;
    updateCheckingRef.current = true;
    setUpdateChecking(true);
    try {
      const update = await check();
      if (update) {
        setAvailableUpdate(update);
        setUpdateDismissed(false);
        if (manual) {
          notify(`Blackcrab ${update.version} is available`, "info");
        }
      } else if (manual) {
        notify("Blackcrab is up to date", "success");
      }
    } catch (e) {
      if (manual) {
        notifyErr("update check failed")(e);
      } else {
        console.error("update check failed", e);
      }
    } finally {
      updateCheckingRef.current = false;
      setUpdateChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!appSettings.autoCheckUpdates) return;
    const t = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 2500);
    return () => window.clearTimeout(t);
  }, [appSettings.autoCheckUpdates, checkForUpdates]);

  const installAvailableUpdate = useCallback(async () => {
    if (!availableUpdate || updateInstalling) return;
    setUpdateInstalling(true);
    try {
      await availableUpdate.downloadAndInstall();
      notify("Update installed. Restarting Blackcrab...", "success");
      await relaunch();
    } catch (e) {
      setUpdateInstalling(false);
      notifyErr("update install failed")(e);
    }
  }, [availableUpdate, updateInstalling]);

  // Only flag "new content below" when the entry count grows while we
  // are NOT stuck to the bottom. Depending on stuckToBottom here would
  // create a loop with Virtuoso's atBottomStateChange callback.
  const entryCount = entries.length;
  const lastCountRef = useRef(0);
  useEffect(() => {
    if (entryCount > lastCountRef.current && !stuckToBottom) {
      setHasNewBelow(true);
    }
    lastCountRef.current = entryCount;
  }, [entryCount, stuckToBottom]);

  // When Claude starts thinking, slide to the bottom so the typing
  // indicator (and the user's just-sent message) stay in view.
  useEffect(() => {
    if (busy) {
      requestAnimationFrame(() => {
        const el = transcriptScrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [busy]);

  const refreshSessions = useCallback(async () => {
    if (!isTauriRuntime()) {
      setSessions([]);
      setSessionsLoading(false);
      return;
    }
    setSessionsLoading(true);
    try {
      const list = await invoke<SessionInfo[]>("list_sessions");
      setSessions(list);
    } catch (e) {
      notifyErr("failed to load sessions")(e);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const reorderGridPanels = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setGridPanels((prev) => {
      const i = prev.indexOf(fromId);
      const j = prev.indexOf(toId);
      if (i < 0 || j < 0) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const deleteSession = useCallback(
    (id: string, sessionCwd: string, title: string) => {
      const label = title && title !== id ? `"${title}"` : id.slice(0, 8);
      if (!window.confirm(`Move session ${label} to trash?`)) return;
      invoke("delete_session", { sessionId: id, cwd: sessionCwd })
        .then(() => {
          setSessions((prev) => prev.filter((s) => s.id !== id));
          if (activeSessionIdRef.current === id) {
            setActiveSessionId(undefined);
            setSessionOn(false);
          }
          setGridPanels((prev) => prev.filter((p) => p !== id));
          const d = loadDrafts();
          if (id in d) {
            delete d[id];
            saveDrafts(d);
          }
        })
        .catch(notifyErr("failed to delete session"));
    },
    [setActiveSessionId],
  );

  const renameSession = useCallback(
    async (id: string, sessionCwd: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        await invoke("set_session_title", {
          sessionId: id,
          cwd: sessionCwd,
          title: trimmed,
        });
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s)),
        );
      } catch (e) {
        notifyErr("failed to rename session")(e);
      }
    },
    [],
  );

  const refreshBranches = useCallback(async (targetCwd: string) => {
    if (!isTauriRuntime()) {
      setBranchInfo(null);
      return;
    }
    if (!targetCwd) {
      setBranchInfo(null);
      return;
    }
    try {
      const info = await invoke<BranchInfo>("list_branches", { cwd: targetCwd });
      setBranchInfo(info);
    } catch (e) {
      console.error("list_branches failed", e);
      setBranchInfo(null);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Composer draft persistence. Three effects:
  //   1. On mount, prune drafts older than the TTL so the store stays
  //      bounded across restarts.
  //   2. On session switch (including initial mount), save whatever is
  //      currently typed to the PREVIOUS session's key, then restore
  //      the NEW session's draft into the composer.
  //   3. On every keystroke, persist the current input under the
  //      current session's key so a crash doesn't lose work.
  useEffect(() => {
    saveDrafts(pruneDrafts(loadDrafts()));
  }, []);

  const lastDraftKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = activeSessionId ?? NEW_SESSION_KEY;
    const prevKey = lastDraftKeyRef.current;
    lastDraftKeyRef.current = key;
    if (prevKey !== null && prevKey !== key) {
      // Persist what's currently in the composer to the prior session
      // before we overwrite with the new session's draft.
      const d = loadDrafts();
      if (input) {
        d[prevKey] = { text: input, updated_ms: Date.now() };
      } else {
        delete d[prevKey];
      }
      saveDrafts(d);
    }
    const restored = loadDrafts()[key]?.text ?? "";
    // Only touch input if it actually differs — avoids a no-op render
    // and prevents stomping on a draft that's equal to what's already
    // in the composer.
    if (restored !== input) setInput(restored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  useEffect(() => {
    const key = activeSessionId ?? NEW_SESSION_KEY;
    const d = loadDrafts();
    if (input) {
      d[key] = { text: input, updated_ms: Date.now() };
    } else if (key in d) {
      delete d[key];
    } else {
      return;
    }
    saveDrafts(d);
  }, [input, activeSessionId]);

  // Prune gridPanels entries that no longer correspond to a real session
  // on disk and aren't a pending "new:..." placeholder either. Happens
  // when the user deletes a session file externally or when a stale id
  // made it into localStorage from a previous version.
  //
  // A hydration race would wipe valid pins if we pruned on the first
  // miss (list_sessions sometimes takes a tick to return the session
  // we just started), so require two consecutive misses. Entries that
  // reappear reset their miss count.
  const staleMissCountRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (sessionsLoading) return; // don't prune while the list is mid-fetch
    if (gridPanels.length === 0) return;
    const misses = staleMissCountRef.current;
    const hydrated = new Set(sessions.map((s) => s.id));
    const toDrop: string[] = [];
    const stillUnknown = new Map<string, number>();
    for (const id of gridPanels) {
      if (id in newPanelCwds) {
        misses.delete(id);
        continue;
      }
      if (hydrated.has(id)) {
        misses.delete(id);
        continue;
      }
      const n = (misses.get(id) ?? 0) + 1;
      if (n >= 2) {
        toDrop.push(id);
      } else {
        stillUnknown.set(id, n);
      }
    }
    // Keep the ref in sync: only entries still pending a decision.
    staleMissCountRef.current = stillUnknown;
    if (toDrop.length === 0) return;
    setGridPanels((prev) => prev.filter((p) => !toDrop.includes(p)));
    setPanelSessionIds((m) => {
      let changed = false;
      const next = { ...m };
      for (const id of toDrop) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : m;
    });
    setSelectedGridPanelId((cur) =>
      cur && toDrop.includes(cur) ? null : cur,
    );
  }, [sessions, sessionsLoading, gridPanels, newPanelCwds]);

  useEffect(() => {
    refreshBranches(cwd);
    // Warm the GitHub repo cache for this cwd so streaming content_block_stop
    // events can linkify PR references synchronously.
    if (cwd) getGithubRepo(cwd);
  }, [cwd, refreshBranches]);

  // Pre-warm every session's cache using the cheap tail endpoint so the
  // first click on ANY session is as instant as the second. Runs at low
  // concurrency in the background and keeps going even after the user
  // starts clicking — grid mode clicks don't touch this state, so making
  // the main-mode path behave the same way closes the speed gap between
  // the two.
  useEffect(() => {
    if (sessions.length === 0) return;
    let cancelled = false;
    // Only prewarm the most-recently-used sessions. The user has 200+
    // sessions in the sidebar and rarely clicks past the first 40 — so
    // burning markdown-compile cycles on the long tail just slows the
    // ones they actually use. sessions is already sorted by mtime desc
    // by the Rust side.
    const queue = sessions.slice(0, 30);

    const prewarmOne = async (s: SessionInfo) => {
      if (cancelled) return;
      const existing = sessionCacheRef.current.get(s.id);
      if (existing && existing.mtime_ms === s.mtime_ms) return;
      try {
        const [events, repo] = await Promise.all([
          invoke<Array<Record<string, unknown>>>("load_session_tail", {
            sessionId: s.id,
            cwd: s.cwd,
            limit: SESSION_TAIL_LIMIT,
          }),
          getGithubRepo(s.cwd),
        ]);
        if (cancelled) return;
        // buildHistory + markdown compile is the expensive part — yield
        // to the browser before it so click handlers don't block behind
        // a prewarm batch. ric() resolves when the main thread is idle.
        await ric();
        if (cancelled) return;
        const { entries, toolUseMap } = buildHistory(events, repo, {
          precompileMarkdown: false,
        });
        sessionCacheRef.current.set(s.id, {
          entries,
          toolUseMap,
          mtime_ms: s.mtime_ms,
        });
      } catch {
        // ignore — a missing/unreadable session just means no prewarm for it
      }
    };

    // Single worker (was concurrency=2). One in-flight prewarm + idle
    // gating keeps total background CPU low while the user is clicking
    // around. The prior 2-worker version produced ~500ms of synchronous
    // markdown work every ~500ms, blocking input handlers in between.
    (async () => {
      for (let i = 0; i < queue.length; i++) {
        if (cancelled) return;
        await prewarmOne(queue[i]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessions]);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setStuckToBottom((prev) => (prev === atBottom ? prev : atBottom));
    if (atBottom) setHasNewBelow(false);
  }, []);

  function scrollToBottom() {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setStuckToBottom(true);
    setHasNewBelow(false);
  }

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending: Promise<() => void>[] = [
      listen<{ panel_id: string; line: string }>("claude-event", (e) => {
        if (e.payload?.panel_id && e.payload.panel_id !== "main") return;
        const line = e.payload?.line;
        if (typeof line !== "string") return;
        try {
          const ev = JSON.parse(line) as StreamEvent;
          handleEvent(ev);
        } catch (err) {
          console.error("bad claude-event payload", err, line);
        }
      }),
      listen<{ panel_id: string; line: string }>("claude-stderr", (e) => {
        if (e.payload?.panel_id && e.payload.panel_id !== "main") return;
        const line = e.payload?.line ?? "";
        if (!line) return;
        setStderrLines((s) => [...s, line]);
        if (isAuthErrorText(line)) setAuthErrorSeen(true);
      }),
      listen<{ panel_id: string }>("claude-done", (e) => {
        if (e.payload?.panel_id && e.payload.panel_id !== "main") return;
        // Ignore the done event from a subprocess we just killed to switch
        // to another session; otherwise the transcript flickers a spurious
        // "session ended" message.
        if (switchingSessionRef.current) {
          refreshSessions();
          return;
        }
        setSessionOn(false);
        setBusy(false);
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: "session ended" },
        ]);
        refreshSessions();
      }),
    ];

    return () => {
      for (const p of pending) {
        p.then((u) => u()).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function recordToolUses(blocks: Block[]) {
    for (const b of blocks) {
      if (b.type === "tool_use") {
        const tu = b as ToolUseBlock;
        if (tu.id && tu.name) {
          toolUseMapRef.current.set(tu.id, { name: tu.name, input: tu.input });
        }
      }
    }
  }

  function handleEvent(ev: StreamEvent) {
    const any = ev as Record<string, unknown>;
    if (any.type === "control_request") {
      const req = any.request as Record<string, unknown> | undefined;
      if (req && req.subtype === "can_use_tool") {
        setPendingPermission({
          requestId: String(any.request_id ?? ""),
          toolName: String(req.tool_name ?? "unknown"),
          input: req.input,
        });
      }
      return;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      setSessionMeta({
        sessionId: ev.session_id,
        model: ev.model,
        cwd: ev.cwd,
        tools: ev.tools,
      });
      const newId = ev.session_id;
      // When the user just sent their first message, it sits in the
      // NEW_SESSION_KEY scratch slot. Fold it into the real session
      // slot now that claude has assigned an id, so it doesn't orphan
      // once the scratch slot resets.
      if (newId) {
        setAllTranscripts((prev) => {
          const scratch = prev.get(NEW_SESSION_KEY) ?? [];
          if (scratch.length === 0 && prev.has(newId)) return prev;
          const next = new Map(prev);
          const existing = next.get(newId) ?? [];
          next.set(newId, [...scratch, ...existing]);
          next.set(NEW_SESSION_KEY, []);
          return next;
        });
      }
      setActiveSessionId(newId);
      setEntries((es) => [
        ...es,
        {
          kind: "system",
          id: randomId(),
          text: `session ${newId?.slice(0, 8) ?? ""} • model ${ev.model ?? "?"} • ${ev.tools?.length ?? 0} tools`,
        },
      ]);
      // A brand-new session isn't in the sidebar until list_sessions sees
      // its freshly-created JSONL. Refresh now so it shows up immediately.
      refreshSessions();
      return;
    }

    if (ev.type === "assistant") {
      const msgId = ev.message.id;
      const repo = githubRepoCache.get(cwd) || "";
      const blocks = ev.message.content.map((b): Block => {
        if (b.type === "text") {
          const tb = b as TextBlock;
          return { ...tb, _html: compileMarkdown(tb.text ?? "", repo) };
        }
        if (b.type === "thinking") {
          const thb = b as ThinkingBlock;
          return { ...thb, _html: compileMarkdown(thb.thinking ?? "", repo) };
        }
        return b;
      });
      recordToolUses(blocks);
      for (const b of blocks) {
        if (b.type === "text") {
          autoDetectUrl((b as TextBlock).text ?? "");
        }
      }
      setEntries((es) => {
        const idx = es.findIndex(
          (x) => x.kind === "assistant" && x.id === msgId,
        );
        if (idx >= 0) {
          const next = es.slice();
          next[idx] = { kind: "assistant", id: msgId, blocks };
          return next;
        }
        return [
          ...es,
          { kind: "assistant", id: msgId || randomId(), blocks },
        ];
      });
      return;
    }

    if (ev.type === "stream_event") {
      handlePartial(ev.event);
      return;
    }

    if (ev.type === "user") {
      const content = ev.message.content;
      if (typeof content === "string") {
        if (content.trim()) {
          setEntries((es) => [
            ...es,
            { kind: "user", id: randomId(), text: content },
          ]);
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolResults: Entry[] = [];
        for (const b of content) {
          if (b.type === "text") {
            const t = (b as TextBlock).text ?? "";
            if (t) textParts.push(t);
          } else if (b.type === "tool_result") {
            const tr = b as ToolResultBlock;
            const resultText =
              typeof tr.content === "string"
                ? tr.content
                : tr.content
                    .map((p) => (p.type === "text" ? p.text ?? "" : ""))
                    .join(" ");
            autoDetectUrl(resultText);
            toolResults.push({
              kind: "tool_result",
              id: randomId(),
              toolUseId: tr.tool_use_id,
              content: tr.content,
              isError: tr.is_error,
            });
          }
        }
        if (textParts.length) {
          setEntries((es) => [
            ...es,
            { kind: "user", id: randomId(), text: textParts.join("\n") },
          ]);
        }
        if (toolResults.length) {
          setEntries((es) => [...es, ...toolResults]);
        }
      }
      return;
    }

    if (ev.type === "result") {
      setBusy(false);
      streamingIdRef.current = null;
      const cost = ev.total_cost_usd != null ? ` • $${ev.total_cost_usd.toFixed(4)}` : "";
      const dur = ev.duration_ms != null ? ` • ${(ev.duration_ms / 1000).toFixed(1)}s` : "";
      // Claude surfaces the real failure reason in one of several places
      // depending on CLI version: a top-level `error` string, or an
      // `errors` array. Read both so the user sees something actionable
      // rather than the opaque `error_during_execution`.
      const rawErr = (ev as { error?: unknown }).error;
      const rawErrs = (ev as { errors?: unknown }).errors;
      const errorDetail =
        typeof rawErr === "string"
          ? rawErr
          : Array.isArray(rawErrs)
          ? rawErrs
              .filter((s): s is string => typeof s === "string")
              .join(" • ")
          : "";
      const text =
        ev.is_error && errorDetail
          ? `error • ${errorDetail}${cost}${dur}`
          : `${ev.subtype}${cost}${dur}`;
      setEntries((es) => [
        ...es,
        { kind: "result", id: randomId(), text, isError: ev.is_error },
      ]);
      if (ev.is_error) {
        setShowStderr(true);
      }
      // Fire a native notification so the user doesn't have to watch
      // the window while a long turn runs. Uses the latest assistant
      // text as the body (first 240 chars).
      (() => {
        const info = activeSessionIdRef.current
          ? sessions.find((s) => s.id === activeSessionIdRef.current)
          : undefined;
        const title = info?.title || "Claude";
        let body = "";
        const es = allTranscripts.get(
          activeSessionIdRef.current ?? NEW_SESSION_KEY,
        );
        if (es) {
          for (let i = es.length - 1; i >= 0; i--) {
            const e = es[i];
            if (e.kind === "assistant") {
              for (const b of e.blocks) {
                if (!b) continue;
                if (b.type === "text") {
                  body = (b as TextBlock).text || "";
                  break;
                }
              }
              if (body) break;
            }
          }
        }
        if (!body) body = ev.is_error ? "turn ended with an error" : "turn complete";
        void notifyTurnComplete({ title, body, isError: !!ev.is_error });
      })();
      // claude -p auto-denies tool uses when the permission mode isn't
      // bypassPermissions; the denials show up here rather than as a
      // live control_request. Surface them so the user can approve
      // retroactively (flip to bypass + retry).
      const rawDenials = (ev as { permission_denials?: unknown })
        .permission_denials;
      if (Array.isArray(rawDenials) && rawDenials.length > 0) {
        const parsed = rawDenials
          .filter(
            (d): d is { tool_name: string; tool_input?: unknown } =>
              typeof d === "object" &&
              d !== null &&
              typeof (d as { tool_name?: unknown }).tool_name === "string",
          )
          .map((d) => ({ tool_name: d.tool_name, tool_input: d.tool_input }));
        if (parsed.length > 0) setPendingDenials(parsed);
      }
      return;
    }

    // Claude (and the CLI wrapper) can emit top-level error events when the
    // API call itself fails. Surface them clearly.
    const evAny = ev as { type?: string; error?: unknown; message?: unknown };
    if (evAny.type === "error") {
      setBusy(false);
      const errObj = evAny.error as { message?: string; type?: string } | string | undefined;
      const msg =
        typeof errObj === "string"
          ? errObj
          : errObj?.message ?? (typeof evAny.message === "string" ? evAny.message : "unknown error");
      const errType =
        typeof errObj === "object" ? (errObj?.type ?? "") : "";
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `API error: ${msg}` },
      ]);
      setShowStderr(true);
      if (errType === "authentication_error" || isAuthErrorText(msg)) {
        setAuthErrorSeen(true);
      }
      return;
    }
  }

  function handlePartial(e: PartialEvent) {
    if (e.type === "message_start") {
      const msgId = (e as { message: { id: string } }).message?.id;
      if (!msgId) return;
      streamingIdRef.current = msgId;
      setEntries((es) => {
        if (es.some((x) => x.kind === "assistant" && x.id === msgId)) return es;
        return [...es, { kind: "assistant", id: msgId, blocks: [] }];
      });
      return;
    }

    const msgId = streamingIdRef.current;
    if (!msgId) return;

    const updateBlocks = (fn: (blocks: Block[]) => Block[]) => {
      setEntries((es) =>
        es.map((x) =>
          x.kind === "assistant" && x.id === msgId
            ? { ...x, blocks: fn(x.blocks) }
            : x,
        ),
      );
    };

    if (e.type === "content_block_start") {
      const ce = e as { index: number; content_block: Block };
      updateBlocks((blocks) => {
        const next = blocks.slice();
        const cb = { ...(ce.content_block as object) } as Block;
        if ((cb as TextBlock).type === "text") {
          if ((cb as TextBlock).text == null) (cb as TextBlock).text = "";
          (cb as TextBlock)._streaming = true;
        }
        if ((cb as ThinkingBlock).type === "thinking") {
          if ((cb as ThinkingBlock).thinking == null) (cb as ThinkingBlock).thinking = "";
          (cb as ThinkingBlock)._streaming = true;
        }
        if ((cb as ToolUseBlock).type === "tool_use") {
          (cb as ToolUseBlock)._inputJson = "";
        }
        next[ce.index] = cb;
        return next;
      });
      return;
    }

    if (e.type === "content_block_delta") {
      const de = e as {
        index: number;
        delta: { type: string; [k: string]: unknown };
      };
      updateBlocks((blocks) => {
        const next = blocks.slice();
        const b = next[de.index] as Block | undefined;
        if (!b) return blocks;
        if (b.type === "text" && de.delta.type === "text_delta") {
          next[de.index] = {
            ...b,
            text: (b as TextBlock).text + (de.delta.text as string),
          };
        } else if (b.type === "thinking" && de.delta.type === "thinking_delta") {
          next[de.index] = {
            ...b,
            thinking: (b as ThinkingBlock).thinking + (de.delta.thinking as string),
          };
        } else if (b.type === "tool_use" && de.delta.type === "input_json_delta") {
          const cur = (b as ToolUseBlock)._inputJson ?? "";
          next[de.index] = {
            ...b,
            _inputJson: cur + (de.delta.partial_json as string),
          };
        }
        return next;
      });
      return;
    }

    if (e.type === "content_block_stop") {
      const se = e as { index: number };
      updateBlocks((blocks) => {
        const next = blocks.slice();
        const b = next[se.index] as Block | undefined;
        if (!b) return blocks;
        // Create a fresh object to make memoized children re-render to the
        // finalized (markdown-rendered) view.
        const cleaned: Block = { ...b } as Block;
        if (cleaned.type === "text") {
          const tb = cleaned as TextBlock;
          delete tb._streaming;
          tb._html = compileMarkdown(tb.text ?? "", githubRepoCache.get(cwd) || "");
        }
        if (cleaned.type === "thinking") {
          const thb = cleaned as ThinkingBlock;
          delete thb._streaming;
          thb._html = compileMarkdown(thb.thinking ?? "", githubRepoCache.get(cwd) || "");
        }
        if (cleaned.type === "tool_use") {
          const tu = cleaned as ToolUseBlock;
          if (tu._inputJson !== undefined) {
            try {
              tu.input = JSON.parse(tu._inputJson || "{}");
            } catch {
              // leave as-is
            }
            delete tu._inputJson;
          }
          if (tu.id && tu.name) {
            toolUseMapRef.current.set(tu.id, { name: tu.name, input: tu.input });
          }
        }
        next[se.index] = cleaned;
        return next;
      });
      return;
    }

    if (e.type === "message_stop") {
      streamingIdRef.current = null;
      return;
    }
  }

  async function pickDirectory() {
    try {
      const selected = await openDialog({ directory: true, multiple: false, defaultPath: cwd });
      if (typeof selected === "string" && selected) setCwd(selected);
    } catch (e) {
      console.error(e);
    }
  }

  function resetSessionState() {
    // Switch to the scratch slot first so the ref mirrored inside
    // setEntries doesn't still point at the session we're leaving —
    // otherwise setEntries([]) below would wipe the kept-alive copy.
    setActiveSessionId(undefined);
    setEntries([]);
    setStderrLines([]);
    toolUseMapRef.current.clear();
    toolUseMapGlobal.current = toolUseMapRef.current;
    streamingIdRef.current = null;
    setBusy(false);
    setSessionMeta(null);
    setStuckToBottom(true);
    setHasNewBelow(false);
    // Preview is per-session — close it and forget detected URLs.
    setPreviewOpen(false);
    setPreviewUrl("");
    seenUrlsRef.current.clear();
  }

  async function newSession() {
    // In grid mode "+ new session" opens a directory picker and appends a
    // fresh empty panel that'll spawn its subprocess in that cwd once the
    // user sends a first message.
    if (gridMode) {
      await addNewGridPanel();
      return;
    }
    if (sessionOn) {
      switchingSessionRef.current = true;
      try {
        await stopSession();
      } finally {
        switchingSessionRef.current = false;
      }
    }
    resetSessionState();
    setModel(appSettings.defaultModel);
    setPermissionMode(appSettings.defaultPermissionMode);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function addNewGridPanel() {
    let chosen: string | null = null;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: cwd,
      });
      if (typeof selected === "string" && selected) chosen = selected;
    } catch (e) {
      console.error("[addNewGridPanel] pick dir failed", e);
      return;
    }
    if (!chosen) return; // user cancelled the dialog
    // Only offer the worktree opt-in when the picked dir is actually a
    // git repo. Otherwise skip the question entirely — claude would
    // refuse --worktree on a non-repo and the spawn would die with a
    // broken pipe.
    let isRepo = false;
    try {
      const info = await invoke<BranchInfo>("list_branches", { cwd: chosen });
      isRepo = !!info?.is_repo;
    } catch {
      isRepo = false;
    }
    let useWorktree = false;
    if (isRepo) {
      if (appSettings.newPanelWorktreeMode === "always") {
        useWorktree = true;
      } else if (appSettings.newPanelWorktreeMode === "ask") {
        const choice = await new Promise<boolean | null>((resolve) => {
          setWorktreePrompt({ cwd: chosen!, resolve });
        });
        if (choice === null) return; // user cancelled the modal
        useWorktree = choice;
      }
    }
    const key = `new:${randomId()}:${Date.now()}`;
    setNewPanelCwds((m) => ({ ...m, [key]: chosen! }));
    if (useWorktree) {
      setNewPanelWorktree((m) => ({ ...m, [key]: true }));
    }
    // If we're at the 6-panel cap, replace the currently selected panel
    // (falling back to the last) so the new session always appears.
    if (gridPanels.length >= 6) {
      const targetIdx = selectedGridPanelId
        ? gridPanels.indexOf(selectedGridPanelId)
        : gridPanels.length - 1;
      const replacedId = gridPanels[targetIdx >= 0 ? targetIdx : gridPanels.length - 1];
      setGridPanels((prev) => {
        const next = prev.slice();
        const idx = replacedId ? prev.indexOf(replacedId) : -1;
        if (idx >= 0) next[idx] = key;
        else next[prev.length - 1] = key;
        return next;
      });
      // Clean up the replaced panel's cwd entry if it was a new-panel key.
      if (replacedId && replacedId.startsWith("new:")) {
        setNewPanelCwds((m) => {
          if (!(replacedId in m)) return m;
          const next = { ...m };
          delete next[replacedId];
          return next;
        });
        setNewPanelWorktree((m) => {
          if (!(replacedId in m)) return m;
          const next = { ...m };
          delete next[replacedId];
          return next;
        });
      }
    } else {
      setGridPanels((prev) => [...prev, key]);
    }
    setSelectedGridPanelId(key);
  }

  async function onSwitchBranch(branch: string) {
    if (!branch || !branchInfo || branch === branchInfo.current) return;
    if (branchInfo.dirty) {
      const ok = window.confirm(
        `You have uncommitted changes in ${branchInfo.current}. git will refuse to switch if any of your edits would be overwritten. Continue?`,
      );
      if (!ok) return;
    }
    setSwitchingBranch(true);
    try {
      await invoke("switch_branch", { cwd, branch });
      await refreshBranches(cwd);
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `— switched branch to ${branch} —` },
      ]);
    } catch (e) {
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `failed to switch: ${e}` },
      ]);
      notifyErr(`failed to switch to ${branch}`)(e);
    } finally {
      setSwitchingBranch(false);
    }
  }

  async function resumeSession(sessionId: string, sessionCwd: string) {
    const token = ++resumeTokenRef.current;
    const isLatest = () => resumeTokenRef.current === token;
    const t0 = performance.now();
    const log = (label: string) => {
      // Prefix lets us grep these in DevTools console without noise.
      console.log(`[perf:resume] ${(performance.now() - t0).toFixed(1)}ms ${label}`);
    };

    const info = sessions.find((s) => s.id === sessionId);
    const sessionModel = info?.model ?? "";
    const sessionPermissionMode = info?.permission_mode ?? "";
    const mtime = info?.mtime_ms ?? 0;

    log(`enter sid=${sessionId.slice(0, 8)}`);
    const cached = sessionCacheRef.current.get(sessionId);
    // Any cache with entries is good enough for instant display — the
    // prewarm loop keeps entries reasonably fresh on mtime change, and
    // a stale cache just means a turn or two is missing until the next
    // prewarm pass. Previously we required `cached.mtime_ms === mtime`,
    // which rejected caches populated by LivePanel's lazy loader (which
    // had no disk mtime) and caused "expand from grid" to always take
    // the slow path.
    const cacheHit = !!cached && cached.entries.length > 0;
    log(`cache=${cacheHit ? "HIT" : "MISS"} entries=${cached?.entries.length ?? 0}`);

    const applyResumeState = () => {
      switchingSessionRef.current = true;
      if (sessionModel) setModel(sessionModel);
      if (sessionPermissionMode) setPermissionMode(sessionPermissionMode);
      setSessionOn(false);
      setActiveSessionId(sessionId);
      if (sessionCwd) setCwd(sessionCwd);
      setStderrLines([]);
      setSessionMeta(null);
      setBusy(false);
      setStuckToBottom(true);
      setHasNewBelow(false);
      setPreviewOpen(false);
      setPreviewUrl("");
      seenUrlsRef.current.clear();
      streamingIdRef.current = null;
    };

    if (cacheHit) {
      toolUseMapRef.current = new Map(cached!.toolUseMap);
      toolUseMapGlobal.current = toolUseMapRef.current;
      // If this session's transcript is already in the keep-alive map
      // from an earlier visit, skip replacing its entries — swapping
      // them would force React to diff + tear down its DOM, undoing
      // the whole point of the keep-alive. The flip of activeSessionId
      // already makes it visible.
      const existingSlot = allTranscripts.get(sessionId);
      const alreadyMounted = !!existingSlot && existingSlot.length > 0;
      flushSync(() => {
        applyResumeState();
        if (!alreadyMounted) {
          // PlainTranscript only renders the tail window by default (see
          // TRANSCRIPT_WINDOW), so mounting a full cached-entry array is
          // cheap regardless of conversation length — no progressive
          // mount needed.
          setEntries([
            ...cached!.entries,
            { kind: "system", id: randomId(), text: "— resumed —" },
          ]);
        }
        setResumingId(null);
        requestTranscriptBottom(sessionId);
      });
      scrollTranscriptToBottomNow();
    } else {
      toolUseMapRef.current = new Map();
      toolUseMapGlobal.current = toolUseMapRef.current;
      flushSync(() => {
        applyResumeState();
        setEntries([]);
        setResumingId(sessionId);
      });
    }

    const useCwd = sessionCwd || cwd;

    // Start the claude subprocess in the background. On a cold cache,
    // gate that start until after the transcript tail has loaded and
    // rendered; CLI startup can take seconds, and it should never sit
    // in front of showing already-saved conversation history. send()
    // still awaits startPromiseRef before dispatching send_message.
    let releaseStartGate: () => void = () => {};
    const startGate = cacheHit
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          releaseStartGate = resolve;
        });
    const startPromise = (async () => {
      await startGate;
      if (!isLatest()) return;
      // setPermissionMode above hasn't flushed yet, so send the
      // session's own permission mode to start_session directly.
      await invoke("start_session", {
        panelId: "main",
        cwd: useCwd,
        permissionMode: sessionPermissionMode || permissionMode,
        model: sessionModel || model || null,
        resumeId: sessionId,
      });
    })();
    startPromiseRef.current = startPromise;
    // Optimistic flip — sessionOn becomes the "ready to chat" indicator
    // immediately. send() will still await the start promise before any
    // send_message, so we never dispatch into a non-existent subprocess.
    setSessionOn(true);
    setTimeout(() => inputRef.current?.focus(), 0);
    log(
      cacheHit
        ? "synchronous-batch done; start fired"
        : "synchronous-batch done; loading history before start",
    );
    requestAnimationFrame(() => log("first paint after click"));
    startPromise.then(() => {
      if (isLatest()) log("subprocess ready");
    });
    startPromise
      .catch((e) => {
        if (!isLatest()) return;
        setSessionOn(false);
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `failed to start: ${e}` },
        ]);
        notifyErr("failed to start session")(e);
      })
      .finally(() => {
        if (startPromiseRef.current === startPromise) {
          startPromiseRef.current = null;
        }
        if (isLatest()) switchingSessionRef.current = false;
      });

    if (!cacheHit) {
      try {
        // Fetch only the tail — it's what we need to render immediately and
        // parses/serializes in tens of ms vs hundreds for a full load.
        const [events, repo] = await Promise.all([
          invoke<Array<Record<string, unknown>>>("load_session_tail", {
            sessionId,
            cwd: useCwd,
            limit: SESSION_TAIL_LIMIT,
          }),
          getGithubRepo(useCwd),
        ]);
        log(`load_session_tail returned events=${events.length}`);
        if (!isLatest()) return;
        const { entries: history, toolUseMap } = buildHistory(events, repo, {
          precompileMarkdown: false,
        });
        log(`buildHistory done entries=${history.length}`);
        if (!isLatest()) return;
        sessionCacheRef.current.set(sessionId, {
          entries: history,
          toolUseMap,
          mtime_ms: mtime,
        });
        toolUseMapRef.current = new Map(toolUseMap);
        toolUseMapGlobal.current = toolUseMapRef.current;
        flushSync(() => {
          setEntries([
            ...history,
            { kind: "system", id: randomId(), text: "— resumed —" },
          ]);
          requestTranscriptBottom(sessionId);
        });
        scrollTranscriptToBottomNow();
      } catch (e) {
        if (isLatest()) {
          setEntries((es) => [
            ...es,
            { kind: "system", id: randomId(), text: `failed to load history: ${e}` },
          ]);
        }
      } finally {
        releaseStartGate();
        if (isLatest()) setResumingId(null);
      }
    }

  }

  async function stopSession() {
    try {
      await invoke("stop_session", { panelId: "main" });
    } finally {
      setSessionOn(false);
      setBusy(false);
    }
  }

  async function interruptTurn() {
    try {
      await invoke("interrupt_session", { panelId: "main" });
    } catch (e) {
      console.error("interrupt failed", e);
    }
  }

  // Hard reset: kill whatever subprocess the "main" panel has and
  // respawn it in the active session. Used when a turn wedges and
  // interrupt alone doesn't bring the panel back.
  async function resetMainSession() {
    setBusy(false);
    setStuckBusy(false);
    try {
      await invoke("stop_session", { panelId: "main" });
    } catch {
      // ignore — we're about to respawn anyway
    }
    try {
      await invoke("start_session", {
        panelId: "main",
        cwd,
        permissionMode,
        model: model || null,
        resumeId: activeSessionId || null,
      });
      setSessionOn(true);
    } catch (e) {
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `reset failed: ${e}` },
      ]);
    }
  }

  // Fire a short user reply without touching the composer input — used
  // by the yes/no quick-reply buttons. Mirrors send() minus the input
  // and attachment handling.
  async function sendQuickReply(text: string) {
    if (busy || !text) return;
    if (startPromiseRef.current) {
      try {
        await startPromiseRef.current;
      } catch {
        // start failed — sessionOn was flipped back to false; fall
        // through to spawn a fresh subprocess below.
      }
    }
    if (!sessionOn) {
      try {
        await invoke("start_session", {
          panelId: "main",
          cwd,
          permissionMode,
          model: model || null,
          resumeId: null,
        });
        setSessionOn(true);
      } catch (e) {
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `failed to start: ${e}` },
        ]);
        notifyErr("failed to start session")(e);
        return;
      }
    }
    setEntries((es) => [
      ...es,
      { kind: "user", id: randomId(), text },
    ]);
    lastUserMessageRef.current = text;
    setBusy(true);
    setStuckToBottom(true);
    setHasNewBelow(false);
    try {
      await invoke("send_message", { panelId: "main", text });
    } catch (e) {
      setBusy(false);
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `send failed: ${e}` },
      ]);
      notifyErr("send failed")(e);
    }
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;

    if (startPromiseRef.current) {
      try {
        await startPromiseRef.current;
      } catch {
        // start failed — sessionOn was flipped back to false; fall
        // through to spawn a fresh subprocess below.
      }
    }

    if (!sessionOn) {
      try {
        // Resume the session the user is looking at if there is one;
        // otherwise start fresh. Previously we always passed
        // resumeId:null, which meant sending mid-resume spawned a
        // brand-new subprocess pointed at a session the UI wasn't
        // displaying — leading to "thinking forever" on the visible
        // transcript.
        await invoke("start_session", {
          panelId: "main",
          cwd,
          permissionMode,
          model: model || null,
          resumeId: activeSessionId || null,
        });
        setSessionOn(true);
      } catch (e) {
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `failed to start: ${e}` },
        ]);
        notifyErr("failed to start session")(e);
        return;
      }
    }

    // Attachments become a trailing section of the message so claude's
    // Read / Bash / Glob tools can pick them up by path.
    const body = buildAttachmentBody(text, attachments);

    setInput("");
    setAttachments([]);
    setEntries((es) => [
      ...es,
      { kind: "user", id: randomId(), text: body },
    ]);
    lastUserMessageRef.current = body;
    setBusy(true);
    setStuckToBottom(true);
    setHasNewBelow(false);
    try {
      await invoke("send_message", { panelId: "main", text: body });
    } catch (e) {
      setBusy(false);
      setEntries((es) => [...es, { kind: "system", id: randomId(), text: `send failed: ${e}` }]);
      notifyErr("send failed")(e);
    }
  }

  // Fetch the cwd's git-tracked files (ls-files) once per cwd change.
  // Small cost, rare change. Non-git cwds come back empty and the
  // autocomplete simply shows no suggestions.
  useEffect(() => {
    if (!cwd) return;
    if (!isTauriRuntime()) {
      setFileMentions([]);
      return;
    }
    if (fileMentionsCwdRef.current === cwd) return;
    fileMentionsCwdRef.current = cwd;
    invoke<string[]>("list_tracked_files", { cwd })
      .then((paths) => setFileMentions(paths))
      .catch(() => setFileMentions([]));
  }, [cwd]);

  // Walk back from the caret to find the current `@token` being typed,
  // if any. Returns null when the token doesn't look like a file-path
  // mention or the user isn't in one.
  function currentMentionQuery(): string | null {
    const el = inputRef.current;
    if (!el) return null;
    const pos = el.selectionStart ?? input.length;
    const before = input.slice(0, pos);
    const m = before.match(/(?:^|\s)@([\w./\-]*)$/);
    return m ? m[1] : null;
  }

  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return [] as string[];
    if (!fileMentions.length) return [] as string[];
    const q = mentionQuery.toLowerCase();
    if (!q) return fileMentions.slice(0, 8);
    const ranked: Array<{ path: string; score: number }> = [];
    for (const p of fileMentions) {
      const lp = p.toLowerCase();
      const idx = lp.indexOf(q);
      if (idx < 0) continue;
      // Exact suffix / filename matches rank higher than mid-path hits.
      const base = lp.slice(lp.lastIndexOf("/") + 1);
      let score = idx;
      if (base.startsWith(q)) score -= 1000;
      else if (base.includes(q)) score -= 500;
      ranked.push({ path: p, score });
      if (ranked.length > 200) break; // cheap cap before sort
    }
    ranked.sort((a, b) => a.score - b.score);
    return ranked.slice(0, 8).map((r) => r.path);
  }, [mentionQuery, fileMentions]);

  useEffect(() => {
    setMentionIdx(0);
  }, [mentionQuery]);

  function insertMention(path: string) {
    const el = inputRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? input.length;
    const before = input.slice(0, pos);
    const after = input.slice(pos);
    // Replace the trailing `@query` with `@path ` (trailing space so
    // the next word doesn't accidentally re-trigger the dropdown).
    const replaced = before.replace(/@([\w./\-]*)$/, `@${path} `);
    const next = replaced + after;
    setInput(next);
    setMentionQuery(null);
    // Restore caret position after the inserted path.
    requestAnimationFrame(() => {
      const newPos = replaced.length;
      if (el && el === inputRef.current) {
        el.selectionStart = newPos;
        el.selectionEnd = newPos;
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && filteredMentions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % filteredMentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx(
          (i) => (i - 1 + filteredMentions.length) % filteredMentions.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = filteredMentions[mentionIdx];
        if (pick) insertMention(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const hasStderr = stderrLines.length > 0;

  // Stable handler identities for the memoized Sidebar so it can skip
  // re-rendering on unrelated state changes (composer keystrokes etc.).
  // useEvent body always sees the latest closure, but the returned ref
  // identity never changes.
  const onSidebarResume = useEvent((id: string, cwd: string) => {
    if (gridMode) {
      // Clicking a sidebar session in grid mode:
      //   * if it's already in the grid → focus it
      //   * if there's an empty slot → append (don't touch selection)
      //   * if the grid is full → replace the selected panel (or last)
      // findPanelForSession handles both direct id matches and
      // "new:..." placeholders that have reported a real session id.
      const existingKey = findPanelForSession(
        id,
        gridPanels,
        panelSessionIds,
      );
      if (existingKey) {
        setSelectedGridPanelId(existingKey);
        return;
      }
      if (gridPanels.length < 6) {
        setGridPanels((prev) =>
          prev.includes(id) ? prev : [...prev, id],
        );
        setSelectedGridPanelId(id);
        return;
      }
      const targetId =
        selectedGridPanelId && gridPanels.includes(selectedGridPanelId)
          ? selectedGridPanelId
          : gridPanels[gridPanels.length - 1];
      setGridPanels((prev) => {
        const idx = prev.indexOf(targetId);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = id;
        return next;
      });
      if (targetId.startsWith("new:")) {
        setNewPanelCwds((m) => {
          if (!(targetId in m)) return m;
          const next = { ...m };
          delete next[targetId];
          return next;
        });
        setNewPanelWorktree((m) => {
          if (!(targetId in m)) return m;
          const next = { ...m };
          delete next[targetId];
          return next;
        });
      }
      setSelectedGridPanelId(id);
    } else {
      const seq = ++sidebarResumeSeqRef.current;
      flushSync(() => setSidebarSelectedSessionId(id));
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          if (sidebarResumeSeqRef.current !== seq) return;
          resumeSession(id, cwd);
        }, 0);
      });
    }
  });
  const onSidebarNew = useEvent(() => {
    newSession();
  });
  const pickStartupCwd = useEvent(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: appSettings.startupCwd || cwd,
      });
      if (typeof selected !== "string" || !selected) return;
      updateAppSettings({ startupCwd: selected });
      if (!sessionOn) setCwd(selected);
    } catch (e) {
      console.error(e);
    }
  });
  const useCurrentCwdForStartup = useEvent(() => {
    if (!cwd) return;
    updateAppSettings({ startupCwd: cwd });
  });
  const clearStartupCwd = useEvent(() => {
    updateAppSettings({ startupCwd: "" });
  });
  const sidebarActiveId = gridMode
    ? selectedGridPanelId
      ? resolvePanelSession(selectedGridPanelId, panelSessionIds)
      : undefined
    : sidebarSelectedSessionId ?? activeSessionId;
  const shouldShowOnboarding =
    onboardingForced ||
    (!onboardingDismissed &&
      ((claudePreflightLoading && !claudePreflight) ||
        !!(
          claudePreflight &&
          (!claudePreflight.installed || !claudePreflight.authenticated)
        )));

  return (
    <div className="root">
      <ToastHost />
      {availableUpdate && !updateDismissed && (
        <UpdateBanner
          version={availableUpdate.version}
          installing={updateInstalling}
          onInstall={installAvailableUpdate}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}
      {shouldShowOnboarding && (
          <ClaudeOnboardingOverlay
            status={claudePreflight}
            loading={claudePreflightLoading}
            onRecheck={refreshClaudePreflight}
            onContinue={() => {
              setOnboardingDismissed(true);
              setOnboardingForced(false);
            }}
          />
        )}
      {authErrorSeen && (
        <AuthErrorModal
          onDismiss={() => setAuthErrorSeen(false)}
          onQuit={() => {
            if (!isTauriRuntime()) {
              setAuthErrorSeen(false);
              return;
            }
            getCurrentWindow().close().catch(() => {});
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          onClose={() => setPaletteOpen(false)}
          onPickSession={(id, sessionCwd) => {
            setPaletteOpen(false);
            if (gridMode) setGridMode(false);
            resumeSession(id, sessionCwd);
          }}
          commands={[
            {
              id: "toggle-grid",
              title: gridMode ? "Leave grid mode" : "Enter grid mode",
              hint: "⊞ grid",
              run: () => {
                setGridMode((v) => !v);
                setPaletteOpen(false);
              },
            },
            {
              id: "cycle-theme",
              title: `Theme: ${theme} → ${nextTheme(theme)}`,
              hint: theme,
              run: () => {
                setTheme((t) => nextTheme(t));
                setPaletteOpen(false);
              },
            },
            {
              id: "settings",
              title: "Open settings",
              hint: "⌘,",
              run: () => {
                setPaletteOpen(false);
                setSettingsOpen(true);
              },
            },
            {
              id: "new-session",
              title: "Start a new session",
              hint: "⌘N",
              run: () => {
                setPaletteOpen(false);
                void newSession();
              },
            },
            {
              id: "claude-setup",
              title: "Claude Code setup",
              hint: claudePreflight?.authenticated ? "ready" : "setup",
              run: () => {
                setPaletteOpen(false);
                setOnboardingDismissed(false);
                setOnboardingForced(true);
                void refreshClaudePreflight();
              },
            },
            {
              id: "check-updates",
              title: updateChecking ? "Checking for updates..." : "Check for updates",
              hint: "update",
              run: () => {
                setPaletteOpen(false);
                void checkForUpdates(true);
              },
            },
            {
              id: "toggle-preview",
              title: previewOpen ? "Close preview panel" : "Open preview panel",
              hint: "preview",
              run: () => {
                setPreviewOpen((v) => !v);
                setPaletteOpen(false);
              },
            },
            {
              id: "toggle-terminal",
              title: terminalOpen ? "Close terminal" : "Open terminal",
              hint: "⌘J",
              run: () => {
                setTerminalOpen((v) => !v);
                setPaletteOpen(false);
              },
            },
            {
              id: "computer-use",
              title: "Open computer use session",
              hint: "/mcp",
              run: () => {
                openComputerUseSession();
                setPaletteOpen(false);
              },
            },
            {
              id: "computer-use-handoff",
              title: "Hand off current task to computer use",
              hint: "GUI",
              run: () => {
                void startInlineComputerUse();
                setPaletteOpen(false);
              },
            },
            ...(activeSessionId && entries.length > 0
              ? [
                  {
                    id: "export-md",
                    title: "Export this conversation as markdown",
                    hint: "↓ export",
                    run: async () => {
                      setPaletteOpen(false);
                      const info = sessions.find((s) => s.id === activeSessionId);
                      const md = sessionEntriesToMarkdown(entries, {
                        title: info?.title,
                        sessionId: activeSessionId,
                        model: info?.model || model,
                        cwd: info?.cwd || cwd,
                      });
                      const base = (info?.title || "session")
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "-")
                        .replace(/^-+|-+$/g, "")
                        .slice(0, 60);
                      try {
                        const chosen = await saveDialog({
                          defaultPath: `${base || "session"}.md`,
                          filters: [{ name: "Markdown", extensions: ["md"] }],
                        });
                        if (!chosen) return;
                        await invoke("write_text_file", {
                          path: chosen,
                          content: md,
                        });
                      } catch (e) {
                        notifyErr("export failed")(e);
                      }
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={appSettings}
          theme={theme}
          grouped={groupByProject}
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={updateAppSettings}
          onThemeChange={setTheme}
          onGroupedChange={setGroupByProject}
          onPickStartupCwd={pickStartupCwd}
          onUseCurrentCwd={useCurrentCwdForStartup}
          onClearStartupCwd={clearStartupCwd}
        />
      )}
      {worktreePrompt && (
        <WorktreePromptModal
          cwd={worktreePrompt.cwd}
          onYes={() => {
            worktreePrompt.resolve(true);
            setWorktreePrompt(null);
          }}
          onNo={() => {
            worktreePrompt.resolve(false);
            setWorktreePrompt(null);
          }}
          onCancel={() => {
            worktreePrompt.resolve(null);
            setWorktreePrompt(null);
          }}
        />
      )}
      <Sidebar
        sessions={sessions}
        activeId={sidebarActiveId}
        pinActiveToTop={!gridMode}
        loading={sessionsLoading}
        resumingId={resumingId}
        onResume={onSidebarResume}
        onRename={renameSession}
        onDelete={deleteSession}
        onNew={onSidebarNew}
        onRefresh={refreshSessions}
        cwd={cwd}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        search={sessionSearch}
        onSearchChange={setSessionSearch}
        grouped={groupByProject}
        onGroupedChange={setGroupByProject}
        width={sidebarResize.width}
        onResizeStart={sidebarResize.onPointerDown}
      />
      <main className="app">
        <header className="topbar">
          <div className="brand">
            <img className="brand-logo" src={blackcrabLogo} alt="" aria-hidden="true" />
            <span>Blackcrab</span>
          </div>
          <div className="controls">
            <label className="field">
              <span>cwd</span>
              <div className="cwd-row">
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={pickDirectory}
                  title="pick directory"
                >
                  …
                </button>
              </div>
            </label>
            {branchInfo?.is_repo && (
              <label className="field field-sm">
                <span>
                  branch
                  {branchInfo.dirty && (
                    <span className="dirty-dot" title="uncommitted changes">
                      *
                    </span>
                  )}
                </span>
                <select
                  value={branchInfo.current}
                  onChange={(e) => onSwitchBranch(e.target.value)}
                  disabled={switchingBranch}
                  title={
                    branchInfo.dirty
                      ? `${branchInfo.current} (uncommitted changes)`
                      : branchInfo.current
                  }
                >
                  {!branchInfo.branches.includes(branchInfo.current) && branchInfo.current && (
                    <option value={branchInfo.current}>{branchInfo.current}</option>
                  )}
                  {branchInfo.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field field-sm">
              <span>model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option
                    key={opt.value}
                    value={opt.disabled ? "" : opt.value}
                    disabled={opt.disabled}
                  >
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-sm">
              <span>permissions</span>
              <select
                value={permissionMode}
                onChange={(e) => {
                  const mode = e.target.value;
                  setPermissionMode(mode);
                  // If the main-panel subprocess is alive, push the change
                  // through immediately instead of waiting for the next
                  // session restart.
                  if (sessionOn) {
                    setPermissionModeOnPanel("main", mode);
                  }
                }}
              >
                {PERMISSION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-secondary grid-mode-toggle"
              disabled={gridMode || entries.length === 0}
              onClick={async () => {
                const info = activeSessionId
                  ? sessions.find((s) => s.id === activeSessionId)
                  : undefined;
                const md = sessionEntriesToMarkdown(entries, {
                  title: info?.title,
                  sessionId: activeSessionId,
                  model: info?.model || model,
                  cwd: info?.cwd || cwd,
                });
                const baseName = (info?.title || "session")
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 60);
                const suggested = `${baseName || "session"}.md`;
                try {
                  const chosen = await saveDialog({
                    defaultPath: suggested,
                    filters: [{ name: "Markdown", extensions: ["md"] }],
                  });
                  if (!chosen) return;
                  await invoke("write_text_file", {
                    path: chosen,
                    content: md,
                  });
                } catch (e) {
                  notifyErr("export failed")(e);
                }
              }}
              title="export this conversation as a markdown file"
            >
              ↓ export
            </button>
            <button
              type="button"
              className={`btn btn-secondary grid-mode-toggle ${terminalOpen ? "active" : ""}`}
              onClick={() => setTerminalOpen((v) => !v)}
              title="toggle integrated terminal (⌘J)"
            >
              &gt;_ terminal
            </button>
            <button
              type="button"
              className={`btn btn-secondary grid-mode-toggle ${gridMode ? "active" : ""}`}
              onClick={() => setGridMode((v) => !v)}
              title="grid mode (show up to 6 conversations)"
            >
              ⊞ grid
            </button>
            <div className="theme-toggle" role="group" aria-label="theme">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`theme-btn ${theme === opt.value ? "active" : ""}`}
                  onClick={() => setTheme(opt.value)}
                  title={`${opt.label.toLowerCase()} mode`}
                >
                  {opt.glyph}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`btn btn-secondary grid-mode-toggle ${settingsOpen ? "active" : ""}`}
              onClick={() => setSettingsOpen(true)}
              title="settings"
            >
              settings
            </button>
          </div>
        </header>

        <div className={`grid-wrap ${gridMode ? "" : "hidden"}`}>
          <LiveGrid
            panels={gridPanels}
            sessions={sessions}
            sessionCache={sessionCacheRef.current}
            permissionMode={permissionMode}
            defaultCwd={cwd}
            defaultModel={model}
            selectedId={selectedGridPanelId}
            onSelect={setSelectedGridPanelId}
            onAddPanel={addNewGridPanel}
            onRename={renameSession}
            onReorder={reorderGridPanels}
            newPanelCwds={newPanelCwds}
            newPanelWorktree={newPanelWorktree}
            onSessionStarted={(panelId, sid) => {
              setPanelSessionIds((m) =>
                m[panelId] === sid ? m : { ...m, [panelId]: sid },
              );
              refreshSessions();
            }}
            onExpand={async (sid, panelCwd, panelId) => {
              // Double-click on a grid tile: hand off ownership to
              // single-view. The grid LivePanel's unmount cleanup also
              // calls stop_session, but it's fire-and-forget and races
              // the start_session below — without an explicit await the
              // single-writer gate rejects with "already open".
              try {
                await invoke("stop_session", { panelId });
              } catch {}
              setGridMode(false);
              resumeSession(sid, panelCwd);
            }}
            onRemove={(id) => {
              setGridPanels((prev) => prev.filter((x) => x !== id));
              setNewPanelCwds((m) => {
                if (!(id in m)) return m;
                const next = { ...m };
                delete next[id];
                return next;
              });
              setNewPanelWorktree((m) => {
                if (!(id in m)) return m;
                const next = { ...m };
                delete next[id];
                return next;
              });
              setPanelSessionIds((m) => {
                if (!(id in m)) return m;
                const next = { ...m };
                delete next[id];
                return next;
              });
            }}
          />
        </div>
        <section className={`transcript-wrap ${gridMode ? "hidden" : ""}`}>
          {searchOpen && (
            <SearchOverlay
              scrollRef={transcriptScrollRef}
              onClose={() => setSearchOpen(false)}
            />
          )}
          {/* Render one PlainTranscript per kept session. Only the active
              slot is visible; the others stay mounted behind display:none
              so switching back to them is a CSS toggle instead of a
              full DOM teardown + rebuild. */}
          {Array.from(allTranscripts.entries()).map(([id, slotEntries]) => {
            const activeKey = activeSessionId ?? NEW_SESSION_KEY;
            const isActive = id === activeKey;
            if (slotEntries.length === 0 && !isActive) return null;
            if (slotEntries.length === 0 && isActive) {
              return (
                <div key={id} className="empty">
                  {resumingId ? (
                    <p>loading session…</p>
                  ) : (
                    <>
                      <p>
                        Type a message below to start a new session, or pick a
                        past one from the sidebar.
                      </p>
                      <p className="hint">
                        Settings apply to the next session you start.
                      </p>
                    </>
                  )}
                </div>
              );
            }
            return (
              <div
                key={id}
                className={`transcript-slot ${isActive ? "active" : "kept"}`}
                aria-hidden={!isActive}
              >
                <PlainTranscript
                  entries={slotEntries}
                  busy={isActive ? busy : false}
                  scrollRef={isActive ? transcriptScrollRef : noopScrollRef}
                  onAtBottomChange={isActive ? handleAtBottomChange : noop}
                  scrollToBottomToken={
                    isActive && transcriptScrollRequest?.sessionId === id
                      ? transcriptScrollRequest.seq
                      : 0
                  }
                />
              </div>
            );
          })}
          {!stuckToBottom && entries.length > 0 && (
            <button
              className={`jump-bottom ${hasNewBelow ? "pulse" : ""}`}
              onClick={scrollToBottom}
              title="jump to bottom"
            >
              ↓
            </button>
          )}
          {stuckBusy && (
            <div className="stuck-banner" role="status">
              <span className="stuck-banner-text">
                claude has been thinking for 30+ seconds with no output —
                the subprocess may be wedged.
              </span>
              <div className="stuck-banner-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={interruptTurn}
                >
                  Interrupt
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={resetMainSession}
                >
                  Reset session
                </button>
              </div>
            </div>
          )}
          {pendingPermission && (
            <PermissionPromptOverlay
              req={pendingPermission}
              onAllow={async () => {
                await respondPermission("main", pendingPermission, true);
                setPendingPermission(null);
              }}
              onDeny={async () => {
                await respondPermission("main", pendingPermission, false);
                setPendingPermission(null);
              }}
              onAllowAndBypass={async () => {
                await respondPermission("main", pendingPermission, true);
                await setPermissionModeOnPanel("main", "bypassPermissions");
                setPermissionMode("bypassPermissions");
                setPendingPermission(null);
              }}
            />
          )}
          {pendingDenials && (
            <PermissionDenialOverlay
              denials={pendingDenials}
              onDismiss={() => setPendingDenials(null)}
              onAllowAndRetry={async () => {
                // Upgrading mid-session via set_permission_mode doesn't
                // re-run the denied tool — claude already emitted a
                // `result` and is idle. Flip the mode + resend the last
                // user message so claude retries with the new mode.
                const resendText = lastUserMessageRef.current;
                const sid = activeSessionId;
                const useCwd = cwd;
                setPendingDenials(null);
                setPermissionMode("bypassPermissions");
                try {
                  await invoke("start_session", {
                    panelId: "main",
                    cwd: useCwd,
                    permissionMode: "bypassPermissions",
                    model: model || null,
                    resumeId: sid || null,
                  });
                  setSessionOn(true);
                  if (resendText) {
                    setEntries((es) => [
                      ...es,
                      {
                        kind: "user",
                        id: randomId(),
                        text: resendText,
                      },
                    ]);
                    setBusy(true);
                    await invoke("send_message", {
                      panelId: "main",
                      text: resendText,
                    });
                  }
                } catch (e) {
                  setEntries((es) => [
                    ...es,
                    {
                      kind: "system",
                      id: randomId(),
                      text: `retry failed: ${e}`,
                    },
                  ]);
                }
              }}
            />
          )}
        </section>

        {!gridMode && (
        <footer className={`composer ${dragOver ? "drag-over" : ""}`}>
          {(() => {
            // Show yes/no quick-reply buttons when claude's last message
            // ends in a yes/no-shaped question and the user hasn't already
            // replied. Hidden while a turn is in-flight.
            if (busy) return null;
            let lastText = "";
            for (let i = entries.length - 1; i >= 0; i--) {
              const e = entries[i];
              if (e.kind === "user") break;
              if (e.kind === "assistant") {
                for (let j = e.blocks.length - 1; j >= 0; j--) {
                  const b = e.blocks[j];
                  if (!b) continue;
                  if (b.type === "text") {
                    lastText = (b as TextBlock).text || "";
                    break;
                  }
                }
                break;
              }
            }
            if (!looksLikeYesNoQuestion(lastText)) return null;
            return (
              <div className="quick-replies" role="group" aria-label="quick reply">
                <button
                  type="button"
                  className="btn btn-quick btn-quick-yes"
                  onClick={() => sendQuickReply("yes")}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className="btn btn-quick btn-quick-no"
                  onClick={() => sendQuickReply("no")}
                >
                  No
                </button>
                <button
                  type="button"
                  className="btn btn-quick btn-quick-chat"
                  onClick={() => inputRef.current?.focus()}
                >
                  Let's chat about it
                </button>
              </div>
            );
          })()}
          {attachments.length > 0 && (
            <div className="attachments">
              {attachments.map((a) => {
                const name = a.path.split("/").pop() || a.path;
                return (
                  <span key={a.id} className="attachment" title={a.path}>
                    <span className="attachment-name">{name}</span>
                    <button
                      type="button"
                      className="attachment-remove"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                      }
                      aria-label="remove attachment"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {mentionQuery !== null && filteredMentions.length > 0 && (
            <div className="mention-suggestions" role="listbox">
              {filteredMentions.map((p, i) => (
                <div
                  key={p}
                  role="option"
                  aria-selected={i === mentionIdx}
                  className={`mention-item ${i === mentionIdx ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(p);
                  }}
                  onMouseEnter={() => setMentionIdx(i)}
                >
                  <span className="mention-path">{p}</span>
                </div>
              ))}
            </div>
          )}
          <div className="composer-row">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Defer the mention check by one tick so the selection
                // position reflects the new value.
                requestAnimationFrame(() => {
                  setMentionQuery(currentMentionQuery());
                });
              }}
              onKeyUp={() => {
                if (mentionQuery !== null) {
                  setMentionQuery(currentMentionQuery());
                }
              }}
              onBlur={() => setMentionQuery(null)}
              onKeyDown={onKeyDown}
              placeholder="message Claude…  (Enter to send, Shift+Enter for newline; drop files anywhere; type @ for file autocomplete)"
              disabled={busy}
              rows={3}
            />
            {busy ? (
              <button className="btn btn-interrupt" onClick={interruptTurn} title="interrupt turn">
                interrupt
              </button>
            ) : (
              <>
                <button
                  className="btn btn-handoff"
                  onClick={() => void startInlineComputerUse()}
                  disabled={!input.trim() && attachments.length === 0}
                  title="hand off this task to an interactive computer-use session"
                >
                  GUI
                </button>
                <button
                  className="btn btn-send"
                  onClick={send}
                  disabled={!input.trim() && attachments.length === 0}
                >
                  send
                </button>
              </>
            )}
          </div>
          {dragOver && (
            <div className="drag-hint">drop files to attach</div>
          )}
        </footer>
        )}

        {terminalMounted && (
          <div
            className={`terminal-panel ${terminalOpen ? "" : "hidden"}`}
            style={{ height: terminalOpen ? `${terminalHeight}px` : 0 }}
          >
            <div
              className="terminal-resizer"
              onPointerDown={onTerminalResizerDown}
              role="separator"
              aria-orientation="horizontal"
              title="drag to resize terminal"
            />
            <div className="terminal-panel-head">
              <div className="terminal-tabs" role="tablist">
                {terminalTabs.map((t) => (
                  <div
                    key={t.id}
                    role="tab"
                    aria-selected={t.id === activeTerminalId}
                    className={`terminal-tab ${
                      t.id === activeTerminalId ? "active" : ""
                    }`}
                    onClick={() => setActiveTerminalId(t.id)}
                    title="double-click to rename"
                  >
                    {editingTerminalTabId === t.id ? (
                      <input
                        autoFocus
                        className="terminal-tab-edit"
                        defaultValue={t.label}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingTerminalTabId(null);
                          }
                        }}
                        onBlur={(e) => {
                          renameTerminalTab(t.id, e.target.value);
                          setEditingTerminalTabId(null);
                        }}
                      />
                    ) : (
                      <span
                        className="terminal-tab-label"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingTerminalTabId(t.id);
                        }}
                      >
                        {t.label}
                      </span>
                    )}
                    {terminalTabs.length > 1 && (
                      <span
                        className="terminal-tab-close"
                        role="button"
                        aria-label="close tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminalTab(t.id);
                        }}
                      >
                        ×
                      </span>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="terminal-tab-add"
                  onClick={addTerminalTab}
                  title="new terminal tab"
                  aria-label="new terminal tab"
                >
                  +
                </button>
              </div>
              <span className="terminal-panel-cwd">{cwd}</span>
              <button
                type="button"
                className="grid-panel-close"
                onClick={() => setTerminalOpen(false)}
                title="close terminal (⌘J)"
              >
                ×
              </button>
            </div>
            {activeTerminalTab?.kind === "computer-use" && (
              <div className="computer-use-banner" role="status">
                <div className="computer-use-banner-text">
                  Interactive Claude Code session. Enable{" "}
                  <code>computer-use</code> from <code>/mcp</code> if it is not
                  already enabled, then approve macOS app access as needed.
                </div>
                <div className="computer-use-banner-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openComputerUseMcpMenu(activeTerminalTab)}
                    title="type /mcp into this interactive Claude Code session"
                  >
                    open /mcp
                  </button>
                  {activeTerminalTab.handoffText && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => sendComputerUseHandoff(activeTerminalTab)}
                      disabled={
                        activeTerminalTab.handoffSent ||
                        activeTerminalTab.handoffAutoQueued
                      }
                      title="type the prepared Blackcrab handoff into this terminal"
                    >
                      {activeTerminalTab.handoffSent
                        ? "handoff sent"
                        : activeTerminalTab.handoffAutoQueued
                        ? "handoff queued"
                        : "type handoff"}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="terminal-panel-slots">
              {terminalTabs.map((t) => (
                <div
                  key={t.id}
                  className={`terminal-slot ${
                    t.id === activeTerminalId ? "active" : "hidden"
                  }`}
                >
                  <TerminalPanel
                    terminalId={t.id}
                    cwd={cwd}
                    visible={t.id === activeTerminalId}
                    initialWrites={t.initialWrites}
                    onInitialWrite={(write) =>
                      onTerminalInitialWrite(t.id, write)
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="statusbar">
          <div className="status-left">
            <span className={`dot ${sessionOn ? "on" : "off"}`} />
            {sessionOn ? "connected" : "idle"}
            {sessionMeta?.sessionId && (
              <span className="meta">• {sessionMeta.sessionId.slice(0, 8)}</span>
            )}
            {sessionMeta?.model && <span className="meta">• {sessionMeta.model}</span>}
            {sessionMeta?.tools && <span className="meta">• {sessionMeta.tools.length} tools</span>}
          </div>
          <div className="status-right">
            {!previewOpen && (
              <button
                className="stderr-toggle preview-toggle"
                onClick={() => setPreviewOpen(true)}
                title={previewUrl || "open preview"}
              >
                preview{previewUrl ? " ●" : ""}
              </button>
            )}
            {hasStderr && (
              <button className="stderr-toggle" onClick={() => setShowStderr((s) => !s)}>
                stderr ({stderrLines.length})
              </button>
            )}
          </div>
        </div>

        {showStderr && hasStderr && (
          <div className="stderr-panel">
            {stderrLines.map((l, i) => (
              <div key={i} className="stderr-line">{l}</div>
            ))}
          </div>
        )}
      </main>
      {previewOpen && (
        <>
          <div
            className="preview-resizer"
            onPointerDown={previewResize.onPointerDown}
            title="drag to resize"
          />
          <PreviewPanel
            url={previewUrl}
            onUrlChange={setPreviewUrl}
            onClose={() => setPreviewOpen(false)}
            reloadKey={previewKey}
            onReload={() => setPreviewKey((k) => k + 1)}
            width={previewResize.width}
          />
        </>
      )}
    </div>
  );
}

// Top-right stack of transient notifications. Subscribes to the global
// toast bus; each toast auto-dismisses after ~5s. Click to dismiss now.
function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    return subscribeToasts((t) => {
      setToasts((prev) => [...prev, t]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 5000);
    });
  }, []);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role="status"
          onClick={() =>
            setToasts((prev) => prev.filter((x) => x.id !== t.id))
          }
          title="click to dismiss"
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function UpdateBanner({
  version,
  installing,
  onInstall,
  onDismiss,
}: {
  version: string;
  installing: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="update-banner" role="status">
      <div className="update-banner-copy">
        <strong>Blackcrab {version} is available</strong>
        <span>Install the update and restart when you are ready.</span>
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onDismiss}
          disabled={installing}
        >
          Later
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onInstall}
          disabled={installing}
        >
          {installing ? "Installing..." : "Install"}
        </button>
      </div>
    </div>
  );
}

function SettingsModal({
  settings,
  theme,
  grouped,
  onClose,
  onSettingsChange,
  onThemeChange,
  onGroupedChange,
  onPickStartupCwd,
  onUseCurrentCwd,
  onClearStartupCwd,
}: {
  settings: AppSettings;
  theme: AppTheme;
  grouped: boolean;
  onClose: () => void;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  onThemeChange: (theme: AppTheme) => void;
  onGroupedChange: (grouped: boolean) => void;
  onPickStartupCwd: () => void;
  onUseCurrentCwd: () => void;
  onClearStartupCwd: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <div className="settings-kicker">Preferences</div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button
            type="button"
            className="grid-panel-close"
            onClick={onClose}
            title="close settings"
            aria-label="close settings"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="settings-row">
              <span className="settings-label">Theme</span>
              <div className="settings-control">
                <div className="settings-segment" role="group" aria-label="theme">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`settings-segment-btn ${
                        theme === opt.value ? "active" : ""
                      }`}
                      onClick={() => onThemeChange(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={grouped}
                onChange={(e) => onGroupedChange(e.target.checked)}
              />
              <span>Group sidebar by project</span>
            </label>
          </section>

          <section className="settings-section">
            <h3>New Sessions</h3>
            <div className="settings-row">
              <span className="settings-label">Startup project</span>
              <div className="settings-control settings-path-control">
                <input
                  value={settings.startupCwd}
                  readOnly
                  spellCheck={false}
                  placeholder="system default"
                  title={settings.startupCwd || "system default"}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onPickStartupCwd}
                >
                  Pick
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onUseCurrentCwd}
                >
                  Current
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onClearStartupCwd}
                  disabled={!settings.startupCwd}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Model</span>
              <div className="settings-control">
                <select
                  value={settings.defaultModel}
                  onChange={(e) =>
                    onSettingsChange({ defaultModel: e.target.value })
                  }
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <option
                      key={opt.value}
                      value={opt.disabled ? "" : opt.value}
                      disabled={opt.disabled}
                    >
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Permissions</span>
              <div className="settings-control">
                <select
                  value={settings.defaultPermissionMode}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (isPermissionMode(value)) {
                      onSettingsChange({ defaultPermissionMode: value });
                    }
                  }}
                >
                  {PERMISSION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Grid worktrees</span>
              <div className="settings-control">
                <select
                  value={settings.newPanelWorktreeMode}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (isNewPanelWorktreeMode(value)) {
                      onSettingsChange({ newPanelWorktreeMode: value });
                    }
                  }}
                >
                  {NEW_PANEL_WORKTREE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Behavior</h3>
            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={settings.notifyOnTurnComplete}
                onChange={(e) =>
                  onSettingsChange({ notifyOnTurnComplete: e.target.checked })
                }
              />
              <span>Notify when turns finish</span>
            </label>
            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={settings.autoCheckUpdates}
                onChange={(e) =>
                  onSettingsChange({ autoCheckUpdates: e.target.checked })
                }
              />
              <span>Check for updates on launch</span>
            </label>
            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={settings.autoOpenPreview}
                onChange={(e) =>
                  onSettingsChange({ autoOpenPreview: e.target.checked })
                }
              />
              <span>Auto-open local preview links</span>
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}

// In-transcript find overlay. Walks the text nodes under `scrollRef`,
// wraps matches in <mark.search-match>, cycles current match with
// next/prev (Enter / Shift+Enter). Closes on Esc or explicit click.
// Scoped to the single-mode transcript — grid mode's multiple scroll
// regions would need per-panel wiring.
//
// Caveat: if the transcript re-renders while the overlay is open
// (e.g. a streaming turn arrives), the wrapping <mark>s are thrown out
// and the user has to re-type to re-search. This keeps the code simple
// and avoids fighting the memoized transcript output.
function SearchOverlay({
  scrollRef,
  onClose,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const marksRef = useRef<HTMLElement[]>([]);

  function clearMarks() {
    for (const m of marksRef.current) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
    marksRef.current = [];
  }

  function escapeRe(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlight(q: string) {
    clearMarks();
    setTotal(0);
    setCurrent(0);
    const root = scrollRef.current;
    if (!q || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      // Skip text nodes inside input/textarea — those are the composer
      // itself and their content isn't visible transcript text.
      const parent = t.parentElement;
      if (!parent) continue;
      if (parent.closest(".editable-title-input, textarea, input")) continue;
      if (t.nodeValue && t.nodeValue.toLowerCase().includes(q.toLowerCase())) {
        targets.push(t);
      }
    }
    const re = new RegExp(escapeRe(q), "gi");
    const marks: HTMLElement[] = [];
    for (const text of targets) {
      const parent = text.parentNode;
      if (!parent) continue;
      const val = text.nodeValue ?? "";
      const frag = document.createDocumentFragment();
      re.lastIndex = 0;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(val)) !== null) {
        if (m.index > last) {
          frag.appendChild(document.createTextNode(val.slice(last, m.index)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-match";
        mark.textContent = m[0];
        frag.appendChild(mark);
        marks.push(mark);
        last = m.index + m[0].length;
        if (m.index === re.lastIndex) re.lastIndex++; // empty-match guard
      }
      if (last < val.length) {
        frag.appendChild(document.createTextNode(val.slice(last)));
      }
      parent.replaceChild(frag, text);
    }
    marksRef.current = marks;
    setTotal(marks.length);
    if (marks.length > 0) {
      setCurrent(0);
      marks[0].classList.add("active");
      marks[0].scrollIntoView({ block: "center", behavior: "auto" });
    }
  }

  useEffect(() => {
    highlight(query);
    return clearMarks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function jump(delta: number) {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    marks[current]?.classList.remove("active");
    const next = (current + delta + marks.length) % marks.length;
    setCurrent(next);
    marks[next].classList.add("active");
    marks[next].scrollIntoView({ block: "center", behavior: "auto" });
  }

  return (
    <div className="search-overlay" role="search">
      <input
        ref={inputRef}
        className="search-input"
        value={query}
        placeholder="find in transcript"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            jump(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="search-count">
        {total === 0 ? (query ? "0" : "") : `${current + 1} / ${total}`}
      </span>
      <button
        type="button"
        className="search-btn"
        onClick={() => jump(-1)}
        title="previous match (⇧↵)"
        disabled={total === 0}
      >
        ↑
      </button>
      <button
        type="button"
        className="search-btn"
        onClick={() => jump(1)}
        title="next match (↵)"
        disabled={total === 0}
      >
        ↓
      </button>
      <button
        type="button"
        className="search-btn search-close"
        onClick={onClose}
        title="close (esc)"
        aria-label="close search"
      >
        ×
      </button>
    </div>
  );
}

function PreviewPanel({
  url,
  onUrlChange,
  onClose,
  reloadKey,
  onReload,
  width,
}: {
  url: string;
  onUrlChange: (v: string) => void;
  onClose: () => void;
  reloadKey: number;
  onReload: () => void;
  width: number;
}) {
  const [draft, setDraft] = useState(url);

  useEffect(() => {
    setDraft(url);
  }, [url]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== url) onUrlChange(trimmed);
  }

  const canPreview = /^https?:\/\//i.test(url);

  return (
    <aside className="preview" style={{ width }}>
      <div className="preview-head">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder="http://localhost:3000"
          spellCheck={false}
          className="preview-url"
        />
        <button
          type="button"
          className="icon-btn"
          onClick={onReload}
          title="reload"
          disabled={!canPreview}
        >
          ⟳
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            if (!url) return;
            if (!isTauriRuntime()) {
              window.open(url, "_blank", "noopener,noreferrer");
              return;
            }
            openUrl(url).catch((err) => console.error("openUrl failed:", err));
          }}
          title="open in browser"
          disabled={!canPreview}
        >
          ↗
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          title="close preview"
        >
          ×
        </button>
      </div>
      <div className="preview-body">
        {canPreview ? (
          isTauriRuntime() ? (
            <NativePreview url={url} reloadKey={reloadKey} />
          ) : (
            <BrowserPreview url={url} reloadKey={reloadKey} />
          )
        ) : (
          <div className="preview-empty">
            enter a URL above or wait for Claude to start a local server
          </div>
        )}
      </div>
    </aside>
  );
}

function BrowserPreview({ url, reloadKey }: { url: string; reloadKey: number }) {
  return (
    <iframe
      key={`${url}:${reloadKey}`}
      className="preview-frame"
      src={url}
      title="preview"
      sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
    />
  );
}

// Embeds a native Tauri webview over the preview panel area. Bypasses
// X-Frame-Options since it's a real top-level webview, not an iframe.
function NativePreview({ url, reloadKey }: { url: string; reloadKey: number }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<Webview | null>(null);
  const labelRef = useRef<string>("");
  const mountedUrlRef = useRef<string>("");
  const scheduleRef = useRef<(() => void) | null>(null);
  const topInsetRef = useRef<number>(0);

  // Query Tauri once for the native-chrome top inset (title bar on macOS
  // windowed mode). JS `window.outerHeight - window.innerHeight` reports 0
  // inside Tauri because the webview IS the whole content area.
  useEffect(() => {
    invoke<number>("window_top_inset")
      .then((v) => {
        topInsetRef.current = v;
        scheduleRef.current?.();
      })
      .catch(() => {});
  }, []);

  // Mount / unmount: create the webview, tear it down on cleanup.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    let cancelled = false;
    let wv: Webview | null = null;

    (async () => {
      const parent = getCurrentWindow();
      // Use the Tauri-reported inset so the initial bounds are right too.
      let inset = topInsetRef.current;
      if (inset === 0) {
        inset = await invoke<number>("window_top_inset").catch(() => 0);
        topInsetRef.current = inset;
      }
      const rect = el.getBoundingClientRect();
      const label = `preview-${Math.random().toString(36).slice(2, 10)}`;
      labelRef.current = label;
      wv = new Webview(parent, label, {
        url,
        x: Math.round(rect.x),
        y: Math.round(rect.y + inset),
        width: Math.max(10, Math.round(rect.width)),
        height: Math.max(10, Math.round(rect.height)),
      });
      if (cancelled) {
        wv.close().catch(() => {});
        return;
      }
      webviewRef.current = wv;
      mountedUrlRef.current = url;
      // Kick the sync once the webview is actually attached so it lands in
      // the right spot even if the resize observer hasn't fired.
      scheduleRef.current?.();
    })();

    return () => {
      cancelled = true;
      const w = webviewRef.current;
      webviewRef.current = null;
      if (w) w.close().catch(() => {});
      else if (wv) wv.close().catch(() => {});
    };
    // Only mount once; URL changes are handled by a separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the native webview's position and size in sync with the DOM anchor.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;

    let raf = 0;
    const sync = () => {
      raf = 0;
      const wv = webviewRef.current;
      if (!wv) return;
      const r = el.getBoundingClientRect();
      const inset = topInsetRef.current;
      wv.setPosition(
        new LogicalPosition(Math.round(r.x), Math.round(r.y + inset)),
      ).catch((err) => console.error("setPosition failed:", err));
      wv.setSize(
        new LogicalSize(
          Math.max(10, Math.round(r.width)),
          Math.max(10, Math.round(r.height)),
        ),
      ).catch((err) => console.error("setSize failed:", err));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(sync);
    };
    // Expose schedule for the mount effect to call once the webview is ready.
    scheduleRef.current = schedule;

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // On macOS, full-screen transitions remove the title bar, so the inset
    // changes. Re-query it whenever the window size changes.
    const delayedResync = () => {
      invoke<number>("window_top_inset")
        .then((v) => {
          topInsetRef.current = v;
          schedule();
        })
        .catch(() => schedule());
      setTimeout(schedule, 100);
      setTimeout(schedule, 400);
    };
    window.addEventListener("resize", delayedResync);
    document.addEventListener("fullscreenchange", delayedResync);
    window.addEventListener("focus", schedule);

    // During drag resize the native webview would eat pointer events; we
    // hide it while body[data-resizing="true"] is set and restore it when
    // the drag ends.
    const mo = new MutationObserver(() => {
      const wv = webviewRef.current;
      if (!wv) return;
      if (document.body.dataset.resizing === "true") {
        wv.hide().catch(() => {});
      } else {
        wv.show().catch(() => {});
        schedule();
      }
    });
    mo.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-resizing"],
    });

    // Initial pass in case the webview mounted a frame ago.
    schedule();

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", delayedResync);
      document.removeEventListener("fullscreenchange", delayedResync);
      window.removeEventListener("focus", schedule);
      scheduleRef.current = null;
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // URL change (or reload) → navigate via a Rust command, since the JS Webview
  // API doesn't expose navigation directly.
  useEffect(() => {
    const label = labelRef.current;
    if (!label || !url) return;
    if (url === mountedUrlRef.current && reloadKey === 0) return;
    mountedUrlRef.current = url;
    invoke("preview_navigate", { label, url }).catch((err) => {
      console.error("preview_navigate failed:", err);
    });
  }, [url, reloadKey]);

  return <div ref={anchorRef} className="preview-frame-anchor" />;
}

// ---------------- Sidebar ----------------

function shortenPath(p: string): string {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const parts = p.slice(home.length).split("/");
    if (parts.length <= 1) return p;
    const trail = parts.slice(1).join("/");
    return `~/${trail}`;
  }
  return p;
}

function basename(p: string): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function useResizable(
  initial: number,
  min: number,
  max: number,
  direction: "right" | "left",
  storageKey: string,
) {
  const [width, setWidth] = useState<number>(() => {
    const saved = localStorage.getItem(storageKey);
    const n = saved ? parseInt(saved, 10) : NaN;
    if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
    return initial;
  });

  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [width, storageKey]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const sign = direction === "right" ? 1 : -1;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // Flag the body so the native preview webview (which sits above the DOM
      // and would otherwise swallow pointer events) hides itself for the
      // duration of the drag.
      document.body.dataset.resizing = "true";
      // Full-window overlay so iframes (which otherwise capture pointer
      // events) can't hijack the drag once the cursor is over them.
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;cursor:col-resize;";
      document.body.appendChild(overlay);

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const next = Math.max(min, Math.min(max, startW + sign * dx));
        setWidth(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        delete document.body.dataset.resizing;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [width, min, max, direction],
  );

  return { width, onPointerDown };
}

const LOCAL_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s)"'`]*)?/gi;

function extractLocalUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(LOCAL_URL_RE);
  if (!matches) return [];
  return matches.map((u) => u.replace(/0\.0\.0\.0/g, "localhost"));
}

function normalizeLocalUrl(url: string): string {
  return url.replace(/0\.0\.0\.0/g, "localhost");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function barColor(ratio: number): string {
  if (ratio > 0.85) return "var(--err)";
  if (ratio > 0.6) return "#e9c895";
  return "var(--ok)";
}

const Sidebar = memo(function Sidebar({
  sessions,
  activeId,
  loading,
  resumingId,
  onResume,
  onRename,
  onDelete,
  onNew,
  onRefresh,
  cwd,
  projectFilter,
  onProjectFilterChange,
  search,
  onSearchChange,
  grouped,
  onGroupedChange,
  width,
  onResizeStart,
  pinActiveToTop = true,
}: {
  sessions: SessionInfo[];
  activeId?: string;
  loading: boolean;
  resumingId: string | null;
  onResume: (id: string, cwd: string) => void;
  onRename: (id: string, cwd: string, title: string) => Promise<void>;
  onDelete: (id: string, cwd: string, title: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  cwd: string;
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  grouped: boolean;
  onGroupedChange: (value: boolean) => void;
  width: number;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** When false, activeId is used for highlight only — the list
   *  doesn't float the active item to the top or scroll to it. Used
   *  in grid mode so clicking between tiles doesn't reshuffle the
   *  sidebar. */
  pinActiveToTop?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // The active session is reordered to the top of the filtered list, so
  // snapping the sidebar to scrollTop: 0 puts it in view immediately.
  // Skipped when pinActiveToTop is false (grid-mode highlight).
  useEffect(() => {
    if (!activeId || !pinActiveToTop) return;
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: 0, behavior: "auto" });
  }, [activeId, pinActiveToTop]);
  const shortCwd = useMemo(() => shortenPath(cwd), [cwd]);

  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (!s.cwd) continue;
      counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([cwd, count]) => ({ cwd, count, name: basename(cwd) || cwd }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
  }, [sessions]);

  // Content search runs in Rust, debounced, and augments the
  // title/basename/id filter. Maps session id -> preview snippet.
  const [contentHits, setContentHits] = useState<Map<
    string,
    { preview: string; matchCount: number }
  > | null>(null);
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setContentHits(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      invoke<Array<{ session_id: string; match_count: number; preview: string }>>(
        "search_sessions",
        { query: q },
      )
        .then((hits) => {
          if (cancelled) return;
          const m = new Map<string, { preview: string; matchCount: number }>();
          for (const h of hits) {
            m.set(h.session_id, {
              preview: h.preview,
              matchCount: h.match_count,
            });
          }
          setContentHits(m);
        })
        .catch(() => {
          if (!cancelled) setContentHits(null);
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [search]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = sessions.filter((s) => {
      if (projectFilter && s.cwd !== projectFilter) return false;
      if (!q) return true;
      if (
        s.title.toLowerCase().includes(q) ||
        basename(s.cwd).toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      ) {
        return true;
      }
      // Fall through to the content-search result map.
      return contentHits ? contentHits.has(s.id) : false;
    });
    // Only float the active to the top in flat mode — in grouped mode it
    // belongs under its project header. Also suppressed when pinActiveToTop
    // is false (grid mode) so tile-switching doesn't reorder the list.
    if (pinActiveToTop && !grouped && activeId) {
      const active = matches.find((s) => s.id === activeId);
      if (active && matches[0]?.id !== activeId) {
        return [active, ...matches.filter((s) => s.id !== activeId)];
      }
    }
    return matches;
  }, [
    sessions,
    projectFilter,
    search,
    activeId,
    grouped,
    pinActiveToTop,
    contentHits,
  ]);

  // Group filtered sessions by project basename when the toggle is on.
  const groupList = useMemo(() => {
    if (!grouped) return null;
    const byProject = new Map<
      string,
      { cwd: string; name: string; sessions: SessionInfo[] }
    >();
    for (const s of filtered) {
      const key = s.cwd || "unknown";
      const bucket = byProject.get(key);
      if (bucket) {
        bucket.sessions.push(s);
      } else {
        byProject.set(key, {
          cwd: s.cwd,
          name: basename(s.cwd) || key,
          sessions: [s],
        });
      }
    }
    return Array.from(byProject.entries())
      .map(([key, v]) => ({
        key,
        ...v,
        latest: v.sessions.reduce((m, s) => Math.max(m, s.mtime_ms), 0),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [filtered, grouped]);

  return (
    <aside className="sidebar" style={{ width }}>
      <div
        className="sidebar-resizer"
        onPointerDown={onResizeStart}
        title="drag to resize"
      />
      <div className="sidebar-head">
        <div className="sidebar-title">sessions</div>
        <button className="icon-btn" onClick={onRefresh} title="refresh">
          ⟳
        </button>
      </div>
      <div className="sidebar-cwd" title={cwd}>{shortCwd || "…"}</div>
      <button className="btn btn-new" onClick={onNew}>
        + new session
      </button>
      <div className="sidebar-search">
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="search sessions…"
          spellCheck={false}
        />
        {search && (
          <button
            type="button"
            className="search-clear"
            onClick={() => onSearchChange("")}
            title="clear"
            aria-label="clear search"
          >
            ×
          </button>
        )}
      </div>
      <div className="sidebar-filter">
        <select
          value={projectFilter}
          onChange={(e) => onProjectFilterChange(e.target.value)}
          title={projectFilter || "all projects"}
        >
          <option value="">all projects ({sessions.length})</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>
              {p.name} ({p.count})
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`icon-btn sidebar-group-toggle ${grouped ? "active" : ""}`}
          onClick={() => onGroupedChange(!grouped)}
          title={grouped ? "flat list" : "group by project"}
          aria-pressed={grouped}
        >
          {grouped ? "☰" : "⫶"}
        </button>
      </div>
      <div className="sessions-list" ref={listRef}>
        {loading && filtered.length === 0 && (
          <div className="sessions-empty">loading…</div>
        )}
        {!loading && filtered.length === 0 && sessions.length === 0 && (
          <div className="sessions-empty">no past sessions found</div>
        )}
        {!loading && filtered.length === 0 && sessions.length > 0 && (
          <div className="sessions-empty">no sessions match the filter</div>
        )}
        {groupList
          ? groupList.map((g) => (
              <section key={g.key} className="session-group">
                <header className="session-group-head" title={g.cwd}>
                  <span className="session-group-name">{g.name}</span>
                  <span className="session-group-count">{g.sessions.length}</span>
                </header>
                <div className="session-group-body">
                  {g.sessions.map((s) =>
                    renderSessionItem(s, {
                      activeId,
                      resumingId,
                      onResume,
                      onRename,
                      onDelete,
                      itemRefs,
                      grouped: true,
                      contentHit: contentHits?.get(s.id),
                    }),
                  )}
                </div>
              </section>
            ))
          : filtered.map((s) =>
              renderSessionItem(s, {
                activeId,
                resumingId,
                onResume,
                onRename,
                onDelete,
                itemRefs,
                grouped: false,
                contentHit: contentHits?.get(s.id),
              }),
            )}
      </div>
    </aside>
  );
});

// Inline-editable text. Click to edit; Enter or blur saves, Esc cancels.
// Used for conversation titles in both the sidebar and grid panel header.
export function EditableTitle({
  value,
  onSave,
  className,
  placeholder,
  title,
}: {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  className?: string;
  placeholder?: string;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (editing) {
    const commit = async () => {
      const next = draft.trim();
      setEditing(false);
      if (next && next !== value) {
        await onSave(next);
      } else {
        setDraft(value);
      }
    };
    return (
      <input
        ref={inputRef}
        className={`editable-title-input ${className ?? ""}`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        onBlur={() => void commit()}
      />
    );
  }
  return (
    <span
      className={`editable-title ${className ?? ""}`}
      title={title}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }
      }}
    >
      {value || placeholder || ""}
    </span>
  );
}

function renderSessionItem(
  s: SessionInfo,
  ctx: {
    activeId?: string;
    resumingId: string | null;
    onResume: (id: string, cwd: string) => void;
    onRename: (id: string, cwd: string, title: string) => Promise<void>;
    onDelete: (id: string, cwd: string, title: string) => void;
    itemRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
    grouped: boolean;
    contentHit?: { preview: string; matchCount: number };
  },
) {
  const ctxRatio =
    s.context_limit > 0 ? Math.min(1, s.context_tokens / s.context_limit) : 0;
  // Cost is a per-token API-equivalent figure; on Max it isn't real money
  // so we show output tokens as the secondary usage bar. Once the user
  // wires in an API key we can swap this back to $.
  const outputBudget = 200_000;
  const outputRatio = Math.min(1, s.output_tokens / outputBudget);
  const isActive = ctx.activeId === s.id;
  const isLoading = ctx.resumingId === s.id;
  return (
    <div
      key={s.id}
      role="button"
      tabIndex={0}
      ref={(el) => {
        if (el) ctx.itemRefs.current.set(s.id, el);
        else ctx.itemRefs.current.delete(s.id);
      }}
      className={`session-item ${isActive ? "active" : ""} ${isLoading ? "loading" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (
          target?.closest(
            ".session-delete, .editable-title, .editable-title-input",
          )
        ) {
          return;
        }
        e.preventDefault();
        e.currentTarget.focus();
        ctx.onResume(s.id, s.cwd);
      }}
      onClick={(e) => {
        if (e.detail === 0) ctx.onResume(s.id, s.cwd);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.onResume(s.id, s.cwd);
        }
      }}
      title={`${s.id}\n${s.cwd}\nmodel: ${s.model || "?"}\ncontext: ${formatTokens(s.context_tokens)} / ${formatTokens(s.context_limit)} (${(ctxRatio * 100).toFixed(0)}%)\ncost: $${s.total_cost_usd.toFixed(4)}\noutput: ${formatTokens(s.output_tokens)} tokens`}
    >
      {isLoading && <span className="session-loading-bar" />}
      <EditableTitle
        className="session-title"
        value={s.title || ""}
        placeholder="(untitled)"
        onSave={(next) => ctx.onRename(s.id, s.cwd, next)}
      />
      <button
        type="button"
        className="session-delete"
        title="move session to trash"
        aria-label="delete session"
        onClick={(e) => {
          e.stopPropagation();
          ctx.onDelete(s.id, s.cwd, s.title || "(untitled)");
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        ×
      </button>
      {!ctx.grouped && (
        <span className="session-project">{basename(s.cwd) || "unknown"}</span>
      )}
      <div className="session-bar">
        <span className="session-bar-label">ctx</span>
        <div className="session-bar-track">
          <div
            className="session-bar-fill"
            style={{
              width: `${(ctxRatio * 100).toFixed(1)}%`,
              background: barColor(ctxRatio),
            }}
          />
        </div>
        <span className="session-bar-value">{formatTokens(s.context_tokens)}</span>
      </div>
      <div className="session-bar">
        <span className="session-bar-label">out</span>
        <div className="session-bar-track">
          <div
            className="session-bar-fill"
            style={{
              width: `${(outputRatio * 100).toFixed(1)}%`,
              background: barColor(outputRatio),
            }}
          />
        </div>
        <span className="session-bar-value">{formatTokens(s.output_tokens)}</span>
      </div>
      <div className="session-meta">
        <span>{relativeTime(s.mtime_ms)}</span>
        <span className="session-count">{s.message_count} msg</span>
      </div>
      {ctx.contentHit && (
        <div className="session-hit-preview" title={ctx.contentHit.preview}>
          <span className="session-hit-count">
            {ctx.contentHit.matchCount} match
            {ctx.contentHit.matchCount === 1 ? "" : "es"}
          </span>
          <span className="session-hit-snippet">{ctx.contentHit.preview}</span>
        </div>
      )}
    </div>
  );
}

// Module-level mirror of App's toolUseMapRef so memoized EntryViews don't
// have to receive (and compare) the Map as a prop. Keyed by panel so each
// LivePanel in grid mode can have its own tool registry.
const panelToolUseMaps = new Map<string, Map<string, ToolMeta>>();
// Back-compat shim for the main single-panel path.
const toolUseMapGlobal: { current: Map<string, ToolMeta> } = {
  current: (() => {
    const m = new Map<string, ToolMeta>();
    panelToolUseMaps.set("main", m);
    return m;
  })(),
};

const computerUseControlsRef: {
  current: {
    send: (terminalId: string, data: string) => void;
    stop: (terminalId: string) => void;
  } | null;
} = { current: null };

export function toolUseMapForPanel(
  panelId: string,
): Map<string, ToolMeta> | undefined {
  return panelToolUseMaps.get(panelId);
}

export function setToolUseMapForPanel(
  panelId: string,
  map: Map<string, ToolMeta> | null,
): void {
  if (map) panelToolUseMaps.set(panelId, map);
  else panelToolUseMaps.delete(panelId);
}

type EntryViewProps = { entry: Entry; panelId?: string };

export const EntryView = memo(({ entry, panelId = "main" }: EntryViewProps) => {
  if (entry.kind === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-role">you</div>
        <div className="msg-body">
          {entry.text.split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="msg msg-assistant">
        <div className="msg-role">claude</div>
        <div className="msg-body">
          {entry.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>
      </div>
    );
  }

  if (entry.kind === "tool_result") {
    const map =
      panelToolUseMaps.get(panelId) ?? toolUseMapGlobal.current;
    const meta = map.get(entry.toolUseId);
    return (
      <ToolResultView
        toolName={meta?.name}
        toolInput={meta?.input}
        content={entry.content}
        isError={entry.isError}
      />
    );
  }

  if (entry.kind === "computer_use") {
    return <ComputerUseEntryView entry={entry} />;
  }

  if (entry.kind === "system") {
    return <div className="sysline">{entry.text}</div>;
  }

  if (entry.kind === "result") {
    return (
      <div className={`sysline ${entry.isError ? "err" : ""}`}>
        done • {entry.text}
      </div>
    );
  }

  return null;
});

function ComputerUseEntryView({
  entry,
}: {
  entry: Extract<Entry, { kind: "computer_use" }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  const sendRef = useRef<(data: string) => void>(() => {});
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new XTerm({
      cursorBlink: false,
      disableStdin: false,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12.5,
      rows: 18,
      scrollback: 2500,
      convertEol: true,
      theme: {
        background: "#080808",
        foreground: "#ededed",
        cursor: "#e94545",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    const writeSub = term.onData((data) => sendRef.current(data));
    try {
      fit.fit();
    } catch {}
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(el);
    return () => {
      writeSub.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (entry.output.length < writtenRef.current) {
      term.reset();
      writtenRef.current = 0;
    }
    const next = entry.output.slice(writtenRef.current);
    if (!next) return;
    writtenRef.current = entry.output.length;
    term.write(next, () => {
      try {
        term.scrollToBottom();
      } catch {}
    });
  }, [entry.output]);

  const canSend = entry.status !== "done" && entry.status !== "error";
  const needsMcp = needsComputerUseEnablement(entry.output);
  const send = (data: string) => {
    if (!canSend) return;
    computerUseControlsRef.current?.send(entry.terminalId, data);
  };
  sendRef.current = send;
  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    send(`${text}\r`);
    setDraft("");
  };

  return (
    <div className="msg msg-assistant msg-computer-use">
      <div className="msg-role">computer use</div>
      <div className="msg-body computer-use-inline">
        <div className="computer-use-inline-head">
          <span className={`computer-use-status ${entry.status}`}>
            {entry.status}
          </span>
          <span className="computer-use-inline-note">
            sidecar Claude Code session
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => computerUseControlsRef.current?.stop(entry.terminalId)}
            disabled={entry.status === "done"}
          >
            stop
          </button>
        </div>
        {entry.error && (
          <div className="computer-use-inline-error">{entry.error}</div>
        )}
        {needsMcp && (
          <div className="computer-use-inline-alert">
            computer-use is not enabled for this session. Open <code>/mcp</code>{" "}
            and enable the built-in computer-use server.
          </div>
        )}
        <div
          ref={containerRef}
          className="computer-use-inline-terminal"
          onMouseDown={() => termRef.current?.focus()}
          title="click here to focus; your keyboard input is sent to the computer-use worker"
        />
        <div className="computer-use-inline-controls">
          <button
            type="button"
            className={`btn btn-secondary ${needsMcp ? "mcp-attention" : ""}`}
            onClick={() => send("/mcp\r")}
            disabled={!canSend}
          >
            open /mcp
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => send("y")} disabled={!canSend}>
            y
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => send("n")} disabled={!canSend}>
            n
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => send("\x1b[A")} disabled={!canSend}>
            ↑
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => send("\x1b[B")} disabled={!canSend}>
            ↓
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => send("\r")} disabled={!canSend}>
            enter
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => send("\x1b")} disabled={!canSend}>
            esc
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendDraft();
              }
            }}
            placeholder="reply to computer-use worker"
            disabled={!canSend}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={sendDraft}
            disabled={!canSend || !draft.trim()}
          >
            send
          </button>
        </div>
        <div className="computer-use-inline-hint">
          macOS privacy prompts still need to be approved in the system dialog.
        </div>
      </div>
    </div>
  );
}

// Module-level handler set by App so markdown links can open in the side
// preview panel without us re-creating mdComponents on every render.
const linkClickHandlerRef: { current: ((url: string) => void) | null } = {
  current: null,
};

// Event-delegation handler for precompiled markdown (dangerouslySetInnerHTML
// path). Walks up the event target to find an anchor and routes external URLs
// through the preview handler instead of letting the webview navigate.
function handleMarkdownClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const anchor = target.closest("a") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  if (linkClickHandlerRef.current) {
    linkClickHandlerRef.current(href);
  } else {
    openUrl(href).catch((err) => console.error("openUrl failed:", err));
  }
}

function CompiledMarkdown({
  text,
  html,
  repo,
  className,
}: {
  text: string;
  html?: string;
  repo?: string;
  className: string;
}) {
  // Historical transcripts are cached as raw markdown so sidebar clicks
  // don't synchronously compile up to 200 old messages. Only rows that
  // PlainTranscript actually mounts pay this cost.
  const rendered = useMemo(
    () => html ?? compileMarkdown(text, repo),
    [html, text, repo],
  );
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: rendered }}
      onClick={handleMarkdownClick}
    />
  );
}

function BlockView({ block }: { block: Block }) {
  // Streaming can leave sparse slots in the blocks array if the CLI
  // emits `content_block_start` for index N before N-1 lands. Render
  // nothing for those holes instead of crashing the whole transcript.
  if (!block) return null;
  if (block.type === "text") {
    const tb = block as TextBlock;
    const text = tb.text ?? "";
    // During streaming, skip the markdown parse on every delta — we render
    // plain-text paragraphs and swap to markdown once the block finalizes.
    if (tb._streaming) {
      return <StreamingText text={text} />;
    }
    return (
      <CompiledMarkdown
        className="block text markdown"
        text={text}
        html={tb._html}
        repo={tb._repo}
      />
    );
  }

  if (block.type === "thinking") {
    const tb = block as ThinkingBlock;
    const t = tb.thinking ?? "";
    if (tb._streaming) {
      return (
        <details className="block thinking" open>
          <summary>thinking</summary>
          <pre className="thinking-stream">{t}</pre>
        </details>
      );
    }
    return (
      <details className="block thinking" open>
        <summary>thinking</summary>
        <CompiledMarkdown
          className="markdown"
          text={t}
          html={tb._html}
          repo={tb._repo}
        />
      </details>
    );
  }

  if (block.type === "tool_use") {
    return <ToolUseView block={block as ToolUseBlock} />;
  }

  return (
    <details className="block unknown">
      <summary>{block.type}</summary>
      <pre>{JSON.stringify(block, null, 2)}</pre>
    </details>
  );
}

// ---------------- Tool Use views ----------------

function tryParsePartial(json?: string): unknown | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    for (const tail of ['"}', '}', '"]}', ']}', ']', '"']) {
      try {
        return JSON.parse(json + tail);
      } catch {}
    }
    return null;
  }
}

function useToolInput(block: ToolUseBlock): { input: Record<string, unknown> | null; streaming: boolean } {
  return useMemo(() => {
    const streaming = block._inputJson !== undefined;
    if (streaming) {
      const parsed = tryParsePartial(block._inputJson);
      return {
        input: (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null),
        streaming: true,
      };
    }
    const input = block.input as Record<string, unknown> | null | undefined;
    return { input: input ?? null, streaming: false };
  }, [block.input, block._inputJson]);
}

function ToolUseView({ block }: { block: ToolUseBlock }) {
  const { input, streaming } = useToolInput(block);
  const name = block.name ?? "tool";

  const header = (
    <span className="tool-head">
      <span className="tool-name">{name}</span>
      {streaming && <span className="tool-streaming">…</span>}
    </span>
  );

  if (!input) {
    return (
      <div className="tool-block">
        <div className="tool-head-row">{header}</div>
        {streaming && <div className="tool-waiting">receiving input…</div>}
      </div>
    );
  }

  switch (name) {
    case "Bash":
      return <BashUse header={header} input={input} streaming={streaming} />;
    case "Read":
      return <ReadUse header={header} input={input} />;
    case "Edit":
      return <EditUse header={header} input={input} />;
    case "MultiEdit":
      return <MultiEditUse header={header} input={input} />;
    case "Write":
      return <WriteUse header={header} input={input} streaming={streaming} />;
    case "Glob":
      return <GlobUse header={header} input={input} />;
    case "Grep":
      return <GrepUse header={header} input={input} />;
    case "TodoWrite":
      return <TodoWriteUse header={header} input={input} />;
    case "WebFetch":
    case "WebSearch":
      return <WebUse header={header} input={input} name={name} />;
    case "Task":
      return <TaskUse header={header} input={input} />;
    default:
      return <GenericUse header={header} input={input} />;
  }
}

function BashUse({
  header,
  input,
  streaming,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
  streaming: boolean;
}) {
  const command = String(input.command ?? "");
  const description = input.description ? String(input.description) : "";
  const runBg = Boolean(input.run_in_background);
  return (
    <div className="tool-block bash">
      <div className="tool-head-row">
        {header}
        {description && <span className="tool-subtitle">{description}</span>}
        {runBg && <span className="tool-tag">bg</span>}
      </div>
      <pre className="terminal">
        <span className="prompt">$ </span>
        <span className="cmd">{command}</span>
        {streaming && <span className="caret" />}
      </pre>
    </div>
  );
}

function ReadUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const path = String(input.file_path ?? "");
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;
  const range =
    offset != null || limit != null
      ? ` (${offset ?? 0}–${offset != null && limit != null ? offset + limit : limit ?? "end"})`
      : "";
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <span className="tool-path">{path || "…"}{range}</span>
      </div>
    </div>
  );
}

function EditUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const path = String(input.file_path ?? "");
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  const replaceAll = Boolean(input.replace_all);
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <span className="tool-path">{path || "…"}</span>
        {replaceAll && <span className="tool-tag">all</span>}
      </div>
      <DiffView oldStr={oldStr} newStr={newStr} />
    </div>
  );
}

function MultiEditUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const path = String(input.file_path ?? "");
  const edits = (input.edits as Array<Record<string, unknown>>) ?? [];
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <span className="tool-path">{path || "…"}</span>
        <span className="tool-tag">{edits.length} edit{edits.length === 1 ? "" : "s"}</span>
      </div>
      {edits.map((ed, i) => (
        <DiffView
          key={i}
          oldStr={String(ed.old_string ?? "")}
          newStr={String(ed.new_string ?? "")}
        />
      ))}
    </div>
  );
}

function WriteUse({
  header,
  input,
  streaming,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
  streaming: boolean;
}) {
  const path = String(input.file_path ?? "");
  const content = String(input.content ?? "");
  const lines = content.split("\n");
  const preview = lines.slice(0, 20).join("\n");
  const isLong = lines.length > 20;
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <span className="tool-path">{path || "…"}</span>
        <span className="tool-tag">{lines.length} lines</span>
      </div>
      {isLong ? (
        <details>
          <summary>show content</summary>
          <pre className="code-preview">{content}{streaming && <span className="caret" />}</pre>
        </details>
      ) : (
        <pre className="code-preview">{preview}{streaming && <span className="caret" />}</pre>
      )}
    </div>
  );
}

function GlobUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const pattern = String(input.pattern ?? "");
  const path = input.path ? String(input.path) : "";
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <code className="tool-code">{pattern || "…"}</code>
        {path && <span className="tool-path">in {path}</span>}
      </div>
    </div>
  );
}

function GrepUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const pattern = String(input.pattern ?? "");
  const glob = input.glob ? String(input.glob) : "";
  const type = input.type ? String(input.type) : "";
  const path = input.path ? String(input.path) : "";
  const filters = [glob, type].filter(Boolean).join(" ");
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <code className="tool-code">{pattern || "…"}</code>
        {filters && <span className="tool-tag">{filters}</span>}
        {path && <span className="tool-path">in {path}</span>}
      </div>
    </div>
  );
}

type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

function TodoWriteUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const todos = (input.todos as Todo[]) ?? [];
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <span className="tool-tag">{todos.length} task{todos.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="todos">
        {todos.map((t, i) => (
          <li key={i} className={`todo todo-${t.status}`}>
            <span className="todo-marker">
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}
            </span>
            <span className="todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WebUse({
  header,
  input,
  name,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
  name: string;
}) {
  const target =
    name === "WebFetch" ? String(input.url ?? "") : String(input.query ?? "");
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        <span className="tool-path">{target || "…"}</span>
      </div>
    </div>
  );
}

function TaskUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  const description = String(input.description ?? "");
  const subagent = input.subagent_type ? String(input.subagent_type) : "";
  const prompt = String(input.prompt ?? "");
  return (
    <div className="tool-block">
      <div className="tool-head-row">
        {header}
        {subagent && <span className="tool-tag">{subagent}</span>}
        {description && <span className="tool-subtitle">{description}</span>}
      </div>
      {prompt && (
        <details>
          <summary>prompt</summary>
          <pre className="code-preview">{prompt}</pre>
        </details>
      )}
    </div>
  );
}

function GenericUse({
  header,
  input,
}: {
  header: React.ReactNode;
  input: Record<string, unknown>;
}) {
  return (
    <div className="tool-block">
      <div className="tool-head-row">{header}</div>
      <pre className="code-preview">{JSON.stringify(input, null, 2)}</pre>
    </div>
  );
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  if (!oldStr && !newStr) return null;
  return (
    <div className="diff">
      {oldStr && (
        <div className="diff-block diff-old">
          {oldStr.split("\n").map((l, i) => (
            <div key={i} className="diff-line">
              <span className="diff-marker">-</span>
              <span className="diff-text">{l || "\u00A0"}</span>
            </div>
          ))}
        </div>
      )}
      {newStr && (
        <div className="diff-block diff-new">
          {newStr.split("\n").map((l, i) => (
            <div key={i} className="diff-line">
              <span className="diff-marker">+</span>
              <span className="diff-text">{l || "\u00A0"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Tool Result view ----------------

function ToolResultView({
  toolName,
  toolInput,
  content,
  isError,
}: {
  toolName?: string;
  toolInput?: unknown;
  content: ToolResultBlock["content"];
  isError?: boolean;
}) {
  const text = useMemo(() => {
    if (typeof content === "string") return content;
    return content
      .map((p) => (p.type === "text" ? p.text ?? "" : JSON.stringify(p)))
      .join("\n");
  }, [content]);

  const name = toolName ?? "tool";
  const short = name === "TodoWrite" || name === "Edit" || name === "MultiEdit" || name === "Write";
  const lines = text.split("\n");
  const input = (toolInput as Record<string, unknown>) ?? {};

  if (short && !isError) {
    return (
      <div className="tool-result quiet">
        <span className="tool-result-check">✓</span>
        <span className="tool-result-label">{name}</span>
        {input.file_path ? (
          <span className="tool-result-path">{String(input.file_path)}</span>
        ) : null}
      </div>
    );
  }

  const bodyClass = `tool-result-body ${name === "Bash" ? "terminal-out" : ""}`;
  // Anything beyond a handful of lines is folded by default. Errors stay
  // open so failures don't hide. <details>'s own toggle state is used so
  // each individual result remembers its open/closed across re-renders.
  const shouldFold = !isError && (lines.length > 4 || text.length > 240);
  const firstLine = (lines.find((l) => l.trim().length > 0) || "").slice(0, 140);
  const foldSummary = firstLine
    ? `${firstLine}${lines.length > 1 ? " …" : ""}`
    : `${lines.length} lines`;

  return (
    <div className={`tool-result ${isError ? "err" : ""}`}>
      <div className="tool-result-head">
        <span className="tool-result-label">{name}</span>
        {isError && <span className="tool-tag err">error</span>}
        <span className="tool-result-meta">{lines.length} lines</span>
      </div>
      {shouldFold ? (
        <details className="tool-result-fold">
          <summary className="tool-result-fold-summary">
            <span className="tool-result-fold-preview">{foldSummary}</span>
          </summary>
          <pre className={bodyClass}>{text}</pre>
        </details>
      ) : (
        <pre className={bodyClass}>{text}</pre>
      )}
    </div>
  );
}

function StreamingText({ text }: { text: string }) {
  // Split once on newlines — cheap vs. a full markdown parse per delta.
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <div className="block text streaming-text">
      {lines.map((line, i) => (
        <p key={i}>{line || "\u00A0"}</p>
      ))}
    </div>
  );
}

// Plain scrollable transcript — no virtualization, just DOM. For <= ~300
// entries with precompiled HTML per message, this is dramatically faster
// than Virtuoso's measurement pass on every session switch.
// Grid of up to 6 LIVE session panels, each with its own claude subprocess.
function LiveGrid({
  panels,
  sessions,
  sessionCache,
  permissionMode,
  defaultCwd,
  defaultModel,
  selectedId,
  newPanelCwds,
  newPanelWorktree,
  onAddPanel,
  onSelect,
  onRemove,
  onRename,
  onReorder,
  onSessionStarted,
  onExpand,
}: {
  panels: string[];
  sessions: SessionInfo[];
  sessionCache: Map<
    string,
    { entries: Entry[]; toolUseMap: Map<string, ToolMeta>; mtime_ms: number }
  >;
  permissionMode: string;
  defaultCwd: string;
  defaultModel: string;
  selectedId: string | null;
  newPanelCwds: Record<string, string>;
  newPanelWorktree: Record<string, boolean>;
  onAddPanel: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, cwd: string, title: string) => Promise<void>;
  onReorder: (fromId: string, toId: string) => void;
  onSessionStarted: (panelId: string, sessionId: string) => void;
  onExpand: (sessionId: string, cwd: string, panelId: string) => void;
}) {
  // Draggable divider between the two rows lets the user rebalance tile
  // heights. `topFraction` is null until the user drags — then it takes
  // over. Before that, we pick a sensible default based on how many
  // panels are in play (lean toward a taller top row when the bottom
  // row is mostly just the `+ new panel` affordance).
  const containerRef = useRef<HTMLDivElement>(null);
  const [topFraction, setTopFraction] = useState<number | null>(() => {
    const raw = localStorage.getItem("gridRowTopFraction");
    const n = raw ? parseFloat(raw) : NaN;
    if (!Number.isFinite(n)) return null;
    return Math.max(0.15, Math.min(0.85, n));
  });
  useEffect(() => {
    if (topFraction === null) return;
    localStorage.setItem("gridRowTopFraction", String(topFraction));
  }, [topFraction]);
  const onRowDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.body.dataset.resizing = "true";
      // Full-window overlay so any child webviews can't hijack the drag.
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;cursor:row-resize;";
      document.body.appendChild(overlay);
      const move = (ev: PointerEvent) => {
        const y = ev.clientY - rect.top;
        const frac = y / rect.height;
        setTopFraction(Math.max(0.15, Math.min(0.85, frac)));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        delete document.body.dataset.resizing;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [],
  );

  // Column weights — one array per column count (2 or 3), each summing
  // arbitrarily. grid-template-columns uses `${w}fr` so the ratio is
  // what matters, not the absolute values. Clamp at drag time to keep
  // each column >= 15% of total.
  const [colWeightsByCount, setColWeightsByCount] = useState<
    Record<number, number[]>
  >(() => {
    try {
      const raw = localStorage.getItem("gridColWeightsByCount");
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const out: Record<number, number[]> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = parseInt(k, 10);
          if (Array.isArray(v) && v.every((x) => typeof x === "number")) {
            out[n] = v as number[];
          }
        }
        return out;
      }
    } catch {}
    return {};
  });
  useEffect(() => {
    localStorage.setItem(
      "gridColWeightsByCount",
      JSON.stringify(colWeightsByCount),
    );
  }, [colWeightsByCount]);
  const onColDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, columnCount: number, idx: number) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.body.dataset.resizing = "true";
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;cursor:col-resize;";
      document.body.appendChild(overlay);
      // Snapshot the weights at drag start so the move math stays
      // stable even if setState batching trails behind pointer events.
      const startWeights =
        (colWeightsByCount[columnCount] ??
          Array.from({ length: columnCount }, () => 1)).slice();
      const total = startWeights.reduce((a, b) => a + b, 0);
      const pairSum = startWeights[idx] + startWeights[idx + 1];
      const minWeight = total * 0.15;
      const startX = e.clientX;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const fracDelta = (dx / rect.width) * total;
        let newLeft = startWeights[idx] + fracDelta;
        newLeft = Math.max(minWeight, Math.min(pairSum - minWeight, newLeft));
        const newRight = pairSum - newLeft;
        const next = startWeights.slice();
        next[idx] = newLeft;
        next[idx + 1] = newRight;
        setColWeightsByCount((prev) => ({ ...prev, [columnCount]: next }));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        delete document.body.dataset.resizing;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [colWeightsByCount],
  );

  // Drag state for panel reordering. `dragId` is the panel currently
  // being dragged; `overId` is the panel it's hovering over and would
  // swap with on drop. Both clear on dragend/drop or when the drag
  // leaves every tile.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (panels.length === 0) {
    return (
      <section className="grid-transcripts empty-grid">
        <div className="grid-empty-hint">
          <p>select one or more conversations to enter grid mode</p>
          <p className="hint">
            click a session in the sidebar to pin it here, or hit
            <span className="inline-kbd">+ new panel</span> below to start a
            fresh one.
          </p>
          <button
            type="button"
            className="btn btn-secondary grid-empty-new"
            onClick={onAddPanel}
          >
            + new panel
          </button>
        </div>
      </section>
    );
  }
  // Columns are chosen by panel count alone (the add-tile no longer
  // occupies a full column slot when the panel row would otherwise be
  // complete). Rows follow: ceil(panels / columns).
  const columns =
    panels.length === 0 ? 1 : panels.length <= 4 ? 2 : 3;
  const rowCount = Math.max(1, Math.ceil(panels.length / columns));
  // If the panels fill every column of the last row, put the + new
  // panel button into a narrow full-width strip below the grid so it
  // doesn't swallow a whole tile's worth of height. Otherwise it
  // takes the remaining slot in the last row of the grid.
  const addAsStrip =
    panels.length > 0 &&
    panels.length < 6 &&
    panels.length % columns === 0;
  const addInGrid = panels.length > 0 && panels.length < 6 && !addAsStrip;
  const showRowDivider = rowCount >= 2;
  const defaultTopFraction = 0.5;
  const effectiveTopFraction = topFraction ?? defaultTopFraction;
  // Equal-height rows by default; the divider only rebalances the
  // first two. (With our current max of 2 rows this degenerates to
  // `${frac}fr ${1-frac}fr`.)
  const gridTemplateRows = showRowDivider
    ? Array.from({ length: rowCount }, (_, i) =>
        i === 0
          ? `${effectiveTopFraction}fr`
          : `${(1 - effectiveTopFraction) / (rowCount - 1)}fr`,
      ).join(" ")
    : undefined;
  const colWeights =
    (columns > 1 && colWeightsByCount[columns]?.length === columns
      ? colWeightsByCount[columns]
      : Array.from({ length: columns }, () => 1));
  const gridTemplateColumns =
    columns === 1
      ? "minmax(0, 1fr)"
      : colWeights.map((w) => `minmax(0, ${w}fr)`).join(" ");
  // Compute % positions for the N-1 vertical dividers between columns.
  const colDividerLefts: number[] = [];
  if (columns > 1) {
    const totalW = colWeights.reduce((a, b) => a + b, 0);
    let cum = 0;
    for (let i = 0; i < colWeights.length - 1; i++) {
      cum += colWeights[i];
      colDividerLefts.push((cum / totalW) * 100);
    }
  }
  return (
    <section className="grid-transcripts live">
      <div
        ref={containerRef}
        className="grid-panels-area"
        style={{
          gridTemplateColumns,
          gridTemplateRows,
        }}
      >
      {panels.map((id) => {
        const info = sessions.find((s) => s.id === id);
        const isNewPanel = id in newPanelCwds;
        // Pinned panel whose session info hasn't hydrated yet — wait
        // instead of booting with an empty cwd (which would fail spawn
        // with "project directory doesn't exist"). Happens on app start
        // when gridPanels is restored from localStorage before
        // refreshSessions finishes.
        if (!isNewPanel && !info) {
          return (
            <div key={id} className="grid-panel loading-skeleton">
              <span className="grid-panel-loading">loading session…</span>
            </div>
          );
        }
        const panelCwd = isNewPanel
          ? newPanelCwds[id]
          : info!.cwd || defaultCwd;
        const panelModel = isNewPanel
          ? defaultModel
          : info!.model || defaultModel;
        return (
          <LivePanel
            key={id}
            panelId={id}
            initialSessionId={isNewPanel ? undefined : id}
            initialCwd={panelCwd}
            initialModel={panelModel}
            initialTitle={isNewPanel ? "new session" : info?.title}
            initialMtime={isNewPanel ? 0 : info?.mtime_ms ?? 0}
            permissionMode={info?.permission_mode || permissionMode}
            repo=""
            sessionCache={sessionCache}
            isActive={selectedId === id}
            useWorktree={isNewPanel ? !!newPanelWorktree[id] : false}
            onFocus={() => onSelect(id)}
            onRemove={() => onRemove(id)}
            onRename={onRename}
            onSessionStarted={onSessionStarted}
            onExpand={onExpand}
            dragging={dragId === id}
            dragOver={overId === id && dragId !== null && dragId !== id}
            onHandleDragStart={(e) => {
              e.dataTransfer.setData("text/plain", id);
              e.dataTransfer.effectAllowed = "move";
              setDragId(id);
            }}
            onHandleDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onPanelDragOver={(e) => {
              if (!dragId || dragId === id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overId !== id) setOverId(id);
            }}
            onPanelDragLeave={(e) => {
              // Ignore leaves into descendants — only clear when the
              // pointer actually exits the tile.
              const tgt = e.currentTarget as HTMLElement;
              const related = e.relatedTarget as Node | null;
              if (related && tgt.contains(related)) return;
              if (overId === id) setOverId(null);
            }}
            onPanelDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/plain") || dragId;
              setDragId(null);
              setOverId(null);
              if (from && from !== id) onReorder(from, id);
            }}
          />
        );
      })}
      {addInGrid && (
        <button
          type="button"
          className="grid-add-tile"
          onClick={onAddPanel}
          title="add panel"
        >
          <span className="grid-add-plus">+</span>
          <span className="grid-add-label">new panel</span>
        </button>
      )}
      {showRowDivider && (
        <div
          className="grid-row-divider"
          style={{ top: `${(effectiveTopFraction * 100).toFixed(2)}%` }}
          onPointerDown={onRowDividerPointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="resize row heights"
          title="drag to resize rows"
        />
      )}
      {colDividerLefts.map((leftPct, i) => (
        <div
          key={`col-divider-${i}`}
          className="grid-col-divider"
          style={{ left: `${leftPct.toFixed(2)}%` }}
          onPointerDown={(e) => onColDividerPointerDown(e, columns, i)}
          role="separator"
          aria-orientation="vertical"
          aria-label="resize column widths"
          title="drag to resize columns"
        />
      ))}
      </div>
      {addAsStrip && (
        <button
          type="button"
          className="grid-add-strip"
          onClick={onAddPanel}
          title="add panel"
        >
          <span className="grid-add-plus">+</span>
          <span className="grid-add-label">new panel</span>
        </button>
      )}
    </section>
  );
}


function nextTheme(t: AppTheme): AppTheme {
  if (t === "light") return "dark";
  if (t === "dark") return "jet";
  return "light";
}

type PaletteCommand = {
  id: string;
  title: string;
  hint?: string;
  run: () => void | Promise<void>;
};

function CommandPalette({
  sessions,
  commands,
  onPickSession,
  onClose,
}: {
  sessions: SessionInfo[];
  commands: PaletteCommand[];
  onPickSession: (sessionId: string, cwd: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [contentHits, setContentHits] = useState<Map<
    string,
    { preview: string; matchCount: number }
  > | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setContentHits(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      invoke<Array<{ session_id: string; match_count: number; preview: string }>>(
        "search_sessions",
        { query: q },
      )
        .then((hits) => {
          if (cancelled) return;
          const m = new Map<string, { preview: string; matchCount: number }>();
          for (const h of hits)
            m.set(h.session_id, {
              preview: h.preview,
              matchCount: h.match_count,
            });
          setContentHits(m);
        })
        .catch(() => {
          if (!cancelled) setContentHits(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cmdHits = commands
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .map((c) => ({ type: "command" as const, command: c, score: 0 }));
    const sessionHits: Array<{
      type: "session";
      session: SessionInfo;
      preview?: string;
      score: number;
    }> = [];
    for (const s of sessions) {
      const titleMatch =
        !q ||
        s.title.toLowerCase().includes(q) ||
        basename(s.cwd).toLowerCase().includes(q);
      const contentMatch = contentHits?.has(s.id);
      if (!q) {
        sessionHits.push({ type: "session", session: s, score: 0 });
      } else if (titleMatch) {
        sessionHits.push({ type: "session", session: s, score: -10 });
      } else if (contentMatch) {
        const h = contentHits!.get(s.id)!;
        sessionHits.push({
          type: "session",
          session: s,
          preview: h.preview,
          score: -h.matchCount,
        });
      }
    }
    sessionHits.sort((a, b) => a.score - b.score);
    return [...cmdHits, ...sessionHits.slice(0, 20)];
  }, [query, commands, sessions, contentHits]);

  useEffect(() => {
    setIdx(0);
  }, [query]);

  function runAt(i: number) {
    const item = results[i];
    if (!item) return;
    if (item.type === "command") {
      void item.command.run();
    } else {
      onPickSession(item.session.id, item.session.cwd);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) =>
        results.length === 0 ? 0 : (i - 1 + results.length) % results.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(idx);
    }
  }

  return (
    <div
      className="palette-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette-card">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="jump to session or run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <div className="palette-list" role="listbox">
          {results.length === 0 ? (
            <div className="palette-empty">no matches</div>
          ) : (
            results.map((r, i) => {
              const active = i === idx;
              if (r.type === "command") {
                return (
                  <div
                    key={`cmd-${r.command.id}`}
                    role="option"
                    aria-selected={active}
                    className={`palette-item ${active ? "active" : ""}`}
                    onMouseEnter={() => setIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runAt(i);
                    }}
                  >
                    <span className="palette-kind palette-kind-cmd">cmd</span>
                    <span className="palette-title">{r.command.title}</span>
                    {r.command.hint && (
                      <span className="palette-hint">{r.command.hint}</span>
                    )}
                  </div>
                );
              }
              return (
                <div
                  key={`ses-${r.session.id}`}
                  role="option"
                  aria-selected={active}
                  className={`palette-item ${active ? "active" : ""}`}
                  onMouseEnter={() => setIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runAt(i);
                  }}
                >
                  <span className="palette-kind palette-kind-session">ses</span>
                  <span className="palette-title">{r.session.title || "(untitled)"}</span>
                  <span className="palette-hint">
                    {basename(r.session.cwd) || r.session.cwd}
                  </span>
                  {r.preview && (
                    <div className="palette-preview">{r.preview}</div>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

function WorktreePromptModal({
  cwd,
  onYes,
  onNo,
  onCancel,
}: {
  cwd: string;
  onYes: () => void;
  onNo: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="auth-error-overlay"
      role="alertdialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="auth-error-card">
        <h2>Isolate this panel in a git worktree?</h2>
        <p>
          <code>{cwd}</code> is a git repository. If another grid panel is
          already pointing at it, a worktree gives this panel its own HEAD,
          index, and working tree — so branch switches and uncommitted
          edits won't collide.
        </p>
        <p>
          Pick <strong>No</strong> to just spawn in the directory as-is.
        </p>
        <div className="auth-error-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-secondary" onClick={onNo}>
            No, use the dir
          </button>
          <button type="button" className="btn btn-primary" onClick={onYes}>
            Yes, new worktree
          </button>
        </div>
      </div>
    </div>
  );
}

function ClaudeOnboardingOverlay({
  status,
  loading,
  onRecheck,
  onContinue,
}: {
  status: ClaudePreflight | null;
  loading: boolean;
  onRecheck: () => void;
  onContinue: () => void;
}) {
  const installCommand = "npm install -g @anthropic-ai/claude-code";
  const loginCommand = "claude auth login --claudeai";
  const isInstalled = !!status?.installed;
  const isAuthenticated = !!status?.authenticated;
  const title = loading
    ? "Checking Claude Code"
    : !isInstalled
      ? "Install Claude Code"
      : !isAuthenticated
        ? "Sign in to Claude Code"
        : "Claude Code is ready";
  const copyCommand = (cmd: string) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(cmd).catch(() => {});
  };

  return (
    <div className="auth-error-overlay onboarding-overlay" role="dialog" aria-modal="true">
      <div className="auth-error-card onboarding-card">
        <div className="onboarding-kicker">Blackcrab setup</div>
        <h2>{title}</h2>
        <p>
          Blackcrab uses your local Claude Code install and account. It never
          asks for, stores, or proxies Anthropic credentials.
        </p>
        <div className="onboarding-status-list">
          <div className={`onboarding-status ${isInstalled ? "ok" : loading ? "" : "bad"}`}>
            <span className="onboarding-status-dot" />
            <div>
              <strong>Claude Code CLI</strong>
              <span>
                {loading
                  ? "checking..."
                  : isInstalled
                    ? `${status?.version || "installed"}${status?.path ? ` at ${status.path}` : ""}`
                    : "not found on PATH"}
              </span>
            </div>
          </div>
          <div className={`onboarding-status ${isAuthenticated ? "ok" : loading ? "" : "bad"}`}>
            <span className="onboarding-status-dot" />
            <div>
              <strong>Authentication</strong>
              <span>
                {loading
                  ? "checking..."
                  : isAuthenticated
                    ? `${status?.auth_method || "signed in"}${status?.api_provider ? ` (${status.api_provider})` : ""}`
                    : "not signed in"}
              </span>
            </div>
          </div>
        </div>
        {!loading && !isInstalled && (
          <>
            <p>Install Claude Code, then sign in with Claude.ai Pro/Max or Anthropic Console billing.</p>
            <CommandCopyRow command={installCommand} onCopy={copyCommand} />
            <CommandCopyRow command={loginCommand} onCopy={copyCommand} />
          </>
        )}
        {!loading && isInstalled && !isAuthenticated && (
          <>
            <p>Run the login command in a terminal, complete the browser flow, then recheck.</p>
            <CommandCopyRow command={loginCommand} onCopy={copyCommand} />
            <p className="onboarding-note">
              API billing users can run <code>claude auth login --console</code> instead.
            </p>
          </>
        )}
        {!loading && status?.error && (
          <pre className="onboarding-error">{status.error}</pre>
        )}
        <div className="auth-error-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onContinue}
          >
            Continue anyway
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRecheck}
            disabled={loading}
          >
            {loading ? "Checking..." : "Recheck"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CommandCopyRow({
  command,
  onCopy,
}: {
  command: string;
  onCopy: (cmd: string) => void;
}) {
  return (
    <div className="onboarding-command">
      <code>{command}</code>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => onCopy(command)}
      >
        Copy
      </button>
    </div>
  );
}

function AuthErrorModal({
  onDismiss,
  onQuit,
}: {
  onDismiss: () => void;
  onQuit: () => void;
}) {
  return (
    <div className="auth-error-overlay" role="alertdialog" aria-modal="true">
      <div className="auth-error-card">
        <h2>Claude needs you to sign in again</h2>
        <p>
          The <code>claude</code> CLI got a <strong>401 Invalid authentication
          credentials</strong> response. That usually means the OAuth token
          tied to your Max subscription has expired and needs a fresh login.
        </p>
        <p>To fix:</p>
        <ol>
          <li>
            Open a terminal and run <code>claude login</code>, then complete
            the browser flow.
          </li>
          <li>
            Quit and relaunch this app — the CLI only reads its credential
            file at startup, so an in-flight subprocess won't pick up the
            refresh.
          </li>
        </ol>
        <div className="auth-error-actions">
          <button type="button" className="btn btn-secondary" onClick={onDismiss}>
            Dismiss
          </button>
          <button type="button" className="btn btn-primary" onClick={onQuit}>
            Quit app
          </button>
        </div>
      </div>
    </div>
  );
}

function PermissionDenialOverlay({
  denials,
  onAllowAndRetry,
  onDismiss,
}: {
  denials: Array<{ tool_name: string; tool_input?: unknown }>;
  onAllowAndRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="permission-overlay" role="alertdialog" aria-modal="true">
      <div className="permission-card">
        <div className="permission-prompt-title">
          claude wanted to use{" "}
          {denials.length === 1 ? (
            <span className="permission-tool">{denials[0].tool_name}</span>
          ) : (
            <>
              <span className="permission-tool">{denials.length} tools</span>{" "}
              but the current permission mode blocked them
            </>
          )}
          {denials.length === 1 ? " but the current permission mode blocked it" : ""}.
        </div>
        {denials.slice(0, 3).map((d, i) => {
          const inputStr = (() => {
            if (d.tool_input == null) return "";
            try {
              return typeof d.tool_input === "string"
                ? d.tool_input
                : JSON.stringify(d.tool_input, null, 2);
            } catch {
              return String(d.tool_input);
            }
          })();
          return (
            <pre key={i} className="permission-prompt-input">
              <strong>{d.tool_name}</strong>
              {inputStr ? `\n${inputStr.slice(0, 400)}` : ""}
            </pre>
          );
        })}
        {denials.length > 3 && (
          <div className="hint" style={{ marginTop: 6 }}>
            … and {denials.length - 3} more
          </div>
        )}
        <div className="permission-prompt-actions">
          <button type="button" className="btn btn-secondary" onClick={onDismiss}>
            Dismiss
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onAllowAndRetry}
          >
            Allow all tools &amp; retry
          </button>
        </div>
      </div>
    </div>
  );
}

function PermissionPromptOverlay({
  req,
  onAllow,
  onDeny,
  onAllowAndBypass,
}: {
  req: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
  onAllowAndBypass: () => void;
}) {
  const inputPreview = (() => {
    try {
      return JSON.stringify(req.input, null, 2);
    } catch {
      return String(req.input);
    }
  })();
  return (
    <div className="permission-overlay">
      <div className="permission-card">
        <div className="permission-prompt-title">
          claude wants to use{" "}
          <span className="permission-tool">{req.toolName}</span>
        </div>
        <pre className="permission-prompt-input">{inputPreview}</pre>
        <div className="permission-prompt-actions">
          <button className="btn btn-secondary" onClick={onDeny}>
            deny
          </button>
          <button className="btn btn-secondary" onClick={onAllowAndBypass}>
            allow + bypass rest of session
          </button>
          <button className="btn btn-send" onClick={onAllow}>
            allow
          </button>
        </div>
      </div>
    </div>
  );
}

// Initial window of entries to render in a PlainTranscript — anything
// beyond this is hidden behind a "show older" button so first paint
// stays fast regardless of conversation length.
// How many entries to materialize on the initial mount of a new
// transcript. Each EntryView can be very heavy (markdown + a code
// block of ~100 lines emits ~500 syntax-highlighted spans), and on
// first commit the browser paints everything regardless of
// content-visibility — so 40 rows can mean thousands of paint
// regions and a 3-second frame. 12 covers a typical viewport with
// a small buffer; older rows load via the "show older" button below.
const TRANSCRIPT_WINDOW = 12;
const TRANSCRIPT_WINDOW_STEP = 20;

const PlainTranscript = memo(function PlainTranscript({
  entries,
  busy,
  scrollRef,
  onAtBottomChange,
  scrollToBottomToken,
}: {
  entries: Entry[];
  busy: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onAtBottomChange: (atBottom: boolean) => void;
  scrollToBottomToken: number;
}) {
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW);
  // Stream new turns should auto-extend the window so live replies
  // don't get clipped by the "show older" affordance once the user
  // has started expanding it.
  useEffect(() => {
    setWindowSize((w) => (entries.length <= w ? w : w));
  }, [entries.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      onAtBottomChange(distance < 48);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [onAtBottomChange, scrollRef]);

  useLayoutEffect(() => {
    if (!scrollToBottomToken) return;
    let raf1 = 0;
    let raf2 = 0;
    const snap = () => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      onAtBottomChange(true);
    };
    snap();
    raf1 = requestAnimationFrame(() => {
      snap();
      raf2 = requestAnimationFrame(snap);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [scrollToBottomToken, scrollRef, onAtBottomChange]);

  const total = entries.length;
  const visible =
    total > windowSize ? entries.slice(total - windowSize) : entries;
  const hiddenCount = total - visible.length;

  function loadOlder() {
    const el = scrollRef.current;
    // Preserve the user's visual position after prepending: remember
    // how far above the bottom we were, then restore that distance.
    const prevFromBottom = el
      ? el.scrollHeight - el.clientHeight - el.scrollTop
      : 0;
    setWindowSize((w) => w + TRANSCRIPT_WINDOW_STEP);
    requestAnimationFrame(() => {
      if (!el) return;
      el.scrollTop = el.scrollHeight - el.clientHeight - prevFromBottom;
    });
  }

  return (
    <div className="transcript plain" ref={scrollRef}>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="transcript-load-older"
          onClick={loadOlder}
        >
          show older ({hiddenCount} earlier {hiddenCount === 1 ? "message" : "messages"})
        </button>
      )}
      {visible.map((entry) => (
        <div key={entry.id} className="transcript-row">
          <EntryView entry={entry} />
        </div>
      ))}
      {busy && <TypingIndicator />}
    </div>
  );
});

export function TypingIndicator() {
  return (
    <div className="typing">
      <span /><span /><span />
    </div>
  );
}

export default App;
