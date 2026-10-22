const { buildInvoices } = require("./invoices");

async function main(month) {
  for (const invoice of await buildInvoices(month)) {
    console.log(`Would send invoice ${invoice.number} to ${invoice.email}`);
  }
}

main(process.argv[process.argv.indexOf("--month") + 1]);
