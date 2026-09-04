export type Settings = { interval?: number; authors?: string[] };

export const DEFAULT_INTERVAL = 20;
export const MIN_INTERVAL = 1;
export const MAX_INTERVAL = 3600;

export function parseInterval(raw: string): number | null {
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) return null;
  return n;
}

/**
 * Slugs from a comma/space list. `all` or `*` means the whole roster (empty
 * array). Unknown slugs return null.
 */
export function parseAuthorList(raw: string, roster: string[]): string[] | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "all" || trimmed === "*") return [];
  const allowed = new Set(roster);
  const out: string[] = [];
  for (const slug of trimmed.split(/[,\s]+/).filter(Boolean)) {
    if (!allowed.has(slug)) return null;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Drop authors when the list is empty or the full roster — that is the default. */
export function compactSettings(settings: Settings, roster: string[]): Settings {
  const out: Settings = {};
  if (settings.interval != null) out.interval = settings.interval;
  const authors = settings.authors;
  if (authors?.length && !(authors.length === roster.length && roster.every((s) => authors.includes(s)))) {
    out.authors = authors;
  }
  return out;
}

export function describeSettings(settings: Settings, names: Map<string, { name: string }>): string {
  const seconds = settings.interval ?? DEFAULT_INTERVAL;
  const who = settings.authors?.length
    ? settings.authors.map((slug) => names.get(slug)?.name ?? slug).join(", ")
    : "all six";
  return `${who} · every ${seconds}s`;
}
