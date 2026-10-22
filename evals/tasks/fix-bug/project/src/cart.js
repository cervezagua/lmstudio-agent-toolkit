const { roundMoney } = require("./money");

/** Adds up the lines of a cart: each line is { price, quantity }. */
function subtotal(lines) {
  return roundMoney(lines.reduce((sum, line) => sum + line.price * line.quantity, 0));
}

/** The discount for a coupon code, as a fraction of the subtotal. */
function discountRate(code) {
  const rates = { SAVE10: 0.1, SAVE25: 0.25 };
  return rates[code] ?? 0;
}

/** Subtotal, minus the coupon's discount, plus tax on what is left. */
function total(lines, { coupon, taxRate = 0 } = {}) {
  const afterDiscount = subtotal(lines) * (1 - discountRate(coupon));
  return roundMoney(afterDiscount * taxRate);
}

module.exports = { subtotal, discountRate, total };