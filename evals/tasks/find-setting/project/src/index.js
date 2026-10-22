const { upload } = require("./transfer/upload");
const settings = require("./settings");

async function main(files) {
  for (const file of files) await upload(file, settings.server);
}

module.exports = { main };