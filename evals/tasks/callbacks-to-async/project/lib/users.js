const db = require("./db");

function createUser(name, callback) {
  if (typeof name !== "string" || !name.trim()) return setImmediate(() => callback(new Error("name is required")));
  db.put({ name: name.trim() }, callback);
}

function renameUser(id, name, callback) {
  db.get(id, (error, user) => {
    if (error) return callback(error);
    if (!user) return callback(new Error(`no user ${id}`));
    if (typeof name !== "string" || !name.trim()) return callback(new Error("name is required"));
    db.put({ ...user, name: name.trim() }, callback);
  });
}

module.exports = { createUser, renameUser };
