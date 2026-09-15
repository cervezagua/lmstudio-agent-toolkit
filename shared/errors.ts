/**
 * An error the model can recover from (bad path, non-unique edit, ...). Tools catch these and
 * return the message as a string so the model sees it and can retry, per the SDK's guidance.
 */
export class ToolError extends Error {}

type Implementation<P, R> = (params: P, ...rest: any[]) => Promise<R> | R;

/** Wraps a tool implementation so `ToolError`s become `"Error: ..."` strings for the model. */
export function safe<P, R>(fn: Implementation<P, R>): Implementation<P, R | string> {
  return async (params, ...rest) => {
    try {
      return await fn(params, ...rest);
    } catch (error) {
      if (error instanceof ToolError) return `Error: ${error.message}`;
      if (error instanceof Error && "code" in error) {
        // Node fs errors (ENOENT, EISDIR, EACCES, ...) are recoverable from the model's view.
        return `Error: ${error.message}`;
      }
      throw error;
    }
  };
}
