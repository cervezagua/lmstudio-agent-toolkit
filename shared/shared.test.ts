import { describe, expect, it } from "vitest";
import { commandEnv, findExecutable, formatRunResult, runProcess } from "./process";
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

describe("commandEnv", () => {
  const withPathext = (value: string | undefined, run: () => void) => {
    const original = process.env.PATHEXT;
    if (value === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = value;
    try {
      run();
    } finally {
      if (original === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = original;
    }
  };

  it("keeps the host's PATHEXT when it has one", () => {
    withPathext(".EXE;.CMD", () => expect(commandEnv().PATHEXT).toBe(".EXE;.CMD"));
  });

  it.runIf(process.platform === "win32")("supplies one when the host has none", () => {
    withPathext(undefined, () => expect(commandEnv().PATHEXT).toBe(".COM;.EXE;.BAT;.CMD"));
    withPathext("   ", () => expect(commandEnv().PATHEXT).toBe(".COM;.EXE;.BAT;.CMD"));
  });

  it.runIf(process.platform !== "win32")("leaves PATHEXT alone off Windows", () => {
    withPathext(undefined, () => expect(commandEnv().PATHEXT).toBeUndefined());
  });

  it("passes extra variables through", () => {
    expect(commandEnv({ NO_COLOR: "1" }).NO_COLOR).toBe("1");
  });

  // The bug this exists for: LM Studio's plugin host gave us no PATHEXT, so PowerShell could not
  // turn "node" into "node.exe" and every run_command failed with "is not recognized".
  // Windows PowerShell can take many seconds to start on a cold CI runner, so this test gets its own
  // budget: longer than the runProcess timeout below, so a real hang is reported as our timeout with
  // its output rather than killed by the runner with nothing to show.
  it.runIf(process.platform === "win32")(
    "still resolves a bare command in PowerShell",
    async () => {
      const original = process.env.PATHEXT;
      delete process.env.PATHEXT;
      try {
        const result = await runProcess(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", "node --version"],
          { cwd: process.cwd(), timeoutMs: 45000 },
        );
        expect(result.timedOut).toBe(false);
        expect(result.stderr).not.toContain("is not recognized");
        expect(result.stdout.trim()).toMatch(/^v\d+\./);
      } finally {
        if (original !== undefined) process.env.PATHEXT = original;
      }
    },
    60000,
  );
});

describe("findExecutable", () => {
  // An empty PATHEXT used to leave the extension list empty, so every lookup reported "missing" and
  // git-tools silently hid its gh_* tools.
  it.runIf(process.platform === "win32")("finds a program when the host supplies an empty PATHEXT", () => {
    const original = process.env.PATHEXT;
    process.env.PATHEXT = "";
    try {
      expect(findExecutable("where")).toMatch(/where\.exe$/i);
    } finally {
      if (original === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = original;
    }
  });

  it("returns null for a program that is not installed", () => {
    expect(findExecutable("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});
