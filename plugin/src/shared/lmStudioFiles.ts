import { homedir } from "os";
import { join, resolve } from "path";
import { lmStudioHome } from "./lmStudioHome";
import { isInside, realpathOfNearestExisting } from "./paths";

/**
 * Whether a path is one of LM Studio's own files, which no tool may change: its settings (where
 * "Always allow" lives, so a model writing them could switch approval off), credentials, installed
 * plugins and chats, and the pointer file that says where all of that is. The folders chats work in
 * are the exception: a chat without a Project Folder works inside one.
 */
export async function isLmStudioFile(file: string, home = homedir()): Promise<boolean> {
  const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const [target, lmStudio, userHome] = await Promise.all([
    realpathOfNearestExisting(resolve(file)),
    realpathOfNearestExisting(resolve(lmStudioHome(home))),
    realpathOfNearestExisting(resolve(home)),
  ]);
  if (fold(target) === fold(join(userHome, ".lmstudio-home-pointer"))) return true;
  if (!isInside(fold(lmStudio), fold(target))) return false;
  return !isInside(fold(join(lmStudio, "working-directories")), fold(target));
}
