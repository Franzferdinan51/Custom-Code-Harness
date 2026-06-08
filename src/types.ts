// Foundational types shared across the harness.
// Keep this file dependency-free so it can be imported by anything.

export type Role = "system" | "user" | "assistant" | "tool";

/** Supported multimodal content kinds. */
export type Modality = "text" | "image" | "audio" | "video";

/** A single part of multimodal message content (OpenAI-compatible shape). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; mimeType?: string }
  | { type: "input_audio"; input_audio: { data: string; format: string }; mimeType?: string }
  | { type: "video_url"; video_url: { url: string }; mimeType?: string };

/** Provider capability flags used for routing tools and UI affordances. */
export interface ProviderCapabilities {
  /** Omni-modality inference (text + image/audio/video input/output). */
  omni?: boolean;
  /** Provider can emit images (e.g. /v1/images/generations). */
  imageOutput?: boolean;
  /** Provider can accept image attachments in chat. */
  imageInput?: boolean;
  /** Provider exposes reasoning/thinking stream events. */
  reasoning?: boolean;
  /** Uses OpenAI Responses API transport (Codex OAuth). */
  responsesApi?: boolean;
}

/** A single message in a conversation. */
export interface ChatMessage {
  role: Role;
  /** Text content. May be empty when the message only contains tool calls. */
  content: string;
  /** Optional multimodal parts. When set, providers may prefer these over `content`. */
  contentParts?: ContentPart[];
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
  type: "text" | "reasoning" | "tool_call" | "usage" | "done" | "error" | "image" | "audio" | "video";
  text?: string;
  reasoning?: string;
  toolCall?: ToolCall;
  /** Emitted media (data URL or remote URL). */
  image?: { url: string; mimeType?: string };
  audio?: { data: string; mimeType?: string };
  video?: { url: string; mimeType?: string };
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
  /** Optional capability flags for omni routing and tools. */
  readonly capabilities?: ProviderCapabilities;
  /** Validate that the provider is configured (env vars, etc). */
  isConfigured(): Promise<{ ok: boolean; reason?: string }>;
  /** Stream a single assistant turn. */
  stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  /** Optional: list available models. Used by /model. */
  listModels?(): Promise<string[]>;
  /** Optional: generate an image via provider image API. */
  generateImage?(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  size?: string;
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  url: string;
  mimeType?: string;
  revisedPrompt?: string;
}
