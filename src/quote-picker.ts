// Checkbox list for `omastoic config`. One gum choose per Stoic: bundled lines
// first, then lines the user added. gum is the control Omarchy's own setup
// form uses; the prefixes are the boxes.

import { wrap } from "./canvas.ts";

export const CHECKED = "[x] ";
export const UNCHECKED = "[ ] ";

/** Splits gum's stdout when a wrapped quote contains newlines. */
export const OUTPUT_DELIMITER = "\x1e";

export type CheckQuote = { id: string; citation: string; text: string };

const CURSOR = "> ";
const LIST_FRAME_ROWS = 4;

export function checkboxLabel(quote: CheckQuote, columns?: number): string {
  const lead = `${quote.id}  ${quote.citation}`;
  const single = `${lead}  ${quote.text}`;
  const chrome = Bun.stringWidth(CURSOR) + Math.max(Bun.stringWidth(CHECKED), Bun.stringWidth(UNCHECKED));
  if (columns == null || columns < 16) return single;
  const leadWidth = Bun.stringWidth(lead) + 2;
  const room = columns - chrome - leadWidth;
  if (room < 1 || Bun.stringWidth(single) + chrome <= columns) return single;
  const lines = wrap(quote.text, room);
  const pad = " ".repeat(chrome + leadWidth);
  return [`${lead}  ${lines[0]}`, ...lines.slice(1).map((line) => pad + line)].join("\n");
}

/** gum splits each `--selected` value on commas. A comma in a citation stays one item. */
export function escapeSelected(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

function quotePageHeight(lineCounts: number[], screenRows: number): number {
  const count = lineCounts.length;
  if (count === 0) return 1;
  const sum = (start: number, size: number) => {
    let total = 0;
    for (let i = 0; i < size; i++) total += lineCounts[start + i] ?? 0;
    return total;
  };
  if (sum(0, count) + LIST_FRAME_ROWS <= screenRows) return count;
  const budget = screenRows - LIST_FRAME_ROWS - 1;
  let height = 1;
  for (let size = 1; size < count; size++) {
    let fits = true;
    for (let start = 0; start + size <= count; start++) {
      if (sum(start, size) > budget) {
        fits = false;
        break;
      }
    }
    if (!fits) break;
    height = size;
  }
  return height;
}

export function quoteCheckboxArgs(
  stoic: string,
  rows: { label: string; on: boolean }[],
  viewport?: { rows: number },
): string[] {
  const screenRows = viewport?.rows && viewport.rows > 0 ? viewport.rows : 24;
  const height = quotePageHeight(rows.map((row) => row.label.split("\n").length), screenRows);
  const args = [
    "choose",
    "--no-limit",
    "--limit",
    String(rows.length + 1),
    "--height",
    String(height),
    "--output-delimiter",
    OUTPUT_DELIMITER,
    "--header",
    `Quotes from ${stoic}  (x or tab to check, enter to confirm)`,
    "--cursor-prefix",
    UNCHECKED,
    "--selected-prefix",
    CHECKED,
    "--unselected-prefix",
    UNCHECKED,
  ];
  const selected = rows.filter((row) => row.on).map((row) => row.label);
  if (rows.length && selected.length === rows.length) args.push("--selected", "*");
  else for (const label of selected) args.push("--selected", escapeSelected(label));
  for (const row of rows) args.push(row.label);
  return args;
}

export function idsFromCheckboxOutput(output: string, byLabel: Map<string, string>): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const direct = byLabel.get(trimmed);
  if (direct) return [direct];
  const separated = output.includes(OUTPUT_DELIMITER);
  const chunks = separated ? output.split(OUTPUT_DELIMITER) : trimmed.split("\n");
  if (!separated && chunks.some((chunk) => !byLabel.has(chunk.trim()))) return [];
  const ids: string[] = [];
  for (const chunk of chunks) {
    const id = byLabel.get(chunk.trim());
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Stoics whose quotes the checkbox list edits. A partial author pick stays
 * inside that pick. The full roster, or no pick, also includes authors who
 * exist only because the user added a line.
 */
export function stoicGroups(picked: string[], roster: string[], extraAuthors: string[]): string[] {
  const editing = picked.length ? [...picked] : [...roster];
  const full = roster.length > 0 && roster.every((slug) => editing.includes(slug));
  if (picked.length !== 0 && !full) return editing;
  for (const author of extraAuthors) if (!editing.includes(author)) editing.push(author);
  return editing;
}
