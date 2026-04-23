import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Webview, getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { compileMarkdown } from "./markdown";
import { LivePanel } from "./LivePanel";
import "./App.css";

// Hoisted so they're stable across renders — creating them fresh each time
// would break react-markdown's internal caches and blow up re-render cost.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

export type TextBlock = { type: "text"; text: string; _streaming?: boolean; _html?: string };
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
  | { kind: "result"; id: string; text: string; isError?: boolean };

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
};

type BranchInfo = {
  is_repo: boolean;
  current: string;
  branches: string[];
  dirty: boolean;
};

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
const SESSION_TAIL_LIMIT = 200;

export function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// Module-level cache keyed by cwd. `undefined` = not yet queried.
const githubRepoCache = new Map<string, string>();

async function getGithubRepo(cwd: string): Promise<string> {
  if (!cwd) return "";
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
): {
  entries: Entry[];
  toolUseMap: Map<string, ToolMeta>;
} {
  const entries: Entry[] = [];
  const toolUseMap = new Map<string, ToolMeta>();
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
          return { ...tb, _html: compileMarkdown(tb.text ?? "", repo) };
        }
        if (b.type === "thinking") {
          const thb = b as ThinkingBlock;
          return { ...thb, _html: compileMarkdown(thb.thinking ?? "", repo) };
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

function App() {
  const [cwd, setCwd] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [permissionMode, setPermissionMode] = useState<string>("bypassPermissions");
  const [sessionOn, setSessionOn] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<{
    sessionId?: string;
    model?: string;
    cwd?: string;
    tools?: string[];
  } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<{ id: string; path: string }[]>(
    [],
  );
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stderrLines, setStderrLines] = useState<string[]>([]);
  const [showStderr, setShowStderr] = useState(false);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
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

  // In grid mode, the topbar mirrors whichever panel is currently selected
  // so cwd/branch/model/permissions stay in sync with what the user is
  // looking at. Nothing here touches the main-session subprocess.
  useEffect(() => {
    if (!gridMode || !selectedGridPanelId) return;
    const info = sessions.find((s) => s.id === selectedGridPanelId);
    if (!info) return;
    if (info.cwd) setCwd(info.cwd);
    if (info.model) setModel(info.model);
    if (info.permission_mode) setPermissionMode(info.permission_mode);
  }, [gridMode, selectedGridPanelId, sessions]);
  useEffect(() => {
    localStorage.setItem("gridMode", gridMode ? "1" : "0");
  }, [gridMode]);
  useEffect(() => {
    localStorage.setItem("gridPanels", JSON.stringify(gridPanels));
  }, [gridPanels]);


  // Listen for native drag-drop on the window — this is the reliable way
  // to get real file paths instead of just File blobs.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "enter" || e.payload.type === "over") {
          setDragOver(true);
        } else if (e.payload.type === "leave") {
          setDragOver(false);
        } else if (e.payload.type === "drop") {
          setDragOver(false);
          const paths = (e.payload as { paths?: string[] }).paths ?? [];
          if (paths.length === 0) return;
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
  }, []);

  const [theme, setTheme] = useState<"light" | "dark" | "jet">(() => {
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
  // Set once the user actually clicks a session. Prewarm watches this to
  // yield IPC bandwidth for the user-initiated load.
  const userInteractedRef = useRef(false);

  useEffect(() => {
    invoke<string>("default_cwd").then(setCwd).catch(() => setCwd("/"));
  }, []);

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
    setSessionsLoading(true);
    try {
      const list = await invoke<SessionInfo[]>("list_sessions");
      setSessions(list);
    } catch (e) {
      console.error("list_sessions failed", e);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const refreshBranches = useCallback(async (targetCwd: string) => {
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

  useEffect(() => {
    refreshBranches(cwd);
    // Warm the GitHub repo cache for this cwd so streaming content_block_stop
    // events can linkify PR references synchronously.
    if (cwd) getGithubRepo(cwd);
  }, [cwd, refreshBranches]);

  // Pre-warm every session's cache using the cheap tail endpoint so the
  // first click on ANY session is as instant as the second. Paused the
  // moment the user clicks a session so their click doesn't queue behind
  // bulk prewarm IPCs.
  useEffect(() => {
    if (sessions.length === 0) return;
    let cancelled = false;
    const queue = sessions.slice();
    const concurrency = 2;

    const prewarmOne = async (s: SessionInfo) => {
      if (cancelled || userInteractedRef.current) return;
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
        if (cancelled || userInteractedRef.current) return;
        const { entries, toolUseMap } = buildHistory(events, repo);
        sessionCacheRef.current.set(s.id, {
          entries,
          toolUseMap,
          mtime_ms: s.mtime_ms,
        });
      } catch {
        // ignore — a missing/unreadable session just means no prewarm for it
      }
    };

    const idx = { i: 0 };
    const worker = async () => {
      while (!cancelled && !userInteractedRef.current) {
        const i = idx.i++;
        if (i >= queue.length) return;
        await prewarmOne(queue[i]);
      }
    };
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) workers.push(worker());
    Promise.all(workers).catch(() => {});

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
        if (line) setStderrLines((s) => [...s, line]);
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
    if (ev.type === "system" && ev.subtype === "init") {
      setSessionMeta({
        sessionId: ev.session_id,
        model: ev.model,
        cwd: ev.cwd,
        tools: ev.tools,
      });
      setActiveSessionId(ev.session_id);
      setEntries((es) => [
        ...es,
        {
          kind: "system",
          id: randomId(),
          text: `session ${ev.session_id?.slice(0, 8) ?? ""} • model ${ev.model ?? "?"} • ${ev.tools?.length ?? 0} tools`,
        },
      ]);
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
      const errorDetail =
        typeof (ev as { error?: unknown }).error === "string"
          ? ((ev as { error?: string }).error as string)
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
      return;
    }

    // Claude (and the CLI wrapper) can emit top-level error events when the
    // API call itself fails. Surface them clearly.
    const evAny = ev as { type?: string; error?: unknown; message?: unknown };
    if (evAny.type === "error") {
      setBusy(false);
      const errObj = evAny.error as { message?: string } | string | undefined;
      const msg =
        typeof errObj === "string"
          ? errObj
          : errObj?.message ?? (typeof evAny.message === "string" ? evAny.message : "unknown error");
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `API error: ${msg}` },
      ]);
      setShowStderr(true);
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
    setEntries([]);
    setStderrLines([]);
    toolUseMapRef.current.clear();
    toolUseMapGlobal.current = toolUseMapRef.current;
    streamingIdRef.current = null;
    setBusy(false);
    setSessionMeta(null);
    setActiveSessionId(undefined);
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
    const key = `new:${randomId()}:${Date.now()}`;
    setNewPanelCwds((m) => ({ ...m, [key]: chosen! }));
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
    } finally {
      setSwitchingBranch(false);
    }
  }

  async function resumeSession(sessionId: string, sessionCwd: string) {
    const t0 = performance.now();
    const token = ++resumeTokenRef.current;
    const isLatest = () => resumeTokenRef.current === token;
    userInteractedRef.current = true;

    const info = sessions.find((s) => s.id === sessionId);
    const sessionModel = info?.model ?? "";
    const sessionPermissionMode = info?.permission_mode ?? "";
    const mtime = info?.mtime_ms ?? 0;

    const cached = sessionCacheRef.current.get(sessionId);
    const cacheHit = cached && cached.mtime_ms === mtime && mtime > 0;

    // ---------- Single synchronous batch: swap entire view in one render ----------
    // Everything below runs before any await so React 18 batches them into a
    // single commit. If it's a cache hit, the transcript hops directly from
    // the previous session's entries to the resumed ones — no empty flash,
    // no startTransition delay, no "loading…" placeholder.
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

    if (cacheHit) {
      toolUseMapRef.current = new Map(cached!.toolUseMap);
      toolUseMapGlobal.current = toolUseMapRef.current;
      const t1 = performance.now();
      setEntries([
        ...cached!.entries,
        { kind: "system", id: randomId(), text: "— resumed —" },
      ]);
      setResumingId(null);
      requestAnimationFrame(() => {
        const el = transcriptScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          const dt = performance.now() - t0;
          const dtSince = performance.now() - t1;
          // eslint-disable-next-line no-console
          console.log(
            `[resume:cache-hit] id=${sessionId.slice(0, 8)} entries=${cached!.entries.length} ` +
              `total=${dt.toFixed(1)}ms paintAfterSetEntries=${dtSince.toFixed(1)}ms`,
          );
        });
      });
    } else {
      toolUseMapRef.current = new Map();
      toolUseMapGlobal.current = toolUseMapRef.current;
      setEntries([]);
      setResumingId(sessionId);
    }

    const useCwd = sessionCwd || cwd;

    // Kick off the claude subprocess in parallel — it boots while we load.
    // setPermissionMode above hasn't flushed yet, so send the session's own
    // permission mode to start_session directly.
    const startPromise = invoke("start_session", {
      panelId: "main",
      cwd: useCwd,
      permissionMode: sessionPermissionMode || permissionMode,
      model: sessionModel || model || null,
      resumeId: sessionId,
    });

    if (!cacheHit) {
      try {
        const tInvoke = performance.now();
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
        if (!isLatest()) return;
        const tParsed = performance.now();
        const { entries: history, toolUseMap } = buildHistory(events, repo);
        const tBuilt = performance.now();
        // eslint-disable-next-line no-console
        console.log(
          `[resume:cache-miss] id=${sessionId.slice(0, 8)} events=${events.length} ` +
            `invoke=${(tParsed - tInvoke).toFixed(1)}ms ` +
            `build=${(tBuilt - tParsed).toFixed(1)}ms ` +
            `total=${(performance.now() - t0).toFixed(1)}ms`,
        );
        sessionCacheRef.current.set(sessionId, {
          entries: history,
          toolUseMap,
          mtime_ms: mtime,
        });
        toolUseMapRef.current = new Map(toolUseMap);
        toolUseMapGlobal.current = toolUseMapRef.current;
        setEntries([
          ...history,
          { kind: "system", id: randomId(), text: "— resumed —" },
        ]);
        requestAnimationFrame(() => {
          const el = transcriptScrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch (e) {
        if (isLatest()) {
          setEntries((es) => [
            ...es,
            { kind: "system", id: randomId(), text: `failed to load history: ${e}` },
          ]);
        }
      } finally {
        if (isLatest()) setResumingId(null);
      }
    }

    try {
      await startPromise;
      if (isLatest()) {
        setSessionOn(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    } catch (e) {
      if (isLatest()) {
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `failed to start: ${e}` },
        ]);
      }
    } finally {
      if (isLatest()) switchingSessionRef.current = false;
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

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;

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
        return;
      }
    }

    // Attachments become a trailing section of the message so claude's
    // Read / Bash / Glob tools can pick them up by path.
    const attachList = attachments
      .map((a) => `- ${a.path}`)
      .join("\n");
    const body =
      attachments.length > 0
        ? `${text || "(see attached files)"}\n\n[Attached files]\n${attachList}`
        : text;

    setInput("");
    setAttachments([]);
    setEntries((es) => [
      ...es,
      { kind: "user", id: randomId(), text: body },
    ]);
    setBusy(true);
    setStuckToBottom(true);
    setHasNewBelow(false);
    try {
      await invoke("send_message", { panelId: "main", text: body });
    } catch (e) {
      setBusy(false);
      setEntries((es) => [...es, { kind: "system", id: randomId(), text: `send failed: ${e}` }]);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const hasStderr = stderrLines.length > 0;

  return (
    <div className="root">
      <Sidebar
        sessions={sessions}
        activeId={gridMode ? undefined : activeSessionId}
        loading={sessionsLoading}
        resumingId={resumingId}
        onResume={(id, cwd) => {
          if (gridMode) {
            // In grid mode: clicking a sidebar session either replaces the
            // selected panel or appends a fresh panel (when empty / nothing
            // selected / the session is already in the grid).
            if (gridPanels.includes(id)) {
              setSelectedGridPanelId(id);
              return;
            }
            if (selectedGridPanelId && gridPanels.includes(selectedGridPanelId)) {
              setGridPanels((prev) => {
                const idx = prev.indexOf(selectedGridPanelId);
                if (idx < 0) return prev;
                const next = prev.slice();
                next[idx] = id;
                return next;
              });
              setSelectedGridPanelId(id);
            } else if (gridPanels.length < 6) {
              setGridPanels((prev) => [...prev, id]);
              setSelectedGridPanelId(id);
            } else {
              // Full grid with no selection — replace the last panel.
              setGridPanels((prev) => {
                const next = prev.slice();
                next[next.length - 1] = id;
                return next;
              });
              setSelectedGridPanelId(id);
            }
          } else {
            resumeSession(id, cwd);
          }
        }}
        onNew={() => newSession()}
        onRefresh={() => refreshSessions()}
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
          <div className="brand">Claude GUI</div>
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
                <option value="">default (auto)</option>
                <option value="opus">Opus (latest)</option>
                <option value="sonnet">Sonnet (latest)</option>
                <option value="haiku">Haiku (latest)</option>
                <option disabled>──────────</option>
                <option value="claude-opus-4-7">claude-opus-4-7</option>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                <option value="claude-haiku-4-5">claude-haiku-4-5</option>
                <option value="claude-opus-4-5">claude-opus-4-5</option>
                <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
              </select>
            </label>
            <label className="field field-sm">
              <span>permissions</span>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
              >
                <option value="bypassPermissions">bypass</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="default">default</option>
                <option value="plan">plan</option>
              </select>
            </label>
            <button
              type="button"
              className={`btn btn-secondary grid-mode-toggle ${gridMode ? "active" : ""}`}
              onClick={() => setGridMode((v) => !v)}
              title="grid mode (show up to 6 conversations)"
            >
              ⊞ grid
            </button>
            <div className="theme-toggle" role="group" aria-label="theme">
              {(["light", "dark", "jet"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`theme-btn ${theme === t ? "active" : ""}`}
                  onClick={() => setTheme(t)}
                  title={`${t} mode`}
                >
                  {t === "light" ? "☀" : t === "dark" ? "◐" : "●"}
                </button>
              ))}
            </div>
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
            newPanelCwds={newPanelCwds}
            onSessionStarted={() => refreshSessions()}
            onRemove={(id) => {
              setGridPanels((prev) => prev.filter((x) => x !== id));
              setNewPanelCwds((m) => {
                if (!(id in m)) return m;
                const next = { ...m };
                delete next[id];
                return next;
              });
            }}
          />
        </div>
        <section className={`transcript-wrap ${gridMode ? "hidden" : ""}`}>
          {entries.length === 0 ? (
            <div className="empty">
              {resumingId ? (
                <p>loading session…</p>
              ) : (
                <>
                  <p>Type a message below to start a new session, or pick a past one from the sidebar.</p>
                  <p className="hint">Settings apply to the next session you start.</p>
                </>
              )}
            </div>
          ) : (
            <PlainTranscript
              entries={entries}
              busy={busy}
              scrollRef={transcriptScrollRef}
              onAtBottomChange={handleAtBottomChange}
            />
          )}
          {!stuckToBottom && entries.length > 0 && (
            <button
              className={`jump-bottom ${hasNewBelow ? "pulse" : ""}`}
              onClick={scrollToBottom}
              title="jump to bottom"
            >
              ↓
            </button>
          )}
        </section>

        {!gridMode && (
        <footer className={`composer ${dragOver ? "drag-over" : ""}`}>
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
          <div className="composer-row">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="message Claude…  (Enter to send, Shift+Enter for newline; drop files anywhere)"
              disabled={busy}
              rows={3}
            />
            {busy ? (
              <button className="btn btn-interrupt" onClick={interruptTurn} title="interrupt turn">
                interrupt
              </button>
            ) : (
              <button
                className="btn btn-send"
                onClick={send}
                disabled={!input.trim() && attachments.length === 0}
              >
                send
              </button>
            )}
          </div>
          {dragOver && (
            <div className="drag-hint">drop files to attach</div>
          )}
        </footer>
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
          onClick={() =>
            url && openUrl(url).catch((err) => console.error("openUrl failed:", err))
          }
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
          <NativePreview url={url} reloadKey={reloadKey} />
        ) : (
          <div className="preview-empty">
            enter a URL above or wait for Claude to start a local server
          </div>
        )}
      </div>
    </aside>
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

function Sidebar({
  sessions,
  activeId,
  loading,
  resumingId,
  onResume,
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
}: {
  sessions: SessionInfo[];
  activeId?: string;
  loading: boolean;
  resumingId: string | null;
  onResume: (id: string, cwd: string) => void;
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
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // The active session is reordered to the top of the filtered list, so
  // snapping the sidebar to scrollTop: 0 puts it in view immediately.
  useEffect(() => {
    if (!activeId) return;
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: 0, behavior: "auto" });
  }, [activeId]);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = sessions.filter((s) => {
      if (projectFilter && s.cwd !== projectFilter) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        basename(s.cwd).toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
    // Only float the active to the top in flat mode — in grouped mode it
    // belongs under its project header.
    if (!grouped && activeId) {
      const active = matches.find((s) => s.id === activeId);
      if (active && matches[0]?.id !== activeId) {
        return [active, ...matches.filter((s) => s.id !== activeId)];
      }
    }
    return matches;
  }, [sessions, projectFilter, search, activeId, grouped]);

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
                      itemRefs,
                      grouped: true,
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
                itemRefs,
                grouped: false,
              }),
            )}
      </div>
    </aside>
  );
}

