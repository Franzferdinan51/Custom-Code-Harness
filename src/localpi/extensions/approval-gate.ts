// Approval-gate extension. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/pi/extensions.ts
//
// The OTHER half of the approval gate. The daemon's approvals.mode: manual
// already blocks dangerous tool calls. This extension stops the model from
// claiming blocked tools ran. Two pieces:
//   1. Inject a system-prompt rule on before_agent_start
//   2. Block the tool call (return {block: true, reason}) — non-UI auto-block

type UI = {
  confirm(title: string, detail: string): Promise<boolean>;
  hasUI: boolean;
};

type Ctx = { ui: UI; hasUI: boolean };

type BeforeAgentStartEvent = { systemPrompt: string };
type ToolCallEvent = {
  toolName: string;
  input: unknown;
};

type ExtensionAPI = {
  on(event: "before_agent_start", handler: (e: BeforeAgentStartEvent) => { systemPrompt: string } | void): void;
  on(event: "tool_call", handler: (e: ToolCallEvent, ctx: Ctx) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined): void;
};

const APPROVAL_RULE =
  "\n\nTool approval rule: if any tool result says the tool was blocked, " +
  "denied, or requires approval, the tool did not run. Do not claim blocked tools ran.";

export default function approvalGate(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + APPROVAL_RULE
  }));

  pi.on("tool_call", async (event, ctx) => {
    const input = formatInput(event.input);

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Tool call "${event.toolName}" was blocked and did not run because interactive approval is required.`
      };
    }

    const ok = await ctx.ui.confirm(
      `Allow tool call: ${event.toolName}?`,
      input
    );
    if (!ok) {
      return { block: true, reason: "Tool call was blocked by the user and did not run." };
    }
    return undefined;
  });
}

function formatInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  const MAX = 4000;
  return text.length <= MAX ? text : `${text.slice(0, MAX)}\n... truncated ...`;
}
