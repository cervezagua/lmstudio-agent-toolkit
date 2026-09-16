import { describe, expect, it } from "vitest";
import { formatRunResult, runProcess } from "./process";
import { truncate } from "./truncate";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("keeps head and tail with a marker", () => {
    const text = "H".repeat(600) + "M".repeat(1000) + "T".repeat(400);
    const out = truncate(text, 1000);
    expect(out.startsWith("H".repeat(600))).toBe(true);
    expect(out.endsWith("T".repeat(400))).toBe(true);
    expect(out).toContain("[1000 characters truncated]");
  });
});

describe("runProcess", () => {
  it("captures output and exit code", async () => {
    const result = await runProcess(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
    });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(formatRunResult(result, 1000)).toBe("exit_code: 3\nstdout:\nout\nstderr:\nerr");
  });

  it("passes stdin to the process", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      stdin: "piped",
    });
    expect(result.stdout).toBe("piped");
  });

  it("survives a process that exits before its stdin is written", async () => {
    // Writing to a dead child's stdin raises EPIPE; that must not escape as an unhandled error.
    const result = await runProcess(process.execPath, ["-e", "process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      stdin: "x".repeat(200_000),
    });
    expect(result.exitCode).toBe(3);
  });

  it("kills processes that exceed the timeout", async () => {
    const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(formatRunResult(result, 1000)).toContain("[process timed out and was killed]");
  });

  it("stops processes when the abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });

  it("rejects when the executable does not exist", async () => {
    await expect(
      runProcess("definitely-not-a-real-binary-xyz", [], { cwd: process.cwd(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
