const test = require("node:test");
const assert = require("node:assert/strict");
const { vatFor } = require("../src/tax");

test("German VAT", () => {
  assert.equal(vatFor("DE", 10000), 1900);
});

test("Irish VAT rounds to the cent", () => {
  assert.equal(vatFor("IE", 1999), 460);
});

test("an unknown country is refused", () => {
  assert.throws(() => vatFor("XX", 100), /no VAT rate for XX/);
});
