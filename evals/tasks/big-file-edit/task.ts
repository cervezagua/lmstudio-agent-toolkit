import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type EvalTask } from "../../lib/task";

const PATH = "src/generated/messages.js";

/** About 450 KB: too big to read at once, so the model has to find the line and read around it. */
function messages(welcome: string): string {
  const lines = ["// Generated from the translation sheet. Edit with care.", "module.exports = {"];
  for (let i = 1; i <= 6000; i++) {
    if (i === 3712) lines.push(`  welcome_title: "${welcome}",`);
    lines.push(`  message_${String(i).padStart(5, "0")}: "Message number ${i} of the catalogue, shown in screen ${i % 40}.",`);
  }
  lines.push("};", "");
  return lines.join("\n");
}

const task: EvalTask = {
  area: "code",
  prompt: `The welcome_title message in ${PATH} has a typo: it says "Welcom to the app". Fix it.`,
  async setup(dir) {
    await mkdir(join(dir, "src", "generated"), { recursive: true });
    await writeFile(join(dir, PATH), messages("Welcom to the app"));
  },
  async check({ dir }) {
    const now = await readFile(join(dir, PATH), "utf-8").catch(() => "");
    if (now === messages("Welcome to the app")) return [];
    if (now.includes('welcome_title: "Welcome to the app"')) return ["the typo is fixed, but other lines changed too"];
    return ["the typo is not fixed"];
  },
};

export default task;