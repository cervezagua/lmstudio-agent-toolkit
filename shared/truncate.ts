/**
 * Caps `text` at roughly `maxChars`, keeping the head and the tail (the end of command output is
 * usually where errors are) with a marker saying how much was dropped.
 */
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const headLength = Math.floor(maxChars * 0.6);
  const tailLength = maxChars - headLength;
  const dropped = text.length - headLength - tailLength;
  return (
    text.slice(0, headLength) +
    `\n\n... [${dropped} characters truncated] ...\n\n` +
    text.slice(text.length - tailLength)
  );
}
