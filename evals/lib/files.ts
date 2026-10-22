import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Runs a command in the project and returns its exit code and output, without throwing. */
export function run(dir: string, command: string, args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(command, args, { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
    return { code: 0, output };
  } catch (error: any) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

export const git = (dir: string, ...args: string[]) => run(dir, "git", args);

/** The line of a failed run's output that says what went wrong. */
export function firstError(output: string): string {
  const lines = output.trim().split("\n");
  return (lines.find(line => /^\s*\w*Error\b.*:/.test(line)) ?? lines[0] ?? "").trim();
}

/** Makes the folder a git repository with everything in it committed, as a fixed author. */
export function commitAll(dir: string, message: string): void {
  const env = ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "-c", "commit.gpgsign=false"];
  if (git(dir, "rev-parse", "--git-dir").code !== 0) git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  const result = git(dir, ...env, "commit", "-q", "-m", message);
  if (result.code !== 0) throw new Error(`git commit failed: ${result.output}`);
}

/** Every file in the project (outside .git), as relative paths with forward slashes. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .filter(path => !path.startsWith(".git/"));
}

export const read = (dir: string, path: string) => readFile(join(dir, path), "utf-8").catch(() => null);

/** A small PDF with real text, one string per page. Avoid apostrophes: they come back as ’. */
export function makePdf(...pageTexts: string[][]): Buffer {
  const pageIds = pageTexts.map((_, i) => 3 + i * 2);
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`];
  const fontId = 3 + pageTexts.length * 2;
  pageTexts.forEach((lines, i) => {
    const stream = lines.map((line, n) => `BT /F1 11 Tf 50 ${760 - n * 16} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
    objects[pageIds[i] - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageIds[i]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
