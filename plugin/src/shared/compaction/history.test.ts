import { describe, expect, it } from "vitest";
import { withoutThinking, type Msg } from "./history";

const assistant = (text: string): Msg => ({ role: "assistant", text, calls: [{ id: "c1", name: "read_file", args: {} }], results: [], n: 1, original: {} });

describe("withoutThinking", () => {
  it("drops the thinking before LM Studio's marker, or in a leading <think> block, and keeps the calls", () => {
    const marked = withoutThinking(assistant("Plan it.__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_ab12__Reading."));
    expect(marked).toMatchObject({ text: "Reading.", calls: [{ name: "read_file" }], original: undefined });
    expect(withoutThinking(assistant("<think>plan</think>\nDone.")).text).toBe("Done.");
    // Cut off while thinking: it was all thinking.
    expect(withoutThinking(assistant("<think>still planning")).text).toBe("");
  });

  // An answer about reasoning tags, or a parser for them, must not lose its own text.
  it("keeps an answer that mentions <think>, and leaves other messages alone", () => {
    const answer = assistant('Strip it with text.replace("<think>", "") and you are done.');
    expect(withoutThinking(answer)).toBe(answer);
    const user: Msg = { role: "user", text: "<think>not mine</think> hi", calls: [], results: [], n: 1 };
    expect(withoutThinking(user)).toBe(user);
  });
});
