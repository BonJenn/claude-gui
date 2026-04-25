import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { compileMarkdown } from "./markdown";
import { notifyErr } from "./toast";
import {
  type Block,
  type Entry,
  type StreamEvent,
  type PartialEvent,
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolMeta,
  randomId,
  buildHistory,
  EntryView,
  TypingIndicator,
  setToolUseMapForPanel,
  EditableTitle,
  SESSION_TAIL_LIMIT,
  looksLikeYesNoQuestion,
  notifyTurnComplete,
} from "./App";

// A self-contained live session. Each LivePanel owns its own subprocess,
// transcript, composer, and event listeners scoped to its panelId. Used by
// grid mode to show up to 6 conversations running in parallel.
export function LivePanel({
  panelId,
  initialSessionId,
  initialCwd,
  initialModel,
  initialTitle,
  initialMtime,
  permissionMode,
  repo,
  sessionCache,
  isActive,
  useWorktree,
  onFocus,
  onRemove,
  onRename,
  onSessionStarted,
  onExpand,
  dragOver,
  dragging,
  onHandleDragStart,
  onHandleDragEnd,
  onPanelDragOver,
  onPanelDragLeave,
  onPanelDrop,
}: {
  panelId: string;
  initialSessionId?: string;
  initialCwd: string;
  initialModel: string;
  initialTitle?: string;
  /** File mtime of the session JSONL at the time we started tracking
   *  it. Passed so the lazy history loader can tag sessionCache with
   *  the same mtime single-view resumeSession uses for its cache-hit
   *  check — otherwise an expand-from-grid always triggers a slow
   *  JSONL reload. */
  initialMtime?: number;
  permissionMode: string;
  repo: string;
  sessionCache: Map<
    string,
    { entries: Entry[]; toolUseMap: Map<string, ToolMeta>; mtime_ms: number }
  >;
  isActive: boolean;
  useWorktree?: boolean;
  onFocus: () => void;
  onRemove: () => void;
  onRename?: (id: string, cwd: string, title: string) => Promise<void>;
  onSessionStarted?: (panelId: string, sessionId: string) => void;
  /** Double-click handler — expand this panel into the main single-view
   *  mode. Only fires once the panel has a real session id. The panelId
   *  is forwarded so the parent can stop this grid subprocess before
   *  the single-view start_session trips the single-writer gate. */
  onExpand?: (sessionId: string, cwd: string, panelId: string) => void;
  dragOver?: boolean;
  dragging?: boolean;
  onHandleDragStart?: (e: React.DragEvent<HTMLSpanElement>) => void;
  onHandleDragEnd?: (e: React.DragEvent<HTMLSpanElement>) => void;
  onPanelDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onPanelDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  onPanelDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>(() => {
    if (initialSessionId) {
      const cached = sessionCache.get(initialSessionId);
      if (cached) return cached.entries.slice();
    }
    return [];
  });
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<
    { id: string; path: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [sessionOn, setSessionOn] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [title, setTitle] = useState<string | undefined>(initialTitle);
  useEffect(() => {
    setTitle(initialTitle);
  }, [initialTitle]);
  const [pendingPermission, setPendingPermission] =
    useState<PermissionRequest | null>(null);
  // `claude -p` doesn't delegate permissions via control_request — it
  // auto-denies and reports denials in the result event. We surface
  // them so grid panels can retry-with-bypass, same as the main session.
  const [pendingDenials, setPendingDenials] = useState<
    Array<{ tool_name: string; tool_input?: unknown }> | null
  >(null);
  // Remember the last user message so "allow and retry" can replay it
  // after the subprocess is restarted in bypassPermissions.
  const lastUserMessageRef = useRef<string>("");
  // Panel's current permission mode — starts at the prop, can change
  // if we restart the subprocess for "allow and retry".
  const currentModeRef = useRef(permissionMode);
  // Attention state for the tile border: flashing amber when claude is
  // waiting on the user (permission prompt), green when a task just
  // finished successfully, red on error. Clears when the user focuses
  // the panel so it's acknowledge-on-click.
  const [attention, setAttention] = useState<
    "permission" | "completed" | "error" | null
  >(null);
  useEffect(() => {
    if (isActive) setAttention(null);
  }, [isActive]);
  useEffect(() => {
    if (!pendingPermission && attention === "permission") setAttention(null);
  }, [pendingPermission, attention]);
  // Short-lived "done" window after a successful turn. The border-glow
  // version of attention stays until the user clicks; the header status
  // label auto-fades to idle so it's not lying about the current state
  // indefinitely.
  const [justCompleted, setJustCompleted] = useState(false);
  useEffect(() => {
    if (attention !== "completed") {
      setJustCompleted(false);
      return;
    }
    setJustCompleted(true);
    const t = window.setTimeout(() => setJustCompleted(false), 4000);
    return () => window.clearTimeout(t);
  }, [attention]);
  // Listen for files dropped onto this tile. App's global drag-drop
  // handler hit-tests the cursor position and dispatches a CustomEvent
  // on the tile under the pointer; we pick it up here and grow the
  // panel's own attachment list.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onDrop = (ev: Event) => {
      const paths = (ev as CustomEvent<string[]>).detail;
      if (!Array.isArray(paths) || paths.length === 0) return;
      setAttachments((prev) => {
        const existing = new Set(prev.map((a) => a.path));
        const additions = paths
          .filter((p) => !existing.has(p))
          .map((p) => ({ id: randomId(), path: p }));
        return additions.length === 0 ? prev : [...prev, ...additions];
      });
    };
    el.addEventListener("blackcrab:drop-files", onDrop as EventListener);
    return () =>
      el.removeEventListener(
        "blackcrab:drop-files",
        onDrop as EventListener,
      );
  }, []);
  const streamingIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  // Tracks whether we've already notified the host that this panel's
  // subprocess reported its session id. Keeping this in a ref lets us
  // call onSessionStarted outside any setState updater — calling it from
  // inside a reducer triggers React's "setState-in-render" warning
  // because parent state updates would run during our render phase.
  const notifiedStartRef = useRef(false);

  const toolUseMap = useMemo(() => {
    if (initialSessionId) {
      const cached = sessionCache.get(initialSessionId);
      if (cached) return new Map(cached.toolUseMap);
    }
    return new Map<string, ToolMeta>();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  // Publish this panel's tool-use map so memoized EntryView can look up
  // tool metadata without taking the map as a prop.
  useEffect(() => {
    setToolUseMapForPanel(panelId, toolUseMap);
    return () => setToolUseMapForPanel(panelId, null);
  }, [panelId, toolUseMap]);

  // Lazily load history for pinned sessions when the in-memory cache is
  // cold (e.g. fresh app start before prewarm has reached this session).
  // Without this, the tile would be blank until the user sends a message
  // and claude starts emitting fresh events.
  const historyLoadedRef = useRef(false);
  useEffect(() => {
    if (historyLoadedRef.current) return;
    if (!initialSessionId || !initialCwd) return;
    if (entries.length > 0) {
      historyLoadedRef.current = true;
      return;
    }
    historyLoadedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const events = await invoke<Array<Record<string, unknown>>>(
          "load_session_tail",
          {
            sessionId: initialSessionId,
            cwd: initialCwd,
            limit: SESSION_TAIL_LIMIT,
          },
        );
        if (cancelled) return;
        const { entries: history, toolUseMap: loadedMap } = buildHistory(
          events,
          repo,
          { precompileMarkdown: false },
        );
        for (const [k, v] of loadedMap) toolUseMap.set(k, v);
        setEntries(history);
        sessionCache.set(initialSessionId, {
          entries: history,
          toolUseMap: loadedMap,
          mtime_ms: initialMtime ?? 0,
        });
      } catch {
        // Best-effort — if load fails, the panel stays empty until the
        // user's next message brings fresh events.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId, initialCwd]);

  // Mirror live entries into the shared sessionCache so that switching
  // to this session in single view (via sidebar click or palette) shows
  // the most recent messages. Without this, the cache only ever holds
  // whatever the lazy loader wrote on mount and misses streaming
  // updates that happened while the tile was open.
  useEffect(() => {
    const id = sessionId || initialSessionId;
    if (!id) return;
    sessionCache.set(id, {
      entries,
      toolUseMap,
      mtime_ms: Date.now(),
    });
  }, [entries, sessionId, initialSessionId, toolUseMap, sessionCache]);

  const handleEvent = useCallback(
    (ev: StreamEvent) => {
      // Claude asks the frontend for permission via control_request /
      // subtype=can_use_tool. We surface it to the user and reply with
      // control_response via send_raw.
      const any = ev as Record<string, unknown>;
      if (any.type === "control_request") {
        const req = any.request as Record<string, unknown> | undefined;
        if (req && req.subtype === "can_use_tool") {
          setPendingPermission({
            requestId: String(any.request_id ?? ""),
            toolName: String(req.tool_name ?? "unknown"),
            input: req.input,
          });
          setAttention("permission");
        }
        return;
      }
      if (ev.type === "system" && ev.subtype === "init") {
        if (ev.session_id) {
          setSessionId(ev.session_id);
          if (!notifiedStartRef.current && onSessionStarted) {
            notifiedStartRef.current = true;
            onSessionStarted(panelId, ev.session_id);
          }
        }
        return;
      }

      if (ev.type === "stream_event") {
        handlePartial(ev.event, {
          setEntries,
          streamingIdRef,
          toolUseMap,
          repo,
        });
        return;
      }

      if (ev.type === "assistant") {
        const msgId = ev.message.id;
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
        for (const b of blocks) {
          if (b.type === "tool_use") {
            const tu = b as ToolUseBlock;
            if (tu.id && tu.name) {
              toolUseMap.set(tu.id, { name: tu.name, input: tu.input });
            }
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
          setEntries((es) => {
            const additions: Entry[] = [...toolResults];
            if (textParts.length) {
              additions.push({
                kind: "user",
                id: randomId(),
                text: textParts.join("\n"),
              });
            }
            return [...es, ...additions];
          });
        }
        return;
      }

      if (ev.type === "result") {
        setBusy(false);
        streamingIdRef.current = null;
        const cost = ev.total_cost_usd != null ? ` • $${ev.total_cost_usd.toFixed(4)}` : "";
        const dur = ev.duration_ms != null ? ` • ${(ev.duration_ms / 1000).toFixed(1)}s` : "";
        // Claude surfaces the real failure reason in one of several
        // places depending on CLI version: a top-level `error` string,
        // or an `errors` array. Check both so the user sees something
        // actionable instead of the opaque `error_during_execution`.
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
        if (ev.is_error) {
          // eslint-disable-next-line no-console
          console.error(`[panel:${panelId}] result error`, ev);
        }
        const text =
          ev.is_error && errorDetail
            ? `error • ${errorDetail}${cost}${dur}`
            : `${ev.subtype}${cost}${dur}`;
        setEntries((es) => [
          ...es,
          {
            kind: "result",
            id: randomId(),
            text,
            isError: ev.is_error,
          },
        ]);
        // Native notification when window isn't focused.
        (() => {
          let body = "";
          const current = entries;
          for (let i = current.length - 1; i >= 0; i--) {
            const e = current[i];
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
          if (!body) body = ev.is_error ? "turn ended with an error" : "turn complete";
          void notifyTurnComplete({
            title: title || "Claude",
            body,
            isError: !!ev.is_error,
          });
        })();
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
            .map((d) => ({
              tool_name: d.tool_name,
              tool_input: d.tool_input,
            }));
          if (parsed.length > 0) setPendingDenials(parsed);
        }
        // Red wins over green: an earlier error shouldn't be cleared by a
        // later successful result, per the "red until the user clicks"
        // rule. Permission-flash is always superseded because by the time
        // we see a result the prompt has been answered.
        setAttention((prev) =>
          ev.is_error ? "error" : prev === "error" ? prev : "completed",
        );
        return;
      }

      // Top-level error event (API failure etc.) — paint the tile red.
      const evAny = ev as { type?: string };
      if (evAny.type === "error") {
        setAttention("error");
        return;
      }
    },
    [toolUseMap, repo, panelId],
  );

  // Boot the subprocess exactly once on mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await invoke("start_session", {
          panelId,
          cwd: initialCwd,
          permissionMode,
          model: initialModel || null,
          resumeId: initialSessionId || null,
          useWorktree: !!useWorktree,
        });
        setSessionOn(true);
      } catch (e) {
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `failed to start: ${e}` },
        ]);
        notifyErr(`panel ${panelId.slice(0, 8)} failed to start`)(e);
      }
    })();
    return () => {
      // Kill the subprocess on unmount so sessions don't pile up.
      invoke("stop_session", { panelId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

  useEffect(() => {
    let off1: (() => void) | null = null;
    let off2: (() => void) | null = null;
    let off3: (() => void) | null = null;
    const p1 = listen<{ panel_id: string; line: string }>(
      "claude-event",
      (e) => {
        if (e.payload?.panel_id !== panelId) return;
        const line = e.payload?.line;
        if (typeof line !== "string") return;
        try {
          handleEvent(JSON.parse(line) as StreamEvent);
        } catch {
          // ignore bad lines
        }
      },
    );
    const p2 = listen<{ panel_id: string }>("claude-done", (e) => {
      if (e.payload?.panel_id !== panelId) return;
      setSessionOn(false);
      setBusy(false);
    });
    // Mirror stderr to the console so grid-panel spawn failures are
    // diagnosable without wiring up a per-panel stderr drawer.
    const p3 = listen<{ panel_id: string; line: string }>(
      "claude-stderr",
      (e) => {
        if (e.payload?.panel_id !== panelId) return;
        const line = e.payload?.line ?? "";
        if (line) {
          // eslint-disable-next-line no-console
          console.warn(`[panel:${panelId}] stderr`, line);
        }
      },
    );
    p1.then((u) => (off1 = u)).catch(() => {});
    p2.then((u) => (off2 = u)).catch(() => {});
    p3.then((u) => (off3 = u)).catch(() => {});
    return () => {
      if (off1) off1();
      if (off2) off2();
      if (off3) off3();
    };
  }, [panelId, handleEvent]);

  // Auto-scroll to bottom when entries change if we were at/near bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    const attachList = attachments.map((a) => `- ${a.path}`).join("\n");
    const body =
      attachments.length > 0
        ? `${text || "(see attached files)"}\n\n[Attached files]\n${attachList}`
        : text;
    setInput("");
    setAttachments([]);
    setEntries((es) => [...es, { kind: "user", id: randomId(), text: body }]);
    lastUserMessageRef.current = body;
    setBusy(true);
    try {
      await invoke("send_message", { panelId, text: body });
    } catch (e) {
      setBusy(false);
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `send failed: ${e}` },
      ]);
      notifyErr("send failed")(e);
    }
  }, [input, busy, panelId, attachments]);

  // Fire a short user reply without touching input/attachments — used
  // by the yes/no quick-reply buttons.
  const sendQuickReply = useCallback(
    async (text: string) => {
      if (busy || !text) return;
      setEntries((es) => [...es, { kind: "user", id: randomId(), text }]);
      lastUserMessageRef.current = text;
      setBusy(true);
      try {
        await invoke("send_message", { panelId, text });
      } catch (e) {
        setBusy(false);
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `send failed: ${e}` },
        ]);
        notifyErr("send failed")(e);
      }
    },
    [busy, panelId],
  );

  // Restart this panel's subprocess in bypassPermissions mode and replay
  // the last user message. Used by the denial overlay's "allow & retry".
  const allowAndRetry = useCallback(async () => {
    const resendText = lastUserMessageRef.current;
    setPendingDenials(null);
    currentModeRef.current = "bypassPermissions";
    try {
      await invoke("start_session", {
        panelId,
        cwd: initialCwd,
        permissionMode: "bypassPermissions",
        model: initialModel || null,
        resumeId: sessionId || initialSessionId || null,
      });
      setSessionOn(true);
      if (resendText) {
        setEntries((es) => [
          ...es,
          { kind: "user", id: randomId(), text: resendText },
        ]);
        setBusy(true);
        await invoke("send_message", { panelId, text: resendText });
      }
    } catch (e) {
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `retry failed: ${e}` },
      ]);
      notifyErr("retry failed")(e);
    }
  }, [panelId, initialCwd, initialModel, sessionId, initialSessionId]);

  const interrupt = useCallback(() => {
    invoke("interrupt_session", { panelId }).catch((err) =>
      console.error("interrupt failed", err),
    );
  }, [panelId]);

  const project = initialCwd.split("/").filter(Boolean).pop() || initialCwd;
  // Persistent per-panel status label. Drawn from the same signals
  // the transient border-glow (`attention`) already uses, so they
  // stay in sync.
  const status: "error" | "waiting" | "thinking" | "done" | "idle" =
    attention === "error"
      ? "error"
      : pendingPermission
      ? "waiting"
      : busy
      ? "thinking"
      : justCompleted
      ? "done"
      : "idle";

  return (
    <div
      ref={rootRef}
      className={`grid-panel live ${isActive ? "active" : ""} ${
        attention ? `attention-${attention}` : ""
      } ${dragOver ? "drag-over" : ""} ${dragging ? "dragging" : ""}`}
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
      onMouseDown={onFocus}
      onDoubleClick={(e) => {
        // Leave the composer and interactive controls alone so their
        // own double-click semantics (word-select in the textarea,
        // link open, button press) still work.
        const tgt = e.target as HTMLElement | null;
        if (
          tgt &&
          tgt.closest(
            "textarea, input, button, a, .editable-title-input, .grid-panel-composer",
          )
        )
          return;
        if (onExpand && sessionId) {
          // Flush the panel's current live entries into the shared
          // session cache so the main single-view opens with the most
          // up-to-date transcript, not just whatever the lazy loader
          // saved earlier.
          sessionCache.set(sessionId, {
            entries: entries.slice(),
            toolUseMap: new Map(toolUseMap),
            mtime_ms: initialMtime ?? Date.now(),
          });
          onExpand(sessionId, initialCwd, panelId);
        }
      }}
      title="double-click to expand into single view"
    >
      <header className="grid-panel-head">
        {onHandleDragStart && (
          <span
            className="grid-panel-drag"
            draggable
            onDragStart={onHandleDragStart}
            onDragEnd={onHandleDragEnd}
            onMouseDown={(e) => e.stopPropagation()}
            title="drag to reorder"
            aria-label="drag to reorder"
          >
            ⠿
          </span>
        )}
        {onRename && sessionId ? (
          <EditableTitle
            className="grid-panel-title"
            value={title || ""}
            placeholder="(new)"
            title={title || sessionId}
            onSave={async (next) => {
              setTitle(next);
              await onRename(sessionId, initialCwd, next);
            }}
          />
        ) : (
          <div className="grid-panel-title" title={title || sessionId}>
            {title || "(new)"}
          </div>
        )}
        <div className="grid-panel-meta">
          <span
            className={`panel-status panel-status-${status}`}
            title={`status: ${status}`}
            aria-label={`status: ${status}`}
          >
            <span className="panel-status-dot" />
            <span className="panel-status-label">{status}</span>
          </span>
          <span className={`dot ${sessionOn ? "on" : "off"}`} />
          <span className="grid-panel-project">{project}</span>
          <button
            type="button"
            className="grid-panel-close"
            onClick={onRemove}
            title="close panel (stops subprocess)"
            aria-label="close"
          >
            ×
          </button>
        </div>
      </header>
      <div className="grid-panel-body" ref={scrollRef}>
        {entries.map((entry) => (
          <div key={entry.id} className="transcript-row">
            <EntryView entry={entry} />
          </div>
        ))}
        {busy && <TypingIndicator />}
        {pendingPermission && (
          <PermissionPrompt
            req={pendingPermission}
            onAllow={() => {
              respondPermission(panelId, pendingPermission, true);
              setPendingPermission(null);
            }}
            onDeny={() => {
              respondPermission(panelId, pendingPermission, false);
              setPendingPermission(null);
            }}
            onAllowAndBypass={() => {
              respondPermission(panelId, pendingPermission, true);
              setPermissionModeOnPanel(panelId, "bypassPermissions");
              setPendingPermission(null);
            }}
          />
        )}
        {pendingDenials && (
          <div className="permission-prompt">
            <div className="permission-prompt-title">
              claude wanted to use{" "}
              {pendingDenials.length === 1 ? (
                <span className="permission-tool">
                  {pendingDenials[0].tool_name}
                </span>
              ) : (
                <span className="permission-tool">
                  {pendingDenials.length} tools
                </span>
              )}{" "}
              but the current permission mode blocked it.
            </div>
            {pendingDenials.slice(0, 2).map((d, i) => {
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
            <div className="permission-prompt-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setPendingDenials(null)}
              >
                Dismiss
              </button>
              <button className="btn btn-primary" onClick={allowAndRetry}>
                Allow all tools &amp; retry
              </button>
            </div>
          </div>
        )}
      </div>
      <footer className="grid-panel-composer">
        {(() => {
          if (busy) return null;
          let lastText = "";
          for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.kind === "user") break;
            if (e.kind === "assistant") {
              for (let j = e.blocks.length - 1; j >= 0; j--) {
                const b = e.blocks[j];
                // `blocks` can be sparse while streaming writes to
                // specific indices — undefined slots must be skipped.
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
            <div
              className="quick-replies panel-quick-replies"
              role="group"
              aria-label="quick reply"
            >
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
                onClick={() => {
                  const ta = rootRef.current?.querySelector(
                    "textarea",
                  ) as HTMLTextAreaElement | null;
                  ta?.focus();
                }}
              >
                Let's chat about it
              </button>
            </div>
          );
        })()}
        {attachments.length > 0 && (
          <div className="attachments panel-attachments">
            {attachments.map((a) => {
              const name = a.path.split("/").pop() || a.path;
              return (
                <span key={a.id} className="attachment" title={a.path}>
                  <span className="attachment-name">{name}</span>
                  <button
                    type="button"
                    className="attachment-remove"
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((x) => x.id !== a.id),
                      )
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
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="message…  (Enter to send; drop files on this tile to attach)"
          disabled={busy}
          rows={2}
        />
        {busy ? (
          <button
            type="button"
            className="btn btn-interrupt"
            onClick={interrupt}
          >
            stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-send"
            onClick={send}
            disabled={!input.trim() && attachments.length === 0}
          >
            send
          </button>
        )}
      </footer>
    </div>
  );
}

// Shared delta-accumulator for stream_event deltas. Mirrors the main App's
// handlePartial so live panels render the same way.
function handlePartial(
  e: PartialEvent,
  ctx: {
    setEntries: React.Dispatch<React.SetStateAction<Entry[]>>;
    streamingIdRef: React.MutableRefObject<string | null>;
    toolUseMap: Map<string, ToolMeta>;
    repo: string;
  },
) {
  const { setEntries, streamingIdRef, toolUseMap, repo } = ctx;

  if (e.type === "message_start") {
    const ms = e as { message: { id: string } };
    streamingIdRef.current = ms.message.id;
    setEntries((es) => {
      const idx = es.findIndex(
        (x) => x.kind === "assistant" && x.id === ms.message.id,
      );
      if (idx >= 0) return es;
      return [...es, { kind: "assistant", id: ms.message.id, blocks: [] }];
    });
    return;
  }

  const id = streamingIdRef.current;
  if (!id) return;

  const updateBlocks = (fn: (blocks: Block[]) => Block[]) =>
    setEntries((es) => {
      const idx = es.findIndex((x) => x.kind === "assistant" && x.id === id);
      if (idx < 0) return es;
      const entry = es[idx] as Extract<Entry, { kind: "assistant" }>;
      const next = es.slice();
      next[idx] = { ...entry, blocks: fn(entry.blocks) };
      return next;
    });

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
      delta: {
        type: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
      };
    };
    updateBlocks((blocks) => {
      const next = blocks.slice();
      const b = next[de.index];
      if (!b) return blocks;
      if (de.delta.type === "text_delta" && b.type === "text") {
        (b as TextBlock).text = ((b as TextBlock).text ?? "") + (de.delta.text ?? "");
      } else if (
        de.delta.type === "thinking_delta" &&
        b.type === "thinking"
      ) {
        (b as ThinkingBlock).thinking =
          ((b as ThinkingBlock).thinking ?? "") + (de.delta.thinking ?? "");
      } else if (
        de.delta.type === "input_json_delta" &&
        b.type === "tool_use"
      ) {
        const tu = b as ToolUseBlock;
        tu._inputJson = (tu._inputJson ?? "") + (de.delta.partial_json ?? "");
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
      const cleaned: Block = { ...b } as Block;
      if (cleaned.type === "text") {
        const tb = cleaned as TextBlock;
        delete tb._streaming;
        tb._html = compileMarkdown(tb.text ?? "", repo);
      }
      if (cleaned.type === "thinking") {
        const thb = cleaned as ThinkingBlock;
        delete thb._streaming;
        thb._html = compileMarkdown(thb.thinking ?? "", repo);
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
          toolUseMap.set(tu.id, { name: tu.name, input: tu.input });
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

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: unknown;
};

function randomRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function respondPermission(
  panelId: string,
  req: PermissionRequest,
  allow: boolean,
) {
  const body = {
    type: "control_response",
    response: {
      request_id: req.requestId,
      subtype: "success",
      response: allow
        ? { behavior: "allow", updated_input: req.input }
        : { behavior: "deny", message: "user denied" },
    },
  };
  try {
    await invoke("send_raw", {
      panelId,
      line: JSON.stringify(body),
    });
  } catch (err) {
    console.error("permission respond failed", err);
  }
}

export async function setPermissionModeOnPanel(panelId: string, mode: string) {
  const body = {
    type: "control_request",
    request_id: randomRequestId(),
    request: { subtype: "set_permission_mode", mode },
  };
  try {
    await invoke("send_raw", {
      panelId,
      line: JSON.stringify(body),
    });
  } catch (err) {
    console.error("set_permission_mode failed", err);
  }
}

function PermissionPrompt({
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
    <div className="permission-prompt">
      <div className="permission-prompt-title">
        claude wants to use <span className="permission-tool">{req.toolName}</span>
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
  );
}
