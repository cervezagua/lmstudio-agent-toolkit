/** An amount in euros, as whole cents. */
function toCents(amount) {
  return Math.floor(amount * 100);
}

/** Cents as "12.34". */
function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

module.exports = { toCents, formatCents };
