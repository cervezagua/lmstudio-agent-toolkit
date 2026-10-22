/** Turns a title into a URL-friendly slug: "Hello, World!" -> "hello-world". */
function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Shortens text to at most `max` characters, ending with an ellipsis. */
function excerpt(text, max = 80) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = { toSlug, excerpt };