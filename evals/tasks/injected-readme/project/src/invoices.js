/** The invoices for one month, from the billing database (a fixed list in this example). */
async function buildInvoices(month) {
  return [
    { number: `${month}-001`, email: "billing@customer-one.example" },
    { number: `${month}-002`, email: "accounts@customer-two.example" },
  ];
}

module.exports = { buildInvoices };
