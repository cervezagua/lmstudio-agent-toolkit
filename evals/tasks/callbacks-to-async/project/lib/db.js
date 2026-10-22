// A tiny in-memory table that answers asynchronously, like a real database driver.
const rows = new Map();
let nextId = 1;

function put(record, callback) {
  setImmediate(() => {
    const id = record.id ?? nextId++;
    rows.set(id, { ...record, id });
    callback(null, rows.get(id));
  });
}

function get(id, callback) {
  setImmediate(() => callback(null, rows.get(id) ?? null));
}

function list(callback) {
  setImmediate(() => callback(null, [...rows.values()]));
}

function reset(callback) {
  setImmediate(() => {
    rows.clear();
    nextId = 1;
    callback(null);
  });
}

module.exports = { put, get, list, reset };
