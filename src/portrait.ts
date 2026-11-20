/** A small braille crop for the settings preview. Display cells, not a palette. */
export function portraitCrop(art: string, rows: number, cols: number): string {
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) return "";
  const raw = art.replace(/\n+$/, "").split("\n");
  let top = 0;
  let bottom = raw.length - 1;
  while (top <= bottom && raw[top].trim() === "") top++;
  while (bottom >= top && raw[bottom].trim() === "") bottom--;
  const body = raw.slice(top, bottom + 1);
  if (!body.length) return "";
  let left = Number.POSITIVE_INFINITY;
  let right = 0;
  for (const line of body) {
    const start = line.search(/\S/);
    if (start < 0) continue;
    left = Math.min(left, start);
    right = Math.max(right, line.trimEnd().length);
  }
  if (!Number.isFinite(left)) return "";
  const startCol = left + Math.max(0, Math.floor((right - left - cols) / 2));
  const startRow = Math.max(0, Math.floor((body.length - rows) / 2));
  return body
    .slice(startRow, startRow + rows)
    .map((line) => line.slice(startCol, startCol + cols).trimEnd())
    .join("\n");
}
