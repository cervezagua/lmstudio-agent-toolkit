/** The todos as aligned lines: "[x]  2  Buy milk". */
function table(todos) {
  if (todos.length === 0) return "Nothing to do.";
  const width = String(Math.max(...todos.map(t => t.id))).length;
  return todos.map(t => `[${t.done ? "x" : " "}]  ${String(t.id).padStart(width)}  ${t.title}`).join("\n");
}

module.exports = { table };
