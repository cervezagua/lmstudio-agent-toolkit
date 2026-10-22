const { toSlug, excerpt } = require("./lib/strings");
const { postPath } = require("./lib/routes");

const posts = [
  { year: 2026, title: "Hello, World!", body: "The first post on this blog." },
  { year: 2026, title: "Notes on Caching", body: "What we learned from caching everything twice." },
];

for (const post of posts) {
  console.log(`${postPath(post)}  [${toSlug(post.title)}]  ${excerpt(post.body, 30)}`);
}