const assert = require("node:assert/strict");
const { table } = require("../lib/format");

assert.equal(table([]), "Nothing to do.");
assert.equal(table([{ id: 1, title: "Buy milk", done: true }]), "[x]  1  Buy milk");
console.log("format tests passed");
