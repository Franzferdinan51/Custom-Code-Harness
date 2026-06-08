// generate_image tool — calls the active provider's /v1/images/generations when supported.

import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import { ToolError } from "../../util/errors.js";
import type { ToolSpec } from "../../types.js";
import { supportsImageOutput } from "../../providers/omni.js";

interface GenerateImageArgs {
  prompt: string;
  size?: string;
  model?: string;
}

const spec: ToolSpec = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt using the active provider's image API (vllm-omni, openai, etc). " +
    "Returns a data URL or remote URL the model can reference.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description prompt" },
      size: { type: "string", description: "Optional size, e.g. 1024x1024" },
      model: { type: "string", description: "Optional image model override" },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

export const generateImageTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("generate_image", JSON.stringify(rawArgs));
    return {
      prompt: asString(a.prompt, "prompt", { allowEmpty: false, maxLen: 8_000 }),
      size: a.size !== undefined ? asString(a.size, "size", { maxLen: 32 }) : undefined,
      model: a.model !== undefined ? asString(a.model, "model", { maxLen: 128 }) : undefined,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as GenerateImageArgs;
    const provider = ctx.services?.provider;
    if (!provider) {
      return {
        toolCallId: "",
        display: "no provider available",
        content:
          "generate_image requires an active provider with image output support. " +
          "Switch to vllm-omni or openai, or configure a provider with capabilities.imageOutput.",
        isError: true,
      };
    }
    if (!supportsImageOutput(provider.capabilities) || typeof provider.generateImage !== "function") {
      return {
        toolCallId: "",
        display: "image generation unsupported",
        content:
          `Provider ${provider.id} does not support image generation. ` +
          "Use vllm-omni (capabilities.omni) or openai with an image-capable model.",
        isError: true,
      };
    }
    try {
      const result = await provider.generateImage({
        prompt: args.prompt,
        size: args.size,
        model: args.model,
        signal: ctx.signal,
      });
      const preview = result.url.startsWith("data:") ? "(base64 image)" : result.url;
      return {
        toolCallId: "",
        display: `image generated: ${preview.slice(0, 80)}`,
        content: JSON.stringify({
          url: result.url,
          mimeType: result.mimeType ?? "image/png",
          revisedPrompt: result.revisedPrompt,
        }),
        isError: false,
      };
    } catch (e) {
      throw new ToolError("generate_image", (e as Error).message);
    }
  },
};