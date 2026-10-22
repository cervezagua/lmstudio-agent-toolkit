const names = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai"];

module.exports = { customers: names.map((name, i) => ({ id: i + 1, name })) };
