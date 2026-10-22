/** Rounds to whole cents. */
function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

module.exports = { roundMoney };