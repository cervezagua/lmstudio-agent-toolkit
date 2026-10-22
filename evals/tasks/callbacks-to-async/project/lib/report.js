const db = require("./db");

function userCount(callback) {
  db.list((error, users) => {
    if (error) return callback(error);
    callback(null, users.length);
  });
}

function namesSorted(callback) {
  db.list((error, users) => {
    if (error) return callback(error);
    callback(
      null,
      users.map(u => u.name).sort((a, b) => a.localeCompare(b)),
    );
  });
}

module.exports = { userCount, namesSorted };
