import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, git } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

const BEFORE = `const db = require("./db");

/** The orders of one customer, newest first. */
async function ordersFor(customerId) {
  return db.query("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC", [customerId]);
}

module.exports = { ordersFor };
`;

// The change under review adds a search with the user's text pasted into the SQL: an injection.
const AFTER = `${BEFORE.replace("module.exports = { ordersFor };", "")}/** Orders whose note mentions the given text. */
async function searchOrders(text) {
  return db.query("SELECT * FROM orders WHERE note LIKE '%" + text + "%'");
}

module.exports = { ordersFor, searchOrders };
`;

const task: EvalTask = {
  area: "code",
  config: { enableGit: true },
  prompt: "/review",
  async setup(dir) {
    await writeFile(join(dir, "orders.js"), BEFORE);
    await writeFile(join(dir, "db.js"), "module.exports = { query: async () => [] };\n");
    commitAll(dir, "Add orders");
    await writeFile(join(dir, "orders.js"), AFTER);
  },
  async check({ dir, answer }) {
    const problems: string[] = [];
    if (!/inject/i.test(answer)) problems.push("the review does not point out the SQL injection in searchOrders");
    if (!/searchOrders|orders\.js/i.test(answer)) problems.push("the review does not say where the problem is");
    const status = git(dir, "status", "--porcelain").output.trim();
    if (status !== "M orders.js") problems.push(`the review changed files: ${status.replace(/\n/g, ", ")}`);
    return problems;
  },
};

export default task;
