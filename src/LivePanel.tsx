import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { compileMarkdown } from "./markdown";
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
  EntryView,
  TypingIndicator,
  setToolUseMapForPanel,
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
  permissionMode,
  repo,
  sessionCache,
  isActive,
  onFocus,
  onRemove,
}: {
  panelId: string;
  initialSessionId?: string;
  initialCwd: string;
  initialModel: string;
  initialTitle?: string;
  permissionMode: string;
  repo: string;
  sessionCache: Map<
    string,
    { entries: Entry[]; toolUseMap: Map<string, ToolMeta>; mtime_ms: number }
  >;
  isActive: boolean;
  onFocus: () => void;
  onRemove: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>(() => {
    if (initialSessionId) {
      const cached = sessionCache.get(initialSessionId);
      if (cached) return cached.entries.slice();
    }
    return [];
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionOn, setSessionOn] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const streamingIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

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

  const handleEvent = useCallback(
    (ev: StreamEvent) => {
      if (ev.type === "system" && ev.subtype === "init") {
        if (ev.session_id) setSessionId(ev.session_id);
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
    },
    [toolUseMap, repo],
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
        });
        setSessionOn(true);
      } catch (e) {
        setEntries((es) => [
          ...es,
          { kind: "system", id: randomId(), text: `failed to start: ${e}` },
        ]);
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
    p1.then((u) => (off1 = u)).catch(() => {});
    p2.then((u) => (off2 = u)).catch(() => {});
    return () => {
      if (off1) off1();
      if (off2) off2();
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
    if (!text || busy) return;
    setInput("");
    setEntries((es) => [...es, { kind: "user", id: randomId(), text }]);
    setBusy(true);
    try {
      await invoke("send_message", { panelId, text });
    } catch (e) {
      setBusy(false);
      setEntries((es) => [
        ...es,
        { kind: "system", id: randomId(), text: `send failed: ${e}` },
      ]);
    }
  }, [input, busy, panelId]);

  const interrupt = useCallback(() => {
    invoke("interrupt_session", { panelId }).catch((err) =>
      console.error("interrupt failed", err),
    );
  }, [panelId]);

  const project = initialCwd.split("/").filter(Boolean).pop() || initialCwd;

  return (
    <div
      className={`grid-panel live ${isActive ? "active" : ""}`}
      onMouseDown={onFocus}
    >
      <header className="grid-panel-head">
        <div className="grid-panel-title" title={initialTitle || sessionId}>
          {initialTitle || "(new)"}
        </div>
        <div className="grid-panel-meta">
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
      </div>
      <footer className="grid-panel-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="message…  (Enter to send)"
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
            disabled={!input.trim()}
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
