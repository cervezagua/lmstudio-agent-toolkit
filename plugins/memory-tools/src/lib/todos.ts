import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { ToolError } from "../shared/errors";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  content: string;
  status: TodoStatus;
}

/** Todos live in the chat's working directory, so each LM Studio chat has its own list. */
export function todoFile(workingDirectory: string) {
  return join(workingDirectory, ".memory-tools", "todos.json");
}

export async function readTodos(workingDirectory: string): Promise<Todo[]> {
  try {
    return JSON.parse(await readFile(todoFile(workingDirectory), "utf-8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function validateTodos(todos: Todo[]) {
  if (todos.some(t => !t.content.trim())) throw new ToolError("Every todo needs non-empty content.");
  const inProgress = todos.filter(t => t.status === "in_progress").length;
  if (inProgress > 1) {
    throw new ToolError(`Only one todo may be in_progress at a time (got ${inProgress}). Finish one first.`);
  }
}

export async function writeTodos(workingDirectory: string, todos: Todo[]) {
  validateTodos(todos);
  const file = todoFile(workingDirectory);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(todos, null, 2), "utf-8");
}

export function renderTodos(todos: Todo[]): string {
  if (todos.length === 0) return "No todos.";
  const mark: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
  const done = todos.filter(t => t.status === "completed").length;
  return `${todos.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join("\n")}\n(${done}/${todos.length} completed)`;
}
