#!/usr/bin/env node
const { load, save } = require("../lib/store");
const { table } = require("../lib/format");

const [command, ...rest] = process.argv.slice(2);
const file = process.env.TODO_FILE || "todos.json";

switch (command) {
  case "list": {
    console.log(table(load(file)));
    break;
  }
  case "add": {
    const todos = load(file);
    todos.push({ id: todos.length + 1, title: rest.join(" "), done: false });
    save(file, todos);
    break;
  }
  case "done": {
    const todos = load(file);
    const todo = todos.find(t => t.id === Number(rest[0]));
    if (!todo) {
      console.error(`No todo ${rest[0]}`);
      process.exit(1);
    }
    todo.done = true;
    save(file, todos);
    break;
  }
  default:
    console.error("usage: todo list | add <title> | done <id>");
    process.exit(1);
}
