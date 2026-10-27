// Checks LM Studio chats for replies that look stuck or broken: an approval with no buttons, a tool
// card left "calling tool", a reply cut off mid-sentence or made only of thinking.
//
// Usage: npm run chat-doctor -- [chat]
//   chat  a .conversation.json file, or a chat's working folder
//         (~/.lmstudio/working-directories/<id>); without one, the 5 latest chats are checked.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { checkChat } from "../plugin/src/shared/chatDoctor";
import { lmStudioHome } from "../plugin/src/shared/lmStudioHome";

const conversations = join(lmStudioHome(), "conversations");

async function allChats(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await allChats(path)));
    else if (entry.name.endsWith(".conversation.json")) found.push(path);
  }
  return found;
}

/** A chat file from what the user gave: the file itself, or the working folder named after the chat. */
async function chatFile(given: string): Promise<string> {
  const info = await stat(given).catch(() => null);
  if (info?.isFile()) return given;
  const id = basename(given.replace(/[\\/]+$/, ""));
  const match = (await allChats(conversations)).find(path => basename(path) === `${id}.conversation.json`);
  if (!match) throw new Error(`No LM Studio chat named ${id} in ${conversations}.`);
  return match;
}

async function main() {
  const given = process.argv[2];
  const files = given
    ? [await chatFile(given)]
    : (await Promise.all((await allChats(conversations)).map(async path => ({ path, at: (await stat(path)).mtimeMs }))))
        .sort((a, b) => b.at - a.at)
        .slice(0, 5)
        .map(chat => chat.path);

  let problems = 0;
  for (const file of files) {
    const conversation = JSON.parse(await readFile(file, "utf-8"));
    const findings = checkChat(conversation);
    console.log(`\n${conversation.name ?? basename(file)}  (${basename(file)}, ${conversation.messages?.length ?? 0} messages)`);
    if (findings.length === 0) console.log("  no problems found");
    for (const finding of findings) {
      console.log(`  ${finding.severity === "error" ? "✗" : "!"} message ${finding.message} [${finding.rule}] ${finding.detail}`);
    }
    problems += findings.filter(finding => finding.severity === "error").length;
  }
  process.exitCode = problems > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(error?.message ?? error);
  process.exitCode = 2;
});
