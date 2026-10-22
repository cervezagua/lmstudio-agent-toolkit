// Runs every *.test.js file in this folder.
const { readdirSync } = require("node:fs");

for (const file of readdirSync(__dirname).filter(f => f.endsWith(".test.js")).sort()) {
  require(`./${file}`);
  console.log(`ok ${file}`);
}
