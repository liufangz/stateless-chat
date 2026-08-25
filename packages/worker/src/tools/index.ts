import { env } from "@stateless-chat/shared";
import type { Tool } from "../tool-loop.js";
import { getCurrentDatetimeTool } from "./datetime.js";
import { calculatorTool } from "./calculator.js";
import { BASH_TOOL } from "./bash.js";

export { getCurrentDatetimeTool } from "./datetime.js";
export { calculatorTool, evaluateExpression } from "./calculator.js";
export { BASH_TOOL, createBashTool, buildBashDockerArgs, runBash } from "./bash.js";

export const DEFAULT_TOOLS: Tool[] = [
  getCurrentDatetimeTool,
  calculatorTool,
  ...(env.toolBashEnabled ? [BASH_TOOL] : []),
];
