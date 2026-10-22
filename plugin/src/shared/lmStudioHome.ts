import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** LM Studio records where its data lives in ~/.lmstudio-home-pointer; ~/.lmstudio is the default. */
export function lmStudioHome(home = homedir()): string {
  try {
    const pointed = readFileSync(join(home, ".lmstudio-home-pointer"), "utf-8").trim();
    if (pointed && existsSync(pointed)) return pointed;
  } catch {
    // no pointer file: use the default
  }
  return join(home, ".lmstudio");
}
