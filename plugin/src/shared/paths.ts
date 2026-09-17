import { realpath } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { ToolError } from "./errors";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  // On Windows, relative() across drives returns an absolute path.
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

/** Lexically resolves `path` against `root`, throwing if the result escapes `root`. */
export function resolveInside(root: string, path: string): string {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, path);
  if (!isInside(rootAbs, target)) {
    throw new ToolError(`Path "${path}" is outside the allowed root directory "${rootAbs}".`);
  }
  return target;
}

/** Real path of `path`, or of its nearest existing ancestor joined with the missing tail. */
async function realpathOfNearestExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    const realParent = await realpathOfNearestExisting(parent);
    return resolve(realParent, relative(parent, path));
  }
}

/**
 * Like `resolveInside`, but also follows symlinks/junctions so a link inside the root cannot be
 * used to reach files outside it.
 */
export async function resolveSafe(root: string, path: string): Promise<string> {
  const target = resolveInside(root, path);
  const [realRoot, realTarget] = await Promise.all([
    realpathOfNearestExisting(resolve(root)),
    realpathOfNearestExisting(target),
  ]);
  if (!isInside(realRoot, realTarget)) {
    throw new ToolError(`Path "${path}" resolves (via a link) outside the allowed root directory.`);
  }
  return target;
}

/** Path relative to root with forward slashes, for compact tool output. */
export function displayPath(root: string, path: string): string {
  const rel = relative(resolve(root), path);
  return (rel === "" ? "." : rel).split(sep).join("/");
}
