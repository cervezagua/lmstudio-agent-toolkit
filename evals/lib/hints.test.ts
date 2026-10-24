import { describe, expect, it } from "vitest";
import { errorKind, errorStats, type TracedCall } from "./hints";

const ok = (name: string): TracedCall => ({ name, args: "{}", result: "done" });
const err = (name: string, result: string): TracedCall => ({ name, args: "{}", result: `Error: ${result}`, failed: true });

describe("errorKind", () => {
  it("tells the hinted errors from the plain ones", () => {
    expect(errorKind("Error: old_string was not found in the file. The closest text is at lines 3-4:")).toBe("edit missed, closest text shown");
    expect(errorKind("Error: old_string was not found in the file. Read the file again and copy the text exactly")).toBe("edit missed, no close text");
    expect(errorKind("Error: a.js does not exist. Did you mean: src/a.js?")).toBe("path missing, likely one suggested");
    expect(errorKind("Error: a.js does not exist.")).toBe("path missing, nothing suggested");
    expect(errorKind("Error: HTTP 403")).toBe("other error");
  });
});

describe("errorStats", () => {
  it("counts whether the next try with the same tool worked, and how long recovery took", () => {
    const closest = "old_string was not found in the file. The closest text is at line 2:";
    const stats = errorStats([
      [err("edit_file", closest), ok("edit_file")],
      [err("edit_file", closest), ok("read_file"), err("edit_file", closest), ok("edit_file")],
      [err("edit_file", closest), ok("read_file")],
    ]);
    expect(stats).toEqual([
      { kind: "edit missed, closest text shown", seen: 4, nextTryWorked: 2, callsToSuccess: [1, 3, 1], neverRecovered: 1 },
    ]);
  });
});
