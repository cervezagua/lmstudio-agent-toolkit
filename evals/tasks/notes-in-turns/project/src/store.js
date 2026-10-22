/** Keeps notes in memory. A note is { id, title, body, createdAt }. */
class NoteStore {
  constructor() {
    this.notes = [];
    this.nextId = 1;
  }

  add(note) {
    const saved = { ...note, id: this.nextId++, createdAt: new Date().toISOString() };
    this.notes.push(saved);
    return saved;
  }

  all() {
    return [...this.notes];
  }

  remove(id) {
    const before = this.notes.length;
    this.notes = this.notes.filter(note => note.id !== id);
    return this.notes.length < before;
  }
}

module.exports = { NoteStore };
