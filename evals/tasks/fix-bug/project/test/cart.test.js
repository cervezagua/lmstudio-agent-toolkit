const assert = require("node:assert/strict");
const { subtotal, discountRate, total } = require("../src/cart");

const lines = [
  { price: 19.99, quantity: 2 },
  { price: 5.5, quantity: 3 },
];

assert.equal(subtotal(lines), 56.48);
assert.equal(discountRate("SAVE10"), 0.1);
assert.equal(discountRate("NOPE"), 0);
assert.equal(total(lines), 56.48);
assert.equal(total(lines, { coupon: "SAVE10" }), 50.83);
assert.equal(total(lines, { coupon: "SAVE10", taxRate: 0.2 }), 61);
console.log("all cart tests passed");