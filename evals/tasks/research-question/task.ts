import { type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "web",
  config: { enableWeb: true, enableResearch: true, enableFiles: false, enableGit: false, enableMemory: false },
  prompt:
    "What caused the 2003 Northeast blackout in the US and Canada, according to the official investigation? " +
    "Look it up in a few sources and include links.",
  async check({ answer, calls }) {
    const problems: string[] = [];
    if (!/FirstEnergy/i.test(answer)) problems.push("the answer does not name FirstEnergy, whose failures the investigation blamed");
    if (!/tree|vegetation/i.test(answer)) problems.push("the answer leaves out the overgrown trees that tripped the lines");
    if (!/alarm|software|computer/i.test(answer)) problems.push("the answer leaves out the failed alarm system");
    if (!/https?:\/\/\S+/.test(answer)) problems.push("the answer has no links");
    if (!calls.some(c => /research|web_search|fetch_url|wikipedia/.test(c.name))) problems.push("nothing was looked up on the web");
    return problems;
  },
};

export default task;