function renderSessionItem(
  s: SessionInfo,
  ctx: {
    activeId?: string;
    resumingId: string | null;
    onResume: (id: string, cwd: string) => void;
    itemRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
    grouped: boolean;
  },
) {
  const ctxRatio =
    s.context_limit > 0 ? Math.min(1, s.context_tokens / s.context_limit) : 0;
  const costBudget = 5;
  const costRatio = Math.min(1, s.total_cost_usd / costBudget);
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
      onClick={() => ctx.onResume(s.id, s.cwd)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.onResume(s.id, s.cwd);
        }
      }}
      title={`${s.id}\n${s.cwd}\nmodel: ${s.model || "?"}\ncontext: ${formatTokens(s.context_tokens)} / ${formatTokens(s.context_limit)} (${(ctxRatio * 100).toFixed(0)}%)\ncost: $${s.total_cost_usd.toFixed(4)}\noutput: ${formatTokens(s.output_tokens)} tokens`}
    >
      {isLoading && <span className="session-loading-bar" />}
      <span className="session-title">{s.title || "(untitled)"}</span>
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
        <span className="session-bar-label">$</span>
        <div className="session-bar-track">
          <div
            className="session-bar-fill"
            style={{
              width: `${(costRatio * 100).toFixed(1)}%`,
              background: barColor(costRatio),
            }}
          />
        </div>
        <span className="session-bar-value">${s.total_cost_usd.toFixed(2)}</span>
      </div>
      <div className="session-meta">
        <span>{relativeTime(s.mtime_ms)}</span>
        <span className="session-count">{s.message_count} msg</span>
      </div>
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

