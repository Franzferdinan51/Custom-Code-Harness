// Multimodal helpers shared by OpenAI-compatible and omni providers.

import type {
  ChatMessage,
  ContentPart,
  ImageGenerationRequest,
  ImageGenerationResult,
  Modality,
  ProviderCapabilities,
  ProviderRequest,
  ToolSpec,
} from "../types.js";
import type { ProviderPreset } from "./presets.js";

const DEFAULT_IMAGE_SIZE = "1024x1024";

/** Resolve capability flags for a built-in preset id. */
export function capabilitiesForPreset(id: string): ProviderCapabilities {
  switch (id) {
    case "vllm-omni":
      return { omni: true, imageOutput: true, imageInput: true, reasoning: true };
    case "vllm":
      return { reasoning: true };
    case "codex":
      return { omni: true, imageInput: true, reasoning: true, responsesApi: true };
    case "openai":
      return { imageInput: true, imageOutput: true, reasoning: true };
    default:
      return {};
  }
}

/** Merge preset-declared capabilities with inferred defaults. */
export function resolveProviderCapabilities(preset?: ProviderPreset | null): ProviderCapabilities {
  if (!preset) return {};
  return { ...capabilitiesForPreset(preset.id), ...(preset.capabilities ?? {}) };
}

/** True when the provider supports image generation tooling. */
export function supportsImageOutput(caps?: ProviderCapabilities): boolean {
  return Boolean(caps?.imageOutput || caps?.omni);
}

/** Convert a user attachment into a ContentPart. */
export function attachmentToContentPart(input: {
  type?: string;
  url: string;
  mimeType?: string;
}): ContentPart | null {
  const url = input.url?.trim();
  if (!url) return null;
  const mime = (input.mimeType ?? "").toLowerCase();
  const kind = (input.type ?? "").toLowerCase();
  if (kind === "image" || mime.startsWith("image/")) {
    return { type: "image_url", image_url: { url }, mimeType: mime || undefined };
  }
  if (kind === "audio" || mime.startsWith("audio/")) {
    const format = mime.includes("/") ? mime.split("/")[1]! : "wav";
    const data = url.startsWith("data:") ? url.split(",")[1] ?? url : url;
    return { type: "input_audio", input_audio: { data, format }, mimeType: mime || undefined };
  }
  if (kind === "video" || mime.startsWith("video/")) {
    return { type: "video_url", video_url: { url }, mimeType: mime || undefined };
  }
  if (url.startsWith("data:image/")) {
    return { type: "image_url", image_url: { url }, mimeType: mime || undefined };
  }
  return null;
}

/** Build ContentPart[] for a user message from plain text + optional attachments. */
export function buildUserContentParts(text: string, attachments?: Array<{ type?: string; url: string; mimeType?: string }>): ContentPart[] | undefined {
  const parts: ContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) parts.push({ type: "text", text: trimmed });
  for (const att of attachments ?? []) {
    const part = attachmentToContentPart(att);
    if (part) parts.push(part);
  }
  return parts.length > 0 ? parts : undefined;
}

/** Serialize ContentPart[] to OpenAI chat message content (string or array). */
export function contentPartsToOpenAI(parts: ContentPart[] | undefined, fallbackText: string): string | unknown[] {
  if (!parts || parts.length === 0) return fallbackText;
  if (parts.length === 1 && parts[0]!.type === "text") return parts[0]!.text;
  return parts.map((p) => {
    switch (p.type) {
      case "text":
        return { type: "text", text: p.text };
      case "image_url":
        return { type: "image_url", image_url: p.image_url };
      case "input_audio":
        return { type: "input_audio", input_audio: p.input_audio };
      case "video_url":
        return { type: "video_url", video_url: p.video_url };
      default:
        return { type: "text", text: fallbackText };
    }
  });
}

/** Convert harness messages to OpenAI chat/completions message array. */
export function toOpenAIMessages(req: ProviderRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argsJson },
        })),
      });
      continue;
    }
    const content = contentPartsToOpenAI(m.contentParts, m.content);
    out.push({ role: m.role, content });
  }
  return out;
}

/** Convert harness messages to OpenAI Responses API `input` array. */
export function toResponsesInput(req: ProviderRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) {
    out.push({ role: "developer", content: [{ type: "input_text", text: req.system }] });
  }
  for (const m of req.messages) {
    if (m.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content,
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      if (m.content) {
        out.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      for (const tc of m.toolCalls) {
        out.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.argsJson,
        });
      }
      continue;
    }
    const parts = m.contentParts ?? (m.content ? [{ type: "text" as const, text: m.content }] : []);
    const mapped = parts.map((p) => {
      switch (p.type) {
        case "text":
          return { type: m.role === "assistant" ? "output_text" : "input_text", text: p.text };
        case "image_url":
          return { type: "input_image", image_url: p.image_url.url, detail: "auto" };
        case "input_audio":
          return { type: "input_audio", input_audio: p.input_audio };
        case "video_url":
          return { type: "input_video", video_url: p.video_url.url };
        default:
          return { type: "input_text", text: m.content };
      }
    });
    out.push({ role: m.role, content: mapped });
  }
  return out;
}

export function toOpenAITool(t: ToolSpec): unknown {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

/** Call a provider's /v1/images/generations endpoint. */
export async function generateImageViaOpenAICompat(opts: {
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  req: ImageGenerationRequest;
}): Promise<ImageGenerationResult> {
  const url = new URL("/images/generations", opts.baseUrl).toString();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const body = {
    model: opts.req.model ?? opts.defaultModel ?? "dall-e-3",
    prompt: opts.req.prompt,
    size: opts.req.size ?? DEFAULT_IMAGE_SIZE,
    response_format: "b64_json",
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.req.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image generation HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const j = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const first = j.data?.[0];
  if (!first) throw new Error("image generation returned no data");
  if (first.url) {
    return { url: first.url, revisedPrompt: first.revised_prompt };
  }
  if (first.b64_json) {
    return {
      url: `data:image/png;base64,${first.b64_json}`,
      mimeType: "image/png",
      revisedPrompt: first.revised_prompt,
    };
  }
  throw new Error("image generation response missing url or b64_json");
}

/** Infer modalities present in a message. */
export function modalitiesInMessage(m: ChatMessage): Modality[] {
  const out = new Set<Modality>();
  if (m.content?.trim()) out.add("text");
  for (const p of m.contentParts ?? []) {
    if (p.type === "text") out.add("text");
    if (p.type === "image_url") out.add("image");
    if (p.type === "input_audio") out.add("audio");
    if (p.type === "video_url") out.add("video");
  }
  return [...out];
}