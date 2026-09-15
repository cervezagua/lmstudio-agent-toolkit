import { ToolError } from "../shared/errors";

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string[] | string;
  metadata?: Record<string, unknown>;
  outputs?: any[];
  execution_count?: number | null;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

export function parseNotebook(text: string): Notebook {
  let notebook: Notebook;
  try {
    notebook = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`Not a valid .ipynb file (${(error as Error).message}).`);
  }
  if (!Array.isArray(notebook.cells)) throw new ToolError("Not a valid notebook: no cells array.");
  return notebook;
}

export const cellText = (cell: NotebookCell) => (Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? ""));

/** Notebooks store source as a list of lines, each keeping its trailing newline. */
export function toSourceLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line)).filter((line, i) => line !== "" || i === 0);
}

function outputSummary(cell: NotebookCell): string {
  const outputs = cell.outputs ?? [];
  if (outputs.length === 0) return "";
  const parts = outputs.map(output => {
    if (output.output_type === "stream") return `stream: ${[].concat(output.text ?? []).join("").slice(0, 300)}`;
    if (output.output_type === "error") return `error: ${output.ename}: ${output.evalue}`;
    const data = output.data ?? {};
    if (data["text/plain"]) return `result: ${[].concat(data["text/plain"]).join("").slice(0, 300)}`;
    return `${output.output_type}: ${Object.keys(data).join(", ") || "(no data)"}`;
  });
  return `\n  [outputs] ${parts.join(" | ")}`;
}

export function renderNotebook(notebook: Notebook, maxCellChars = 1500): string {
  if (notebook.cells.length === 0) return "(notebook has no cells)";
  return notebook.cells
    .map((cell, index) => {
      const text = cellText(cell);
      const body = text.length > maxCellChars ? text.slice(0, maxCellChars) + "\n… (cell truncated)" : text;
      return `[${index}] ${cell.cell_type}${outputSummary(cell)}\n${body}`;
    })
    .join("\n\n");
}

export type NotebookEditMode = "replace" | "insert" | "delete";

export function editNotebook(
  notebook: Notebook,
  options: { index: number; mode: NotebookEditMode; source?: string; cellType?: "code" | "markdown" | "raw" },
): { notebook: Notebook; message: string } {
  const { index, mode } = options;
  const count = notebook.cells.length;
  if (mode === "insert") {
    if (index < 0 || index > count) throw new ToolError(`insert index ${index} is out of range (0..${count}).`);
    if (options.source === undefined) throw new ToolError("source is required when inserting a cell.");
    const cell: NotebookCell = {
      cell_type: options.cellType ?? "code",
      source: toSourceLines(options.source),
      metadata: {},
      ...(options.cellType === "markdown" ? {} : { outputs: [], execution_count: null }),
    };
    notebook.cells.splice(index, 0, cell);
    return { notebook, message: `Inserted ${cell.cell_type} cell at index ${index} (now ${notebook.cells.length} cells).` };
  }

  if (index < 0 || index >= count) throw new ToolError(`cell index ${index} is out of range (0..${count - 1}).`);
  if (mode === "delete") {
    const [removed] = notebook.cells.splice(index, 1);
    return { notebook, message: `Deleted ${removed.cell_type} cell ${index} (now ${notebook.cells.length} cells).` };
  }

  const cell = notebook.cells[index];
  if (options.cellType && options.cellType !== cell.cell_type) {
    cell.cell_type = options.cellType;
    if (options.cellType === "markdown") {
      delete cell.outputs;
      delete cell.execution_count;
    } else {
      cell.outputs = [];
      cell.execution_count = null;
    }
  }
  if (options.source !== undefined) {
    cell.source = toSourceLines(options.source);
    if (cell.cell_type === "code") {
      cell.outputs = []; // stale outputs would mislead the reader
      cell.execution_count = null;
    }
  }
  return { notebook, message: `Replaced cell ${index} (${cell.cell_type}).` };
}
