import { run } from "../../lib/files";
import { numbersIn, type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "shell",
  prompt: "Run this project's report and tell me the reorder value it prints.",
  async check({ dir, answer }) {
    const expected = /Reorder value: ([\d.]+)/.exec(run(dir, process.execPath, ["scripts/report.js", "data/stock.csv"]).output)?.[1];
    if (!expected) return ["the report script itself failed"];
    return numbersIn(answer).includes(expected) ? [] : [`the answer does not give ${expected}`];
  },
};

export default task;