const mdComponents = {
  a: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const isExternal = !!href && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        {...rest}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        onClick={(e) => {
          if (!href || !isExternal) return;
          // Always prevent default so the app window never navigates.
          e.preventDefault();
          e.stopPropagation();
          if (linkClickHandlerRef.current) {
            linkClickHandlerRef.current(href);
          } else {
            openUrl(href).catch((err) => console.error("openUrl failed:", err));
          }
        }}
      >
        {children}
      </a>
    );
  },
};

function BlockView({ block }: { block: Block }) {
  if (block.type === "text") {
    const tb = block as TextBlock;
    const text = tb.text ?? "";
    // During streaming, skip the markdown parse on every delta — we render
    // plain-text paragraphs and swap to markdown once the block finalizes.
    if (tb._streaming) {
      return <StreamingText text={text} />;
    }
    // Precompiled HTML path — no React reconciliation inside the bubble.
    if (tb._html) {
      return (
        <div
          className="block text markdown"
          dangerouslySetInnerHTML={{ __html: tb._html }}
          onClick={handleMarkdownClick}
        />
      );
    }
    return (
      <div className="block text markdown">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={mdComponents}
        >
          {text}
        </ReactMarkdown>
      </div>
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
    if (tb._html) {
      return (
        <details className="block thinking" open>
          <summary>thinking</summary>
          <div
            className="markdown"
            dangerouslySetInnerHTML={{ __html: tb._html }}
            onClick={handleMarkdownClick}
          />
        </details>
      );
    }
    return (
      <details className="block thinking" open>
        <summary>thinking</summary>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
            {t}
          </ReactMarkdown>
        </div>
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
  const isLong = lines.length > 18 || text.length > 1200;
  const input = (toolInput as Record<string, unknown>) ?? {};

  if (short && !isError) {
    return (
      <div className="tool-result quiet">
        <span className="tool-result-check">✓</span>
        <span className="tool-result-label">{name}</span>
        {input.file_path && (
          <span className="tool-result-path">{String(input.file_path)}</span>
        )}
      </div>
    );
  }

  const bodyClass = `tool-result-body ${name === "Bash" ? "terminal-out" : ""}`;

  return (
    <div className={`tool-result ${isError ? "err" : ""}`}>
      <div className="tool-result-head">
        <span className="tool-result-label">{name}</span>
        {isError && <span className="tool-tag err">error</span>}
        <span className="tool-result-meta">{lines.length} lines</span>
      </div>
      {isLong ? (
        <details>
          <summary>show output</summary>
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
  onAddPanel,
  onSelect,
  onRemove,
  onSessionStarted,
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
  onAddPanel: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onSessionStarted: (sessionId: string) => void;
}) {
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
  const tileCount = Math.max(1, Math.min(6, panels.length + (panels.length < 6 ? 1 : 0)));
  const columns = tileCount <= 1 ? 1 : tileCount <= 4 ? 2 : 3;
  return (
    <section
      className="grid-transcripts live"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {panels.map((id) => {
        const info = sessions.find((s) => s.id === id);
        const isNewPanel = id in newPanelCwds;
        const panelCwd = isNewPanel
          ? newPanelCwds[id]
          : info?.cwd || defaultCwd;
        const panelModel = isNewPanel
          ? defaultModel
          : info?.model || defaultModel;
        return (
          <LivePanel
            key={id}
            panelId={id}
            initialSessionId={isNewPanel ? undefined : id}
            initialCwd={panelCwd}
            initialModel={panelModel}
            initialTitle={isNewPanel ? "new session" : info?.title}
            permissionMode={info?.permission_mode || permissionMode}
            repo=""
            sessionCache={sessionCache}
            isActive={selectedId === id}
            onFocus={() => onSelect(id)}
            onRemove={() => onRemove(id)}
            onSessionStarted={onSessionStarted}
          />
        );
      })}
      {panels.length < 6 && (
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
    </section>
  );
}

// Grid overview of up to 6 cached session transcripts. Each panel shows a
// lightweight preview (last ~40 entries from cache) plus a click-to-activate
// button so the user can quickly bring one to the front.
function GridTranscripts({
  panels,
  sessions,
  cache,
  activeId,
  onActivate,
  onRemove,
}: {
  panels: string[];
  sessions: SessionInfo[];
  cache: Map<
    string,
    { entries: Entry[]; toolUseMap: Map<string, ToolMeta>; mtime_ms: number }
  >;
  activeId?: string;
  onActivate: (id: string, cwd: string) => void;
  onRemove: (id: string) => void;
}) {
  const panelCount = Math.max(1, Math.min(6, panels.length));
  const columns = panelCount <= 1 ? 1 : panelCount <= 4 ? 2 : 3;
  return (
    <section
      className="grid-transcripts"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {panels.map((id) => {
        const info = sessions.find((s) => s.id === id);
        const cached = cache.get(id);
        const entries = cached?.entries ?? [];
        const tail = entries.slice(-40);
        const title = info?.title || "(untitled)";
        const project = info ? basename(info.cwd) || "unknown" : "";
        const isActive = activeId === id;
        return (
          <div
            key={id}
            className={`grid-panel ${isActive ? "active" : ""}`}
          >
            <header className="grid-panel-head">
              <div className="grid-panel-title" title={title}>
                {title}
              </div>
              <div className="grid-panel-meta">
                <span className="grid-panel-project">{project}</span>
                <button
                  type="button"
                  className="grid-panel-activate"
                  onClick={() => info && onActivate(info.id, info.cwd)}
                  disabled={!info || isActive}
                  title={isActive ? "active" : "open as the active session"}
                >
                  {isActive ? "● active" : "open"}
                </button>
                <button
                  type="button"
                  className="grid-panel-close"
                  onClick={() => onRemove(id)}
                  title="remove from grid"
                  aria-label="remove"
                >
                  ×
                </button>
              </div>
            </header>
            <div className="grid-panel-body">
              {!cached ? (
                <div className="grid-panel-empty">still caching…</div>
              ) : tail.length === 0 ? (
                <div className="grid-panel-empty">no messages yet</div>
              ) : (
                tail.map((e) => (
                  <div key={e.id} className="transcript-row">
                    <EntryView entry={e} />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PlainTranscript({
  entries,
  busy,
  scrollRef,
  onAtBottomChange,
}: {
  entries: Entry[];
  busy: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  onAtBottomChange: (atBottom: boolean) => void;
}) {
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

  return (
    <div className="transcript plain" ref={scrollRef}>
      {entries.map((entry) => (
        <div key={entry.id} className="transcript-row">
          <EntryView entry={entry} />
        </div>
      ))}
      {busy && <TypingIndicator />}
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="typing">
      <span /><span /><span />
    </div>
  );
}

export default App;
