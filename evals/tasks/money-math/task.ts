import { numbersIn, type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "utilities",
  config: { enableUtilities: true, enableFiles: false, enableGit: false },
  prompt:
    "Two quick sums. What is 17.5% of 2,348.20? And if I put 12,500 in an account paying 4.2% a year, " +
    "compounded yearly, how much is there after 7 years, to the cent?",
  async check({ answer }) {
    const problems: string[] = [];
    const numbers = numbersIn(answer);
    if (!numbers.some(n => n === "410.94" || n === "410.935")) problems.push("17.5% of 2,348.20 is not given as 410.94");
    const compound = (Math.round(12500 * 1.042 ** 7 * 100) / 100).toFixed(2);
    if (!numbers.includes(compound)) problems.push(`the compound amount is not given as ${compound}`);
    return problems;
  },
};

export default task;
