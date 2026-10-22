/** VAT by country, in percent. */
const VAT_PERCENT = { DE: 19, FR: 20, IE: 23, NL: 21 };

/** The VAT on a net amount in cents, rounded to the nearest cent. */
function vatFor(country, netCents) {
  const rate = VAT_PERCENT[country];
  if (rate === undefined) throw new Error(`no VAT rate for ${country}`);
  return Math.round(netCents * rate);
}

module.exports = { vatFor, VAT_PERCENT };
