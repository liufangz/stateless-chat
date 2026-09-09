import { describe, expect, it } from "vitest";
import { parseDirectInvocation, resolveDirectArgs } from "../src/direct-tool.js";
import type { Tool } from "../src/tool-loop.js";

function makeTool(properties: Record<string, unknown>): Tool {
  return {
    name: "test",
    description: "test",
    parameters: { type: "object", properties },
    execute: () => "",
  };
}

describe("parseDirectInvocation", () => {
  it("splits a tool name and trailing args text on the first whitespace", () => {
    expect(parseDirectInvocation("/calculator (2 + 3) * 4")).toEqual({
      toolName: "calculator",
      argsText: "(2 + 3) * 4",
    });
  });

  it("returns an empty argsText for a bare tool name with nothing after it", () => {
    expect(parseDirectInvocation("/calculator")).toEqual({ toolName: "calculator", argsText: "" });
  });

  it("trims the args text", () => {
    expect(parseDirectInvocation("/write_file   {\"a\":1}  ")).toEqual({
      toolName: "write_file",
      argsText: '{"a":1}',
    });
  });

  it("does not validate the tool name against any list - that is the caller's job", () => {
    expect(parseDirectInvocation("/not_a_tool hello")).toEqual({ toolName: "not_a_tool", argsText: "hello" });
  });

  it("returns null for content that doesn't start with '/'", () => {
    expect(parseDirectInvocation("text")).toBeNull();
    expect(parseDirectInvocation("2 + 3")).toBeNull();
    expect(parseDirectInvocation("")).toBeNull();
  });

  it("returns null for a bare '/' with nothing after it", () => {
    expect(parseDirectInvocation("/")).toBeNull();
    expect(parseDirectInvocation("/   ")).toBeNull();
  });
});

describe("resolveDirectArgs", () => {
  it("empty argsText resolves to {}", () => {
    const tool = makeTool({ expression: { type: "string" } });
    expect(resolveDirectArgs(tool, "")).toEqual({});
    expect(resolveDirectArgs(tool, "   ")).toEqual({});
  });

  it("JSON-object argsText parses and is used directly", () => {
    const tool = makeTool({ path: { type: "string" }, content: { type: "string" } });
    expect(resolveDirectArgs(tool, '{"path":"/tmp/x","content":"hi"}')).toEqual({
      path: "/tmp/x",
      content: "hi",
    });
  });

  it("malformed JSON starting with '{' falls through to the single-arg shorthand, not a thrown error", () => {
    const tool = makeTool({ expression: { type: "string" } });
    expect(resolveDirectArgs(tool, "{not valid json")).toEqual({ expression: "{not valid json" });
  });

  it("non-JSON text maps to the sole declared arg for a single-arg tool", () => {
    const tool = makeTool({ expression: { type: "string" } });
    expect(resolveDirectArgs(tool, "(2 + 3) * 4")).toEqual({ expression: "(2 + 3) * 4" });
  });

  it("non-JSON text resolves to {} for a multi-arg tool (accepted call, tool's own validation error follows)", () => {
    const tool = makeTool({ path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } });
    expect(resolveDirectArgs(tool, "foo.txt old new")).toEqual({});
  });

  it("non-JSON text resolves to {} for a zero-arg tool", () => {
    const tool = makeTool({});
    expect(resolveDirectArgs(tool, "anything")).toEqual({});
  });

  it("a leading '[' is not treated as JSON (only a leading '{' triggers JSON parsing) - falls through to shorthand", () => {
    const tool = makeTool({ expression: { type: "string" } });
    expect(resolveDirectArgs(tool, "[1,2,3]")).toEqual({ expression: "[1,2,3]" });
  });
});
