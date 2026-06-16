// Token-status extension. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/pi/extensions.ts
//
// Drop-in perf status: tok/s | out N | in N | cache N | cw N | elapsed | ctx%

type Theme = { fg(color: string, text: string): string };
type UI = {
  setStatus(key: string, value: string | undefined): void;
  theme: Theme;
  hasUI: boolean;
};

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type AssistantMessage = {
  role: "assistant" | "user" | "system" | "tool";
  usage?: Usage;
};

type TurnStartEvent = Record<string, unknown>;
type TurnEndEvent = { message: AssistantMessage };
type MessageUpdateEvent = {
  assistantMessageEvent?: unknown;
  message?: unknown;
};

type Ctx = { ui: UI; hasUI: boolean };

type ExtensionAPI = {
  on(event: "turn_start", handler: (e: TurnStartEvent) => void): void;
  on(event: "turn_end", handler: (e: TurnEndEvent, ctx: Ctx) => void): void;
  on(event: "message_update", handler: (e: MessageUpdateEvent, ctx: Ctx) => void): void;
  on(event: "session_shutdown", handler: (e: unknown, ctx: Ctx) => void): void;
};

type TurnState = {
  startedAt: number;
  outputText: string;
  estimatedOutputTokens: number;
  lastStatusAt: number;
};

export default function tokenStatus(pi: ExtensionAPI): void {
  let currentTurn: TurnState | undefined;

  pi.on("turn_start", () => {
    currentTurn = {
      startedAt: Date.now(),
      outputText: "",
      estimatedOutputTokens: 0,
      lastStatusAt: 0
    };
  });

  pi.on("message_update", (event, ctx) => {
    const state = currentTurn;
    if (!ctx.hasUI || state === undefined) return;
    const update = textUpdateFromUnknown(
      event.assistantMessageEvent ?? event.message ?? event
    );
    if (update.kind === "delta") {
      state.outputText += update.text;
    } else if (update.text.length > state.outputText.length) {
      state.outputText = update.text;
    }
    state.estimatedOutputTokens = Math.ceil(state.outputText.length / 4);
    if (Date.now() - state.lastStatusAt < 250) return; // throttle 4Hz
    state.lastStatusAt = Date.now();
    ctx.ui.setStatus(
      "token-status",
      ctx.ui.theme.fg("dim", statusText(state))
    );
  });

  pi.on("turn_end", (event, ctx) => {
    const state =
      currentTurn ??
      { startedAt: Date.now(), outputText: "", estimatedOutputTokens: 0, lastStatusAt: 0 };
    currentTurn = undefined;
    if (!ctx.hasUI || event.message.role !== "assistant") return;

    const usage = event.message.usage;
    const output = usage?.output ?? state.estimatedOutputTokens;
    const input = usage?.input ?? 0;
    const cacheRead = usage?.cacheRead ?? 0;
    const cacheWrite = usage?.cacheWrite ?? 0;
    const elapsedSeconds = elapsed(state);
    const context = (ctx.ui as unknown as { getContextUsage?: () => { percent: number | null; contextWindow: number } | null }).getContextUsage?.();
    const contextText =
      context && context.percent !== null
        ? `ctx ${Math.round(context.percent)}%/${Math.round(context.contextWindow / 1000)}k`
        : "ctx ?";

    ctx.ui.setStatus(
      "token-status",
      ctx.ui.theme.fg(
        "dim",
        [
          `${(output / elapsedSeconds).toFixed(1)} tok/s`,
          `out ${output}`,
          `in ${input}`,
          cacheRead > 0 ? `cache ${cacheRead}` : undefined,
          cacheWrite > 0 ? `cw ${cacheWrite}` : undefined,
          `${elapsedSeconds.toFixed(1)}s`,
          contextText
        ]
          .filter(Boolean)
          .join(" | ")
      )
    );
  });

  pi.on("session_shutdown", (_e, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("token-status", "");
  });
}

function statusText(state: TurnState): string {
  const s = elapsed(state);
  return `${(state.estimatedOutputTokens / s).toFixed(1)} tok/s | out ~${state.estimatedOutputTokens} | ${s.toFixed(1)}s`;
}

function elapsed(state: TurnState): number {
  return Math.max((Date.now() - state.startedAt) / 1000, 0.001);
}

type TextUpdate = { kind: "delta" | "snapshot"; text: string };

function textUpdateFromUnknown(value: unknown): TextUpdate {
  if (typeof value === "string") return { kind: "snapshot", text: value };
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const delta = o["delta"];
    const text = o["text"] ?? o["content"];
    if (typeof delta === "string") return { kind: "delta", text: delta };
    if (typeof text === "string") return { kind: "snapshot", text };
  }
  return { kind: "snapshot", text: "" };
}
