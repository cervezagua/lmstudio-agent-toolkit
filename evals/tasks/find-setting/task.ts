import { numbersIn, type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "code",
  prompt: "How long does this tool wait before retrying a failed upload, and where is that set? Give me the file and the value.",
  async check({ answer }) {
    const problems: string[] = [];
    if (!/policy\.js/.test(answer)) problems.push("the answer does not name src/transfer/policy.js");
    if (!numbersIn(answer).includes("1250") && !/1\.25\s*s/.test(answer)) problems.push("the answer does not give 1250 ms");
    if (numbersIn(answer).includes("500") && !/unused|legacy|old/i.test(answer)) problems.push("the answer gives the unused 500 ms as the value");
    return problems;
  },
};

export default task;