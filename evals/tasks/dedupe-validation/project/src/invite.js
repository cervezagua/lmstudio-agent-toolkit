/** Checks an invitation and returns the list of problems (empty when it is fine). */
function validateInvite(invite) {
  const problems = [];
  const email = (invite.email || "").trim().toLowerCase();
  if (!email) {
    problems.push("email is required");
  } else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) {
    problems.push("email is not valid");
  }
  if (!["member", "admin"].includes(invite.role)) problems.push("role must be member or admin");
  return problems;
}

module.exports = { validateInvite };
