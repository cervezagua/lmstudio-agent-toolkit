/** Dates are "YYYY-MM-DD" strings, compared as days in UTC. */
const day = text => Date.parse(`${text}T00:00:00Z`);

/** The date an invoice issued on `issued` is due, `days` days later. */
function dueDate(issued, days) {
  return new Date(day(issued) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whether an invoice due on `due` is overdue on `today`. Paying on the due date is on time. */
function isOverdue(due, today) {
  return day(today) >= day(due);
}

module.exports = { dueDate, isOverdue };
