import { describe, expect, it, vi } from "vitest";

// A machine whose only Python is 2.7: it refuses the -I the check passes.
vi.mock("../../../shared/process", async original => ({
  ...(await original<typeof import("../../../shared/process")>()),
  findPython: () => "/usr/bin/python",
  runProcess: async () => ({ exitCode: 2, stdout: "", stderr: "Unknown option: -I\nusage: /usr/bin/python [option] ...\n", timedOut: false, aborted: false }),
}));

const { quickCheck } = await import("./quickCheck");

describe("quickCheck with Python 2", () => {
  it("says nothing rather than calling every .py file broken", async () => {
    expect(await quickCheck("app.py", { cwd: "." })).toBeNull();
  });
});
