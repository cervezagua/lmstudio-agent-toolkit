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

  describe("deleting (an empty new_string)", () => {
    it("takes the line break too when the text was a whole line, and only then", () => {
      expect(applyEdit("a\nfoo\nb\n", "foo", "").content).toBe("a\nb\n");
      expect(applyEdit("foo\nb\n", "foo", "").content).toBe("b\n"); // first line
      expect(applyEdit("a\r\nfoo\r\nb\r\n", "foo", "").content).toBe("a\r\nb\r\n");
      expect(applyEdit("a\nx foo y\nb\n", "foo", "").content).toBe("a\nx  y\nb\n"); // inside a line
      expect(applyEdit("a\nfoo", "foo", "").content).toBe("a\n"); // last line, no line break after it
      expect(applyEdit("a\nfoo bar\n", "foo", "").content).toBe("a\n bar\n"); // starts a line, does not fill it
    });

    it("with replace_all removes every occurrence, and reports as many as it removed", () => {
      // Lines next to each other: every second one used to survive, with all reported as replaced.
      expect(applyEdit("a\nfoo\nfoo\nb\n", "foo", "", true)).toEqual({ content: "a\nb\n", replacements: 2 });
      expect(applyEdit("foo\nfoo\nfoo\n", "foo", "", true)).toEqual({ content: "", replacements: 3 });
      expect(applyEdit("foo\r\nfoo\r\nend\r\n", "foo", "", true)).toEqual({ content: "end\r\n", replacements: 2 });
      // Occurrences inside a longer line used to be left alone altogether.
      expect(applyEdit("foo\nx foo y\nfoo\n", "foo", "", true)).toEqual({ content: "x  y\n", replacements: 3 });
      expect(applyEdit("a foo b foo c", "foo", "", true)).toEqual({ content: "a  b  c", replacements: 2 });
    });

    it("leaves a line break alone when the next occurrence starts with it", () => {
      const result = applyEdit("\nx\nx", "\nx", "", true);
      expect(result).toEqual({ content: "", replacements: 2 });
    });
  });
});
