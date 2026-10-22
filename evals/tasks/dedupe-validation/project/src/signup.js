/** Checks a sign-up form and returns the list of problems (empty when it is fine). */
function validateSignup(form) {
  const problems = [];
  const email = (form.email || "").trim().toLowerCase();
  if (!email) {
    problems.push("email is required");
  } else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) {
    problems.push("email is not valid");
  }
  if (!form.password || form.password.length < 10) problems.push("password must be at least 10 characters");
  return problems;
}

module.exports = { validateSignup };
