const test = require("node:test");
const assert = require("node:assert/strict");
const { toCents, formatCents } = require("../src/money");

test("whole and simple amounts", () => {
  assert.equal(toCents(12), 1200);
  assert.equal(toCents(0.5), 50);
});

test("amounts that are not exact in binary", () => {
  assert.equal(toCents(0.29), 29);
  assert.equal(toCents(19.99), 1999);
});

test("formatting", () => {
  assert.equal(formatCents(1205), "12.05");
  assert.equal(formatCents(-7), "-0.07");
});
