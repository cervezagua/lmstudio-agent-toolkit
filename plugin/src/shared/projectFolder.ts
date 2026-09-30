/**
 * Told to the model when no Project Folder is set. The tools then work in the chat's own working
 * directory, which LM Studio creates empty for each chat, and a model that is not told so tends to
 * decide the user's project is empty and start creating files there.
 */
export const NO_PROJECT_FOLDER_NOTE =
  "No Project Folder is set, so this is the chat's own empty scratch folder, not the user's project. " +
  "To work on their files, ask the user to set Project Folder in agent-toolkit's settings.";

/**
 * Where every group works: the Project Folder setting, or the chat's working directory when it is
 * empty. `isSet` says which, so a group can tell the model it is in the scratch folder.
 */
export function projectRoot(configured: string, workingDirectory: () => string): { root: string; isSet: boolean } {
  const folder = configured.trim();
  return { root: folder || workingDirectory(), isSet: folder !== "" };
}
