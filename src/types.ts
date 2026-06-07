// Foundational types shared across the harness.
// Keep this file dependency-free so it can be imported by anything.

export type Role = "system" | "user" | "assistant" | "tool";

/** A single message in a conversation. */
export interface ChatMessage {
  role: Role;
  /** Text content. May be empty when the message only contains tool calls. */
  content: string;
  /** Optional reasoning/thinking content. Most providers ignore this. */
  reasoning?: string;
  /** Tool calls requested by the assistant. */
  toolCalls?: ToolCall[];
  /** For role=tool: id of the tool call this is a result for. */
  toolCallId?: string;
  /** For role=tool: name of the tool that produced this. */
  toolName?: string;
  /** Free-form metadata (provider, latency, retries, etc). */
  meta?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments, always a JSON string. Parse with parseToolArgs(). */
  argsJson: string;
}

export interface ToolResult {
  toolCallId: string;
  /** Short, single-line summary for the user. */
  display: string;
  /** Full content for the model. May be large; size-capped downstream. */
  content: string;
  /** True if the tool failed and the model should be told. */
  isError: boolean;
}

/** Tool definition in OpenAI function-calling shape (subset). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

/** Minimal JSON-Schema-ish object. We only use a subset the LLM APIs accept. */
export type JsonSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ProviderRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Soft cap. Providers may ignore. */
  maxTokens?: number;
  /** Sampling temperature 0..2. */
  temperature?: number;
  /** Abort signal — fires on Esc / Ctrl+C / timeout. */
  signal: AbortSignal;
}

export interface ProviderStreamEvent {
  type: "text" | "reasoning" | "tool_call" | "usage" | "done" | "error";
  text?: string;
  reasoning?: string;
  toolCall?: ToolCall;
  /** Cumulative usage when known. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Set when type=error. */
  error?: { message: string; code?: string };
}

export interface ProviderResponse {
  message: ChatMessage;
  usage: { inputTokens: number; outputTokens: number };
  /** Final raw provider payload (for debugging). */
  raw?: unknown;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  /** Validate that the provider is configured (env vars, etc). */
  isConfigured(): Promise<{ ok: boolean; reason?: string }>;
  /** Stream a single assistant turn. */
  stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  /** Optional: list available models. Used by /model. */
  listModels?(): Promise<string[]>;
}
