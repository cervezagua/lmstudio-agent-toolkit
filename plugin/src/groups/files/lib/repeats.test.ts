import { describe, expect, it } from "vitest";
import { CommandRepeats, commandRepeatsFor, REPEAT_LIMIT } from "./repeats";

describe("CommandRepeats", () => {
  it("refuses a command only after it gave the same result REPEAT_LIMIT times in a row", () => {
    const repeats = new CommandRepeats();
    for (let i = 1; i <= REPEAT_LIMIT; i++) {
      expect(repeats.refusal("cmd")).toBeNull();
      expect(repeats.record("cmd", "same")).toBe(i);
    }
    expect(repeats.refusal("cmd")).toMatch(/already ran this exact command 3 times in a row/);
    expect(repeats.refusal("other")).toBeNull();
  });

  it("starts over on a different result, a different command, or a file change", () => {
    const repeats = new CommandRepeats();
    repeats.record("cmd", "a");
    repeats.record("cmd", "a");
    expect(repeats.record("cmd", "b")).toBe(1); // the output moved on: polling that got somewhere
    repeats.record("cmd", "b");
    expect(repeats.record("other", "b")).toBe(1);
    repeats.record("cmd", "b");
    repeats.record("cmd", "b");
    repeats.changed(); // an edit, so rerunning the tests is fair
    expect(repeats.refusal("cmd")).toBeNull();
    expect(repeats.record("cmd", "b")).toBe(1);
  });

  it("keeps a count per chat", () => {
    expect(commandRepeatsFor("chat-a")).toBe(commandRepeatsFor("chat-a"));
    expect(commandRepeatsFor("chat-a")).not.toBe(commandRepeatsFor("chat-b"));
  });
});
