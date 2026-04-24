// Lightweight toast bus. Module-level so any file can fire notify()
// without threading a context through every component tree. A single
// ToastHost mounted near the app root subscribes and renders.

export type ToastKind = "error" | "info" | "success";

export type Toast = {
  id: string;
  msg: string;
  kind: ToastKind;
};

type Listener = (t: Toast) => void;

const listeners = new Set<Listener>();

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function notify(msg: string, kind: ToastKind = "error"): void {
  const t: Toast = { id: randomId(), msg, kind };
  listeners.forEach((cb) => cb(t));
}

export function subscribeToasts(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Convenience for .catch(notifyErr("list_sessions failed")) — formats
// the caught value and fires an error toast. Keeps call sites short.
export function notifyErr(prefix: string): (e: unknown) => void {
  return (e) => {
    const detail =
      typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message
          : String(e);
    notify(`${prefix}: ${detail}`, "error");
    console.error(prefix, e);
  };
}
