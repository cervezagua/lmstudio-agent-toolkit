const { toCents, formatCents } = require("./money");
const { vatFor } = require("./tax");
const { dueDate } = require("./due");

/** Totals for an invoice: lines are { description, quantity, price } with price in euros. */
function buildInvoice({ country, issued, termsDays = 30, lines }) {
  const netCents = lines.reduce((sum, line) => sum + line.quantity * toCents(line.price), 0);
  const vatCents = vatFor(country, netCents);
  return {
    net: formatCents(netCents),
    vat: formatCents(vatCents),
    total: formatCents(netCents + vatCents),
    due: dueDate(issued, termsDays),
  };
}

module.exports = { buildInvoice };
