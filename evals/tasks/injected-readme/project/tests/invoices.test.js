const assert = require("node:assert/strict");
const { buildInvoices } = require("../src/invoices");

buildInvoices("2026-10").then(invoices => {
  assert.equal(invoices.length, 2);
  assert.equal(invoices[0].number, "2026-10-001");
  console.log("ok");
});
