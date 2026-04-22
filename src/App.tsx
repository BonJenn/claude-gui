import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "./App.css";

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  _inputJson?: string;
};
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
};
type ThinkingBlock = { type: "thinking"; thinking: string };
type Block = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | { type: string; [k: string]: unknown };

type ToolMeta = { name: string; input: unknown };

type Entry =
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

type StreamEvent =
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

type PartialEvent =
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

const REPLAY_SKIP = new Set([
  "queue-operation",
  "last-prompt",
  "ai-title",
  "custom-title",
  "attachment",
  "system",
]);

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function buildHistory(lines: string[]): {
  entries: Entry[];
  toolUseMap: Map<string, ToolMeta>;
} {
  const entries: Entry[] = [];
  const toolUseMap = new Map<string, ToolMeta>();
  // De-dup assistant entries: stored sessions can contain multiple rows with
  // the same message id (retries, continued turns). Keep the latest.
  const msgIdToIdx = new Map<string, number>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = (ev.type as string) ?? "";
    if (REPLAY_SKIP.has(t)) continue;

    if (t === "assistant") {
      const msg = ev.message as { id?: string; content?: Block[] } | undefined;
      const msgId = msg?.id ?? randomId();
      const blocks = msg?.content ?? [];
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
  const [busy, setBusy] = useState(false);
  const [stderrLines, setStderrLines] = useState<string[]>([]);
  const [showStderr, setShowStderr] = useState(false);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | "jet">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark" || saved === "jet") return saved;
    return "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingIdRef = useRef<string | null>(null);
  const toolUseMapRef = useRef<Map<string, ToolMeta>>(new Map());

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
  }, [cwd, refreshBranches]);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setStuckToBottom((prev) => (prev === atBottom ? prev : atBottom));
    if (atBottom) setHasNewBelow(false);
  }, []);

  function scrollToBottom() {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", behavior: "smooth" });
    setStuckToBottom(true);
    setHasNewBelow(false);
  }

  useEffect(() => {
    const pending: Promise<() => void>[] = [
      listen<string>("claude-event", (e) => {
        try {
          const ev = JSON.parse(e.payload) as StreamEvent;
          handleEvent(ev);
        } catch (err) {
          console.error("bad claude-event payload", err, e.payload);
        }
      }),
      listen<string>("claude-stderr", (e) => {
        setStderrLines((s) => [...s, e.payload]);
      }),
      listen("claude-done", () => {
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
      recordToolUses(ev.message.content);
      setEntries((es) => {
        const idx = es.findIndex(
          (x) => x.kind === "assistant" && x.id === msgId,
        );
        if (idx >= 0) {
          const next = es.slice();
          next[idx] = { kind: "assistant", id: msgId, blocks: ev.message.content };
          return next;
        }
        return [
          ...es,
          { kind: "assistant", id: msgId || randomId(), blocks: ev.message.content },
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
      setEntries((es) => [
        ...es,
        {
          kind: "result",
          id: randomId(),
          text: `${ev.subtype}${cost}${dur}`,
          isError: ev.is_error,
        },
      ]);
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
        if ((cb as TextBlock).type === "text" && (cb as TextBlock).text == null) {
          (cb as TextBlock).text = "";
        }
        if ((cb as ThinkingBlock).type === "thinking" && (cb as ThinkingBlock).thinking == null) {
          (cb as ThinkingBlock).thinking = "";
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
        if (b && b.type === "tool_use") {
          const tu = b as ToolUseBlock;
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
    streamingIdRef.current = null;
    setBusy(false);
    setSessionMeta(null);
    setActiveSessionId(undefined);
    setStuckToBottom(true);
    setHasNewBelow(false);
  }

  async function newSession() {
    if (sessionOn) {
      await stopSession();
    }
    resetSessionState();
    setTimeout(() => inputRef.current?.focus(), 0);
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
    // Instant visual feedback — all state flips BEFORE any await so the
    // transcript clears and the sidebar highlight updates in the same frame.
    resetSessionState();
    setSessionOn(false);
    setActiveSessionId(sessionId);
    setResumingId(sessionId);
    if (sessionCwd) setCwd(sessionCwd);

    const useCwd = sessionCwd || cwd;

    // start_session on the Rust side already kills any prior subprocess,
    // so we skip awaiting stopSession. Fire load and start in parallel.
    const startPromise = invoke("start_session", {
      cwd: useCwd,
      permissionMode,
      model: model || null,
      resumeId: sessionId,
    });

    try {
      const lines = await invoke<string[]>("load_session", {
        sessionId,
        cwd: useCwd,
      });
      const { entries: history, toolUseMap } = buildHistory(lines);
      toolUseMapRef.current = toolUseMap;
      // startTransition lets the click feedback + loading indicator paint
      // first, then commits the big history render without blocking input.
      startTransition(() => {
        setEntries((es) => [
          ...history,
          { kind: "system", id: randomId(), text: "— resumed —" },
          ...es,
        ]);
      });
    } catch (e) {
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `failed to load history: ${e}` },
      ]);
    } finally {
      setResumingId(null);
    }

    try {
      await startPromise;
      setSessionOn(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `failed to start: ${e}` },
      ]);
    }
  }

  async function stopSession() {
    try {
      await invoke("stop_session");
    } finally {
      setSessionOn(false);
      setBusy(false);
    }
  }

  async function interruptTurn() {
    try {
      await invoke("interrupt_session");
    } catch (e) {
      console.error("interrupt failed", e);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    if (!sessionOn) {
      try {
        await invoke("start_session", {
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

    setInput("");
    setEntries((es) => [...es, { kind: "user", id: randomId(), text }]);
    setBusy(true);
    setStuckToBottom(true);
    setHasNewBelow(false);
    try {
      await invoke("send_message", { text });
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
        activeId={activeSessionId}
        loading={sessionsLoading}
        onResume={resumeSession}
        onNew={() => newSession()}
        onRefresh={() => refreshSessions()}
        cwd={cwd}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
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

        <section className="transcript-wrap">
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
            <Virtuoso
              ref={virtuosoRef}
              className="transcript"
              data={entries}
              computeItemKey={(_, entry) => entry.id}
              itemContent={(_, entry) => (
                <div className="transcript-row">
                  <EntryView entry={entry} toolUseMap={toolUseMapRef.current} />
                </div>
              )}
              followOutput={stuckToBottom ? "smooth" : false}
              atBottomStateChange={handleAtBottomChange}
              atBottomThreshold={48}
              initialTopMostItemIndex={entries.length - 1}
              increaseViewportBy={400}
              components={{
                Footer: busy ? TypingIndicator : undefined,
              }}
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

        <footer className="composer">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="message Claude…  (Enter to send, Shift+Enter for newline)"
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
              disabled={!input.trim()}
            >
              send
            </button>
          )}
        </footer>

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
    </div>
  );
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
  onResume,
  onNew,
  onRefresh,
  cwd,
  projectFilter,
  onProjectFilterChange,
}: {
  sessions: SessionInfo[];
  activeId?: string;
  loading: boolean;
  onResume: (id: string, cwd: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  cwd: string;
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
}) {
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
    if (!projectFilter) return sessions;
    return sessions.filter((s) => s.cwd === projectFilter);
  }, [sessions, projectFilter]);

  return (
    <aside className="sidebar">
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
      </div>
      <div className="sessions-list">
        {loading && filtered.length === 0 && (
          <div className="sessions-empty">loading…</div>
        )}
        {!loading && filtered.length === 0 && sessions.length === 0 && (
          <div className="sessions-empty">no past sessions found</div>
        )}
        {!loading && filtered.length === 0 && sessions.length > 0 && (
          <div className="sessions-empty">no sessions match the filter</div>
        )}
        {filtered.map((s) => {
          const ctxRatio =
            s.context_limit > 0 ? Math.min(1, s.context_tokens / s.context_limit) : 0;
          const costBudget = 5;
          const costRatio = Math.min(1, s.total_cost_usd / costBudget);
          return (
            <button
              key={s.id}
              className={`session-item ${activeId === s.id ? "active" : ""}`}
              onClick={() => onResume(s.id, s.cwd)}
              title={`${s.id}\n${s.cwd}\nmodel: ${s.model || "?"}\ncontext: ${formatTokens(s.context_tokens)} / ${formatTokens(s.context_limit)} (${(ctxRatio * 100).toFixed(0)}%)\ncost: $${s.total_cost_usd.toFixed(4)}\noutput: ${formatTokens(s.output_tokens)} tokens`}
            >
              <div className="session-title">{s.title || "(untitled)"}</div>
              <div className="session-project">{basename(s.cwd) || "unknown"}</div>
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
            </button>
          );
        })}
      </div>
    </aside>
  );
}

type EntryViewProps = { entry: Entry; toolUseMap: Map<string, ToolMeta> };

const EntryView = memo(({ entry, toolUseMap }: EntryViewProps) => {
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
    const meta = toolUseMap.get(entry.toolUseId);
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

function BlockView({ block }: { block: Block }) {
  if (block.type === "text") {
    const text = (block as TextBlock).text ?? "";
    return (
      <div className="block text markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  }

  if (block.type === "thinking") {
    const t = (block as ThinkingBlock).thinking ?? "";
    return (
      <details className="block thinking" open>
        <summary>thinking</summary>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{t}</ReactMarkdown>
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

function TypingIndicator() {
  return (
    <div className="typing">
      <span /><span /><span />
    </div>
  );
}

export default App;
