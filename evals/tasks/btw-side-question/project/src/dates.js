/** Days in a month (1-12) of a year that is not a leap year. */
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(month) {
  return DAYS[month - 1];
}

module.exports = { daysInMonth };
