const { toSlug } = require("./strings");

/** The path a post is served at. */
function postPath(post) {
  return `/posts/${post.year}/${toSlug(post.title)}`;
}

module.exports = { postPath };