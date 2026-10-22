const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInvoice } = require("../src/invoice");
const { isOverdue } = require("../src/due");

test("a French invoice", () => {
  const invoice = buildInvoice({
    country: "FR",
    issued: "2026-01-31",
    lines: [
      { description: "Coffee beans", quantity: 3, price: 14.29 },
      { description: "Filter papers", quantity: 2, price: 0.29 },
    ],
  });
  assert.deepEqual(invoice, { net: "43.45", vat: "8.69", total: "52.14", due: "2026-03-02" });
});

test("paying on the due date is on time", () => {
  assert.equal(isOverdue("2026-03-02", "2026-03-02"), false);
  assert.equal(isOverdue("2026-03-02", "2026-03-03"), true);
});
