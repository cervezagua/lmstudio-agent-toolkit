import { execFileSync } from "node:child_process";
import { listFiles, read, run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

// The behaviour the five turns add up to, checked with code the model never sees.
const CHECK = `
const { NoteStore } = require("./src/store");
const { createNotesService } = require("./src/notes");
const out = [];
const expect = (ok, what) => { if (!ok) out.push(what); };
const s = createNotesService(new NoteStore());
const a = s.create({ title: "Plan", tags: ["Work", "urgent"] });
expect(a.status === 201, "a note with tags is not created: " + JSON.stringify(a.body));
s.create({ title: "Shop", tags: ["home"] });
s.create({ title: "Call", tags: ["WORK"] });
s.create({ title: "Untagged" });
const names = r => (r.body || []).map(n => n.title).sort().join(",");
expect(names(s.list({ tag: "work" })) === "Call,Plan", "tag=work gives " + names(s.list({ tag: "work" })));
expect(names(s.list({ tag: "Work" })) === "Call,Plan", "tag=Work gives " + names(s.list({ tag: "Work" })));
expect(names(s.list({ tag: "nothing" })) === "", "an unknown tag gives " + names(s.list({ tag: "nothing" })));
expect(names(s.list()) === "Call,Plan,Shop,Untagged", "no tag no longer lists every note: " + names(s.list()));
expect(s.create({ title: "Bad", tags: "work" }).status === 400, "tags that are not a list are accepted");
expect(s.create({ title: "Bad", tags: [42] }).status === 400, "a tag that is not text is accepted");
console.log(JSON.stringify(out));
`;

const task: EvalTask = {
  area: "long",
  maxRounds: 60,
  minutes: 25,
  prompt: "Have a look at this project and tell me in a few lines how it is organised.",
  followUps: [
    "Notes need tags: an optional list of strings on each note, saved and returned with it. Reject tags that aren't a list of strings.",
    "Now let me list only the notes with a given tag: list({ tag }) in the service, as GET /notes?tag=x would. Without a tag it lists them all, as now.",
    "One more thing: tags should not care about case, so 'Work' and 'work' are the same tag. Make that true everywhere tags are used.",
    "Finally, add tests for everything we did today and make sure the whole test suite passes.",
  ],
  async check({ dir, answers }) {
    const problems: string[] = [];
    if (!/store|validat/i.test(answers[0] ?? "")) problems.push("the first answer does not describe the project's parts");
    try {
      const wrong: string[] = JSON.parse(execFileSync(process.execPath, ["-e", CHECK], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 30_000 }));
      problems.push(...wrong);
    } catch (error: any) {
      problems.push(`the service fails to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    const tests = run(dir, process.execPath, ["test/run.js"]);
    if (tests.code !== 0) problems.push("the test suite fails");
    let tagTests = 0;
    for (const file of (await listFiles(dir)).filter(f => f.startsWith("test/") && f.endsWith(".test.js"))) {
      tagTests += ((await read(dir, file)) ?? "").match(/tag/gi)?.length ?? 0;
    }
    if (tagTests < 3) problems.push("there are no real tests for tags");
    return problems;
  },
};

export default task;
