// Checkbox list for `omastoic config`. One gum choose per Stoic: bundled lines
// first, then lines the user added. gum is the control Omarchy's own setup
// form uses; the prefixes are the boxes.

export const CHECKED = "[x] ";
export const UNCHECKED = "[ ] ";

export type CheckQuote = { id: string; citation: string; text: string };

export function checkboxLabel(quote: CheckQuote): string {
  const text = quote.text.length > 48 ? `${quote.text.slice(0, 47)}…` : quote.text;
  return `${quote.id}  ${quote.citation}  ${text}`;
}

/** gum splits each `--selected` value on commas. A comma in a citation stays one item. */
export function escapeSelected(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

export function quoteCheckboxArgs(stoic: string, rows: { label: string; on: boolean }[]): string[] {
  const args = [
    "choose",
    "--no-limit",
    "--limit",
    String(rows.length + 1),
    "--height",
    String(Math.min(Math.max(rows.length, 1), 20)),
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
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const id = byLabel.get(line.trim());
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
