import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// A live PTY-backed terminal panel. Spawns the user's shell in `cwd`
// on mount and kills it on unmount. Bidirectional byte streaming runs
// through Rust: we emit `terminal_write` on keystrokes and receive
// `terminal-output` events for child output.
export function TerminalPanel({
  terminalId,
  cwd,
  visible,
}: {
  terminalId: string;
  cwd: string;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    startedRef.current = true;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12.5,
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

    // Initial fit + spawn the PTY with matching dimensions.
    fit.fit();
    const cols = term.cols;
    const rows = term.rows;

    invoke("terminal_spawn", {
      terminalId,
      cwd,
      cols,
      rows,
    }).catch((e) => {
      term.writeln(`\x1b[31mfailed to start terminal: ${e}\x1b[0m`);
    });

    const writeSub = term.onData((data) => {
      invoke("terminal_write", { terminalId, data }).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      invoke("terminal_resize", { terminalId, cols, rows }).catch(() => {});
    });

    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    listen<{ terminal_id: string; data: string }>("terminal-output", (e) => {
      if (e.payload.terminal_id !== terminalId) return;
      term.write(e.payload.data);
    })
      .then((u) => {
        unlistenOutput = u;
      })
      .catch(() => {});
    listen<{ terminal_id: string }>("terminal-exit", (e) => {
      if (e.payload.terminal_id !== terminalId) return;
      term.writeln("\r\n\x1b[33m[terminal exited]\x1b[0m");
    })
      .then((u) => {
        unlistenExit = u;
      })
      .catch(() => {});

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // fit throws if the container is 0×0 (panel hidden) — safe to ignore.
      }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      writeSub.dispose();
      resizeSub.dispose();
      if (unlistenOutput) unlistenOutput();
      if (unlistenExit) unlistenExit();
      ro.disconnect();
      invoke("terminal_kill", { terminalId }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // When the panel becomes visible, refit so xterm uses the current
  // container size instead of whatever 0×0 state it had while hidden.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // empty
      }
    }, 0);
    return () => clearTimeout(t);
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="terminal-panel-body"
      // xterm needs a concrete size; flex:1 + min-height:0 gets it
      // from the parent flex container.
      style={{ flex: 1, minHeight: 0, minWidth: 0 }}
    />
  );
}
