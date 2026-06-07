// Error helpers. The agent loop and tool layer both depend on these.

/** An error the model can be told about — it does not abort the run. */
export class ToolError extends Error {
  readonly tool: string;
  readonly isFatal: boolean;
  constructor(tool: string, message: string, opts: { isFatal?: boolean } = {}) {
    super(message);
    this.name = "ToolError";
    this.tool = tool;
    this.isFatal = opts.isFatal ?? false;
  }
}

/** Promise.race with an AbortSignal — rejects with AbortError on abort. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/** Compose multiple AbortSignals — fires when any fires. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
