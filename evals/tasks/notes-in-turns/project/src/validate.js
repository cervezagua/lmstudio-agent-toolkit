/** What is wrong with a note the client sent, as a list of messages. */
function validateNote(input) {
  const problems = [];
  if (typeof input?.title !== "string" || !input.title.trim()) problems.push("title is required");
  else if (input.title.length > 120) problems.push("title must be at most 120 characters");
  if (input?.body !== undefined && typeof input.body !== "string") problems.push("body must be text");
  return problems;
}

module.exports = { validateNote };
