const { validateNote } = require("./validate");

/** The service behind the notes API: each method answers one route. */
function createNotesService(store) {
  return {
    /** POST /notes */
    create(input) {
      const problems = validateNote(input);
      if (problems.length) return { status: 400, body: { problems } };
      const note = store.add({ title: input.title.trim(), body: input.body ?? "" });
      return { status: 201, body: note };
    },

    /** GET /notes */
    list() {
      return { status: 200, body: store.all() };
    },

    /** DELETE /notes/:id */
    remove(id) {
      return store.remove(Number(id)) ? { status: 204 } : { status: 404, body: { problems: ["no such note"] } };
    },
  };
}

module.exports = { createNotesService };
