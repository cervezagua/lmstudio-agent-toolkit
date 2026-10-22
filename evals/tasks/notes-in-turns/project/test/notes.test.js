const assert = require("node:assert/strict");
const { NoteStore } = require("../src/store");
const { createNotesService } = require("../src/notes");

const service = createNotesService(new NoteStore());
assert.equal(service.create({ title: "  Groceries " }).body.title, "Groceries");
assert.equal(service.create({ title: "" }).status, 400);
assert.equal(service.list().body.length, 1);
assert.equal(service.remove(1).status, 204);
assert.equal(service.remove(1).status, 404);
