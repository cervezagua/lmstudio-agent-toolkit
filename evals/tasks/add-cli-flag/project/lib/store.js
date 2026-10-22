const { existsSync, readFileSync, writeFileSync } = require("node:fs");

function load(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : [];
}

function save(file, todos) {
  writeFileSync(file, JSON.stringify(todos, null, 2) + "\n");
}

module.exports = { load, save };
