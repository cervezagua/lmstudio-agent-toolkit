import { realpath } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { ToolError } from "./errors";

/** Whether `target` is `root` itself or somewhere below it. Lexical: neither path is resolved. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  // On Windows, relative() across drives returns an absolute path.
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

/**
 * On Windows one file has several spellings: "name::$DATA" (an alternate data stream, here the main
 * one), "name." and "name " (the trailing dot or space is dropped), and an 8.3 short name such as
 * "AGENT-~1". A check that compares paths as text, like the one that protects the toolkit's own
 * files, is blind to all of them. The first three are refused outright, as no one names a file that
 * way on purpose; short names are expanded by comparing real paths (see `realpathOfNearestExisting`).
 */
function assertPlainWindowsPath(path: string): void {
  if (process.platform !== "win32") return;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  segments.forEach((segment, index) => {
    const drive = index === 0 && /^[A-Za-z]:$/.test(segment);
    if (!drive && segment.includes(":")) {
      throw new ToolError(`Path "${path}" contains ":", which on Windows names a hidden stream of a file, not a file.`);
    }
    if (segment !== "." && segment !== ".." && /[. ]$/.test(segment)) {
      throw new ToolError(`Path "${path}" has a name ending in a dot or a space, which Windows silently drops.`);
    }
  });
}

/** Lexically resolves `path` against `root`, throwing if the result escapes `root`. */
export function resolveInside(root: string, path: string): string {
  assertPlainWindowsPath(path);
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, path);
  if (!isInside(rootAbs, target)) {
    throw new ToolError(`Path "${path}" is outside the allowed root directory "${rootAbs}".`);
  }
  return target;
}

/**
 * Real path of `path`, or of its nearest existing ancestor joined with the missing tail. Links and
 * junctions are followed, and on Windows 8.3 short names are expanded to the long ones.
 */
export async function realpathOfNearestExisting(path: string): Promise<string> {
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
