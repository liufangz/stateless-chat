// Mandatory drift guard (docs/FEATURE-slash-tools.md §4.1): TOOL_MANIFESTS
// is what the gateway serves to the composer's slash picker, and the real
// worker tool files build their JSON-Schema `parameters`/`description` FROM
// it (manifestToJsonSchema) specifically so this can't happen silently. This
// test is the thing that fails loudly if a tool file is ever edited (new
// arg, renamed arg, changed description) without updating the manifest that
// feeds it - or vice versa.
import { describe, expect, it } from "vitest";
import { TOOL_MANIFESTS, manifestToJsonSchema, toolEnabled, enabledToolManifests } from "@stateless-chat/shared";
import {
  getCurrentDatetimeTool,
  calculatorTool,
  BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  DEFAULT_SUBAGENT_TOOL,
} from "../src/tools/index.js";
import type { Tool } from "../src/tool-loop.js";

// Deliberately NOT DEFAULT_TOOLS (packages/worker/src/tools/index.ts) - that
// array is env-gated (bash/read_file/write_file/edit_file only appear when
// their TOOL_*_ENABLED flag is on), so it would under-cover this guard
// depending on however the test environment's .env happens to be set. Each
// of these module-level exports is always constructed regardless of gating.
const ALL_TOOLS: Tool[] = [
  getCurrentDatetimeTool,
  calculatorTool,
  BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  DEFAULT_SUBAGENT_TOOL,
];

describe("TOOL_MANIFESTS drift guard", () => {
  it("has exactly one manifest per real worker tool, with matching names", () => {
    const toolNames = ALL_TOOLS.map((t) => t.name).sort();
    const manifestNames = TOOL_MANIFESTS.map((m) => m.name).sort();
    expect(manifestNames).toEqual(toolNames);
  });

  it("every tool's real description/parameters are exactly what its manifest produces", () => {
    for (const tool of ALL_TOOLS) {
      const manifest = TOOL_MANIFESTS.find((m) => m.name === tool.name);
      expect(manifest, `no TOOL_MANIFESTS entry for tool '${tool.name}'`).toBeDefined();
      expect(tool.description).toBe(manifest!.description);
      expect(tool.parameters).toEqual(manifestToJsonSchema(manifest!));
      expect(tool.readOnly ?? false).toBe(manifest!.readOnly);
    }
  });
});

describe("manifestToJsonSchema", () => {
  it("marks only required args in the schema's required[] array, in manifest order", () => {
    const manifest = TOOL_MANIFESTS.find((m) => m.name === "read_file")!;
    const schema = manifestToJsonSchema(manifest);
    expect(Object.keys(schema.properties)).toEqual(["path", "offset", "limit"]);
    expect(schema.required).toEqual(["path"]);
    expect(schema.properties.offset).toEqual({ type: "number", description: manifest.args[1].description });
  });

  it("gives an array-typed arg a string items schema", () => {
    const manifest = TOOL_MANIFESTS.find((m) => m.name === "subagent")!;
    const schema = manifestToJsonSchema(manifest);
    expect(schema.properties.tools).toEqual({
      type: "array",
      items: { type: "string" },
      description: manifest.args.find((a) => a.name === "tools")!.description,
    });
  });
});

describe("toolEnabled / enabledToolManifests", () => {
  it("always-on tools are enabled regardless of env flags", () => {
    const allOff = {
      toolBashEnabled: false,
      toolReadFileEnabled: false,
      toolWriteFileEnabled: false,
      toolEditFileEnabled: false,
    };
    expect(toolEnabled("get_current_datetime", allOff)).toBe(true);
    expect(toolEnabled("calculator", allOff)).toBe(true);
    expect(toolEnabled("subagent", allOff)).toBe(true);
  });

  it("gated tools follow their specific env flag, not the others", () => {
    const onlyBash = {
      toolBashEnabled: true,
      toolReadFileEnabled: false,
      toolWriteFileEnabled: false,
      toolEditFileEnabled: false,
    };
    expect(toolEnabled("bash", onlyBash)).toBe(true);
    expect(toolEnabled("read_file", onlyBash)).toBe(false);
    expect(toolEnabled("write_file", onlyBash)).toBe(false);
    expect(toolEnabled("edit_file", onlyBash)).toBe(false);
  });

  it("an unknown tool name is never enabled", () => {
    expect(toolEnabled("some_removed_tool", { toolBashEnabled: true })).toBe(false);
  });

  it("enabledToolManifests filters TOOL_MANIFESTS to the enabled set, preserving manifest order", () => {
    const onlyReadFile = {
      toolBashEnabled: false,
      toolReadFileEnabled: true,
      toolWriteFileEnabled: false,
      toolEditFileEnabled: false,
    };
    const names = enabledToolManifests(onlyReadFile).map((m) => m.name);
    expect(names).toEqual(["get_current_datetime", "calculator", "read_file", "subagent"]);
  });
});
