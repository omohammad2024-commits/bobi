/**
 * Text chunking (platform core): split long text into ≤maxLength chunks on
 * word/line boundaries. Pure and surface-agnostic — each surface (Telegram,
 * HTTP, …) picks its own limit and delegates here.
 */

/** Split text into ≤maxLength-char chunks on word/line boundaries. */
export function splitTextIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < maxLength / 2) cut = rest.lastIndexOf(" ", maxLength);
    if (cut < maxLength / 2) cut = maxLength;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
