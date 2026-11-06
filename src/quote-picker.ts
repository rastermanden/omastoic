// Checkbox list for `omastoic config`. One gum choose per Stoic: bundled lines
// first, then lines the user added. gum is the control Omarchy's own setup
// form uses; the prefixes are the boxes.

import { wrap } from "./canvas.ts";

export const CHECKED = "[x] ";
export const UNCHECKED = "[ ] ";

/** Splits gum's stdout when a wrapped quote contains newlines. */
export const OUTPUT_DELIMITER = "\x1e";

export type CheckQuote = { id: string; citation: string; text: string };

export function checkboxLabel(quote: CheckQuote, columns?: number): string {
  const lead = `${quote.id}  ${quote.citation}`;
  const single = `${lead}  ${quote.text}`;
  if (columns == null || columns < 16) return single;
  const leadWidth = Bun.stringWidth(lead) + 2;
  const padWidth = Math.min(leadWidth, Math.max(columns - 8, 2));
  const room = columns - padWidth;
  if (room < 8 || Bun.stringWidth(single) <= columns) return single;
  const lines = wrap(quote.text, room);
  const pad = " ".repeat(padWidth);
  return [`${lead}  ${lines[0]}`, ...lines.slice(1).map((line) => pad + line)].join("\n");
}

/** gum splits each `--selected` value on commas. A comma in a citation stays one item. */
export function escapeSelected(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

export function quoteCheckboxArgs(
  stoic: string,
  rows: { label: string; on: boolean }[],
  viewport?: { rows: number },
): string[] {
  const room = viewport?.rows ? Math.max(viewport.rows - 8, 6) : 20;
  const args = [
    "choose",
    "--no-limit",
    "--limit",
    String(rows.length + 1),
    "--height",
    String(Math.min(Math.max(rows.length, 1), room)),
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
  if (!output.trim()) return [];
  const chunks = output.includes(OUTPUT_DELIMITER) ? output.split(OUTPUT_DELIMITER) : output.split("\n");
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
