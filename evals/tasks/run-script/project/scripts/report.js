// Prints the total value of the items that need reordering (stock below their minimum).
const { readFileSync } = require("node:fs");

const [, , file] = process.argv;
const rows = readFileSync(file, "utf-8").trim().split("\n").slice(1).map(line => line.split(","));
let value = 0;
for (const [, stock, minimum, price] of rows) {
  if (Number(stock) < Number(minimum)) value += (Number(minimum) - Number(stock)) * Number(price);
}
console.log(`Reorder value: ${value.toFixed(2)}`);