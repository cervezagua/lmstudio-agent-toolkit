/** The average of a list of numbers; 0 for an empty list. */
function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

module.exports = { average };
