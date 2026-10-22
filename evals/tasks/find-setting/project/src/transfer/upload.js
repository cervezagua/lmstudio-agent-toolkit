const { withRetries } = require("./retry");

async function upload(file, server) {
  return withRetries(() => fetch(`${server}/upload`, { method: "POST", body: file }));
}

module.exports = { upload };