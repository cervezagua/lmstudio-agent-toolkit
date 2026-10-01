import { mkdir, mkdtemp, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractMessages, lmStudioHome, renderChatMatches, searchChats } from "./chatSearch";

// The shape LM Studio writes: a user message is one step, an assistant reply is several, and the
// context this plugin adds lives in `preprocessed`, beside the text the user actually typed.
const user = (text: string, preprocessed = text) => ({
  versions: [{ type: "singleStep", role: "user", content: [{ type: "text", text }], preprocessed: { role: "user", content: [{ type: "text", text: preprocessed }] } }],
  currentlySelected: 0,
});
const assistant = (answer: string, thinking = "", toolOutput = "") => ({
  versions: [
    {
      type: "multiStep",
      role: "assistant",
      steps: [
        { type: "contentBlock", style: { type: "thinking" }, content: [{ type: "text", text: thinking }] },
        { type: "contentBlock", content: [{ type: "toolCallRequest", name: "run_command" }, { type: "toolCallResult", content: toolOutput }] },
        { type: "contentBlock", content: [{ type: "text", text: answer }] },
        { type: "debugInfoBlock" },
      ],
    },
  ],
  currentlySelected: 0,
});

let home: string;
const chat = async (id: string, name: string, messages: unknown[], daysAgo = 0) => {
  const file = join(home, "conversations", `${id}.conversation.json`);
  await writeFile(file, JSON.stringify({ name, messages }));
  const when = new Date(Date.UTC(2026, 0, 20 - daysAgo));
  await utimes(file, when, when);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "chat-search-"));
  await mkdir(join(home, "conversations"));
  await chat("100", "Deploy notes", [
    user("How do we deploy the staging server?", "<context>secret context block about zebras</context>\n\nHow do we deploy the staging server?"),
    assistant("Run `make deploy-staging` from the release branch.", "The user wants zebras deployed", "zebra tool output"),
  ]);
  await chat("200", "Lunch", [user("Where should we eat?"), assistant("Try the noodle place.")], 3);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("searchChats", () => {
  it("finds what the user asked and what the assistant answered", async () => {
    const asked = await searchChats({ home, query: "deploy staging" });
    expect(asked.matches.map(m => m.role).sort()).toEqual(["assistant", "user"]);
    expect(asked.matches[0]).toMatchObject({ chat: "Deploy notes", date: "2026-01-20" });
    expect(renderChatMatches(asked)).toContain('"Deploy notes" (assistant): Run `make deploy-staging`');
  });

  it("does not search reasoning, tool output or the context this plugin added", async () => {
    expect((await searchChats({ home, query: "zebras" })).matches).toEqual([]);
    expect((await searchChats({ home, query: "zebra" })).matches).toEqual([]);
  });

  it("needs every word of the query in the same message", async () => {
    expect((await searchChats({ home, query: "deploy noodle" })).matches).toEqual([]);
  });

  it("leaves out the chat doing the searching", async () => {
    const result = await searchChats({ home, query: "deploy", excludeId: "100" });
    expect(result.matches).toEqual([]);
    expect(result.searched).toBe(1);
  });

  it("skips a file it cannot parse, and says how many chats it searched", async () => {
    await writeFile(join(home, "conversations", "300.conversation.json"), "{ not json");
    const result = await searchChats({ home, query: "nothing-matches-this" });
    expect(result.searched).toBe(2);
    expect(renderChatMatches(result)).toBe("No matches in 2 earlier chats.");
  });

  it("respects the limit and refuses an empty query", async () => {
    expect((await searchChats({ home, query: "deploy", limit: 1 })).matches).toHaveLength(1);
    await expect(searchChats({ home, query: " ? " })).rejects.toThrow(/at least one word/);
  });

  it("finds nothing, without failing, when there are no chats at all", async () => {
    expect(await searchChats({ home: join(home, "missing"), query: "deploy" })).toEqual({ matches: [], searched: 0 });
  });
});

describe("extractMessages", () => {
  it("tolerates shapes it does not recognise", () => {
    expect(extractMessages(null)).toEqual([]);
    expect(extractMessages({ messages: [{}, { versions: [] }, { versions: [{ role: "tool" }] }] })).toEqual([]);
  });
});

describe("lmStudioHome", () => {
  it("follows LM Studio's pointer file, and falls back to ~/.lmstudio", async () => {
    expect(lmStudioHome(home)).toBe(join(home, ".lmstudio"));
    await writeFile(join(home, ".lmstudio-home-pointer"), `${join(home, "conversations")}\n`);
    expect(lmStudioHome(home)).toBe(join(home, "conversations"));
    await writeFile(join(home, ".lmstudio-home-pointer"), join(home, "gone"));
    expect(lmStudioHome(home)).toBe(join(home, ".lmstudio"));
  });
});
