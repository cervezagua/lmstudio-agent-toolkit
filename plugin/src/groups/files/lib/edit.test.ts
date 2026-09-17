import { describe, expect, it } from "vitest";
import { applyEdit } from "./edit";
import { ToolError } from "../../../shared/errors";

describe("applyEdit", () => {
  it("replaces a unique occurrence", () => {
    expect(applyEdit("hello world", "world", "there")).toEqual({ content: "hello there", replacements: 1 });
  });

  it("refuses non-unique matches unless replace_all is set", () => {
    expect(() => applyEdit("a a a", "a", "b")).toThrow(/occurs 3 times/);
    expect(applyEdit("a a a", "a", "b", true)).toEqual({ content: "b b b", replacements: 3 });
  });

  it("reports missing, empty, and no-op edits as ToolErrors", () => {
    expect(() => applyEdit("abc", "xyz", "q")).toThrow(ToolError);
    expect(() => applyEdit("abc", "", "q")).toThrow(ToolError);
    expect(() => applyEdit("abc", "b", "b")).toThrow(ToolError);
  });

  it("does not interpret $ patterns in the replacement", () => {
    expect(applyEdit("price", "price", "$& $1 $$").content).toBe("$& $1 $$");
  });

  it("matches LF old_string against a CRLF file and keeps CRLF", () => {
    const file = "line one\r\nline two\r\nline three\r\n";
    const result = applyEdit(file, "line one\nline two", "first\nsecond");
    expect(result.content).toBe("first\r\nsecond\r\nline three\r\n");
  });
});
