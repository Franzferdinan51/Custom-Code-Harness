// Tool index. Registers all built-in tools in one place.

import { ToolRegistry } from "./registry.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { findTool } from "./find.js";
import { lsTool } from "./ls.js";
import { spawnSubagentTool } from "./spawn-subagent.js";
import { skillTool } from "./skill.js";
import { memoryTool } from "./memory.js";
import { httpTool } from "./http.js";
import { webSearchTool } from "./web-search.js";
import { todoTool } from "./todo.js";
import { generateImageTool } from "./generate-image.js";

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext } from "./registry.js";

export function defaultToolRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readTool);
  r.register(writeTool);
  r.register(editTool);
  r.register(bashTool);
  r.register(grepTool);
  r.register(findTool);
  r.register(lsTool);
  r.register(httpTool);
  r.register(webSearchTool);
  r.register(todoTool);
  // Always registered; returns a helpful error when the active provider lacks image output.
  r.register(generateImageTool);
  // The two tool-of-tools (spawn_subagent, skill) are registered
  // by the runtime after SubAgentManager / SkillRegistry are wired.
  r._registerRaw(spawnSubagentTool);
  r._registerRaw(skillTool);
  r._registerRaw(memoryTool);
  return r;
}
