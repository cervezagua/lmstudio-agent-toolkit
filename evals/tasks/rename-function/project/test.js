const assert = require("node:assert/strict");
const strings = require("./lib/strings");
const { postPath } = require("./lib/routes");

assert.equal(strings.slugify("Hello, World!"), "hello-world");
assert.equal(strings.toSlug, undefined, "the old name should be gone");
assert.equal(postPath({ year: 2026, title: "Notes on Caching" }), "/posts/2026/notes-on-caching");
console.log("ok");