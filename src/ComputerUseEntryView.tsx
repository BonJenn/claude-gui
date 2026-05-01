import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Entry } from "./App";
import "@xterm/xterm/css/xterm.css";

type ComputerUseEntry = Extract<Entry, { kind: "computer_use" }>;

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

export default function ComputerUseEntryView({
  entry,
  onSend,
  onStop,
}: {
  entry: ComputerUseEntry;
  onSend: (terminalId: string, data: string) => void;
  onStop: (terminalId: string) => void;
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
    onSend(entry.terminalId, data);
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
            onClick={() => onStop(entry.terminalId)}
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
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => send("y")}
            disabled={!canSend}
          >
            y
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => send("n")}
            disabled={!canSend}
          >
            n
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => send("\x1b[A")}
            disabled={!canSend}
          >
            {"\u2191"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => send("\x1b[B")}
            disabled={!canSend}
          >
            {"\u2193"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => send("\r")}
            disabled={!canSend}
          >
            enter
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => send("\x1b")}
            disabled={!canSend}
          >
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
