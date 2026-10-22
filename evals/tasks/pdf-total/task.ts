import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePdf } from "../../lib/files";
import { numbersIn, type EvalTask } from "../../lib/task";

const task: EvalTask = {
  area: "documents",
  config: { enableDocuments: true },
  prompt: "How much do we owe on the invoice in this folder, and by when?",
  async setup(dir) {
    await writeFile(
      join(dir, "invoice-2026-0417.pdf"),
      makePdf(
        [
          "Northwind Supplies Ltd",
          "INVOICE 2026-0417",
          "Issued: 3 September 2026",
          "Bill to: Example Bakery",
          "",
          "Item                         Qty   Price",
          "Flour, 25 kg sacks            40   31.50",
          "Sugar, 10 kg bags             25   14.20",
          "Delivery                       1  120.00",
        ],
        [
          "Subtotal                 1,735.00",
          "Discount (5%)              -86.75",
          "VAT (20%)                 329.65",
          "Total due                1,977.90 EUR",
          "",
          "Payment due by 3 October 2026.",
          "Late payments are charged 2% a month.",
        ],
      ),
    );
  },
  async check({ answer }) {
    const problems: string[] = [];
    if (!numbersIn(answer).includes("1977.90")) problems.push("the answer does not give the total due, 1,977.90");
    if (!/\b3\s*(rd)?\s*(of\s*)?Oct|Oct\w*\.?\s*3\b|2026-10-03|\b0?3[./]10[./]2026|10\/0?3\/2026/i.test(answer)) {
      problems.push("the answer does not give the due date, 3 October 2026");
    }
    return problems;
  },
};

export default task;
