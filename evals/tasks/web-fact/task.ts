import { numbersIn, type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "web",
  config: { enableWeb: true, enableFiles: false, enableGit: false, enableMemory: false },
  prompt: "Which SQLite version first added STRICT tables, and when was that version released? Include the link where you found it.",
  async check({ answer, calls }) {
    const problems: string[] = [];
    if (!numbersIn(answer).includes("3.37.0") && !/\b3\.37\b/.test(answer)) problems.push("the answer does not name SQLite 3.37.0");
    if (!/2021/.test(answer)) problems.push("the answer does not give 2021 as the release year");
    if (!/https?:\/\/\S+/.test(answer)) problems.push("the answer has no link");
    if (!calls.some(c => /web_search|fetch_url|research|wikipedia/.test(c.name))) problems.push("nothing was looked up on the web");
    return problems;
  },
};

export default task;
