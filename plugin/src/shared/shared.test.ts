import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { isChatStateFile } from "./mode";
import { projectRoot } from "./projectFolder";
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

// An app started from the macOS Dock gets launchd's PATH, without Homebrew's folders. These run only
// on macOS, and recreate that PATH deliberately: a CI shell already has Homebrew on it, so it cannot
// show the problem by itself.
describe("macOS PATH", () => {
  const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  const brewDir = ["/opt/homebrew/bin", "/usr/local/bin"].find(dir => existsSync(join(dir, "brew")));
  const pathOf = (env: NodeJS.ProcessEnv) => Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];

  const withPath = <T>(path: string, run: () => T): T => {
    const original = process.env.PATH;
    process.env.PATH = path;
    try {
      return run();
    } finally {
      process.env.PATH = original;
    }
  };

  it.runIf(process.platform === "darwin" && brewDir !== undefined)("puts Homebrew back on launchd's PATH", () => {
    withPath(LAUNCHD_PATH, () => {
      const path = pathOf(commandEnv())!.split(":");
      expect(path).toContain(brewDir);
      // What the host gave stays, in its order, after the added folders.
      expect(path.slice(-4)).toEqual(LAUNCHD_PATH.split(":"));
      expect(findExecutable("brew")).toBe(join(brewDir!, "brew"));
    });
  });

  it.runIf(process.platform === "darwin")("does not add a folder that is already there", () => {
    // Every folder the repair knows about, so there is nothing left for it to add.
    const full = `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${LAUNCHD_PATH}`;
    withPath(full, () => expect(pathOf(commandEnv())).toBe(full));
  });

  it.runIf(process.platform !== "darwin")("leaves PATH alone elsewhere", () => {
    expect(pathOf(commandEnv())).toBe(process.env.PATH);
  });
});

describe("isChatStateFile", () => {
  const dir = join(tmpdir(), "chat");

  it("recognises the mode file", () => {
    expect(isChatStateFile(dir, join(dir, ".agent-mode.json"))).toBe(true);
    expect(isChatStateFile(dir, join(dir, "notes.json"))).toBe(false);
  });

  // Windows and macOS ignore case by default, so a differently-cased name is the same file there.
  it.runIf(process.platform === "win32" || process.platform === "darwin")("ignores case where the filesystem does", () => {
    expect(isChatStateFile(dir, join(dir, ".Agent-Mode.JSON"))).toBe(true);
  });
});

describe("projectRoot", () => {
  it("uses the Project Folder when it is set, and the chat's working directory when it is not", () => {
    expect(projectRoot("  D:/work/app  ", () => "chat-dir")).toEqual({ root: "D:/work/app", isSet: true });
    expect(projectRoot("   ", () => "chat-dir")).toEqual({ root: "chat-dir", isSet: false });
  });

  it("does not ask for the working directory when a folder is set", () => {
    // Outside a chat there is none, and asking throws.
    expect(() => projectRoot("D:/work/app", () => { throw new Error("no chat"); })).not.toThrow();
  });
});
