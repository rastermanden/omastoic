import { canonicalQuoteId, type BundledQuote, type Quote } from "./canvas.ts";

export type QuoteChoice = { id: string; author: string };
export type Settings = {
  interval?: number;
  authors?: string[];
  /** Quote ids kept for that Stoic. A missing author means every bundled and custom line. */
  quotes?: Record<string, string[]>;
  /** Only your own quotes rotate; no Stoic's book. */
  mineOnly?: boolean;
};

export const DEFAULT_INTERVAL = 60;

/**
 * A per-author allow-list. `null` means the field is malformed and must be
 * ignored. A Stoic whose list is the whole bundled set, with no custom id, is
 * omitted.
 */
function quoteAllowList(
  raw: unknown,
  roster: string[],
  catalog: QuoteChoice[],
  dropUnknownCustom = true,
): Record<string, string[]> | undefined | null {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const [author, ids] of Object.entries(record)) {
    if (!roster.includes(author) || !Array.isArray(ids)) return null;
    if (!ids.every((id) => {
      const canonical = typeof id === "string" ? canonicalQuoteId(id) : null;
      return !!canonical && (catalog.length === 0 || canonical.startsWith("c") || catalog.some((row) => row.author === author && row.id === canonical));
    })) return null;
  }
  if (!catalog.length) {
    const trusted: Record<string, string[]> = {};
    for (const author of roster) {
      if (!Object.hasOwn(record, author)) continue;
      trusted[author] = [...new Set((record[author] as string[]).map((id) => canonicalQuoteId(id)!))];
    }
    return Object.keys(trusted).length ? trusted : undefined;
  }
  const quotes: Record<string, string[]> = {};
  for (const author of roster) {
    if (!Object.hasOwn(record, author)) continue;
    const seen: string[] = [];
    for (const id of record[author] as string[]) {
      const canonical = canonicalQuoteId(id)!;
      if (!seen.includes(canonical)) seen.push(canonical);
    }
    const known = catalog.filter((row) => row.author === author).map((row) => row.id);
    const wanted = seen.filter((id) => !id.startsWith("c") || id === "c00" || !dropUnknownCustom || known.includes(id));
    if (seen.some((id) => id.startsWith("c")) && !wanted.some((id) => id.startsWith("c"))) wanted.push("c00");
    const ordered = known.filter((id) => wanted.includes(id));
    const extra = wanted.filter((id) => id.startsWith("c") && id !== "c00" && !known.includes(id));
    if (wanted.includes("c00")) quotes[author] = [...ordered, ...extra, "c00"];
    else if (extra.length || ordered.length !== known.length) quotes[author] = [...ordered, ...extra];
  }
  return Object.keys(quotes).length ? quotes : undefined;
}

/** Treat hand-edited JSON as untrusted input, just like CLI arguments. */
export function normalizeSettings(
  raw: unknown,
  roster: string[],
  catalog: QuoteChoice[] = [],
  dropUnknownCustom = true,
): Settings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const result: Settings = {};
  if (typeof value.interval === "number" && parseInterval(String(value.interval)) != null) result.interval = value.interval;
  if (Array.isArray(value.authors) && value.authors.every((a) => typeof a === "string" && roster.includes(a))) {
    result.authors = [...new Set(value.authors)];
  }
  if (Object.hasOwn(value, "quotes")) {
    const quotes = quoteAllowList(value.quotes, roster, catalog, dropUnknownCustom);
    if (quotes) result.quotes = quotes;
  }
  if (value.mineOnly === true) result.mineOnly = true;
  return result;
}
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

export type QuoteFlag = { kind: "reset" } | { kind: "author"; author: string; ids: string[] | "all" };

/** One `--quotes` value: `all`, `slug=all`, `slug=none`, or `slug=q01,q02`. */
export function parseQuoteFlag(raw: string): QuoteFlag | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "all") return { kind: "reset" };
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const author = trimmed.slice(0, eq).trim();
  const rest = trimmed.slice(eq + 1).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(author)) return null;
  if (rest === "all") return { kind: "author", author, ids: "all" };
  if (rest === "none") return { kind: "author", author, ids: [] };
  const ids: string[] = [];
  for (const part of rest.split(/[,\s]+/).filter(Boolean)) {
    const id = canonicalQuoteId(part);
    if (!id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length ? { kind: "author", author, ids } : null;
}

export function applyQuoteFlags(
  current: Record<string, string[]> | undefined,
  flags: string[],
  roster: string[],
  catalog: QuoteChoice[],
  dropUnknownCustom = true,
): { ok: true; quotes?: Record<string, string[]> } | { ok: false; error: string } {
  let quotes = current ? Object.fromEntries(Object.entries(current).map(([author, ids]) => [author, [...ids]])) : undefined;
  for (const flag of flags) {
    const parsed = parseQuoteFlag(flag);
    if (!parsed) return { ok: false, error: "--quotes expects all, or slug=q01,q02, slug=all, slug=none" };
    if (parsed.kind === "reset") {
      quotes = undefined;
      continue;
    }
    if (!roster.includes(parsed.author)) return { ok: false, error: `unknown author — try: ${roster.join(", ")} (or all)` };
    if (parsed.ids === "all") {
      if (quotes) {
        delete quotes[parsed.author];
        if (!Object.keys(quotes).length) quotes = undefined;
      }
      continue;
    }
    const known = catalog.filter((row) => row.author === parsed.author);
    const unknown = parsed.ids.find((id) => !known.some((row) => row.id === id));
    if (unknown) return { ok: false, error: `unknown quote ${unknown} for ${parsed.author} — omastoic config --list` };
    const nextIds = known.filter((row) => parsed.ids.includes(row.id)).map((row) => row.id);
    if (!dropUnknownCustom) {
      for (const id of quotes?.[parsed.author] ?? []) {
        if (id.startsWith("c") && !nextIds.includes(id)) nextIds.push(id);
      }
    }
    quotes = { ...(quotes ?? {}), [parsed.author]: nextIds };
  }
  return { ok: true, quotes: quoteAllowList(quotes ?? {}, roster, catalog, dropUnknownCustom) ?? undefined };
}

/** Drop authors when the list is empty or the full roster — that is the default. */
export function compactSettings(
  settings: Settings,
  roster: string[],
  catalog: QuoteChoice[] = [],
  dropUnknownCustom = true,
): Settings {
  const out: Settings = {};
  if (settings.interval != null) out.interval = settings.interval;
  const authors = settings.authors;
  if (authors?.length && !(authors.length === roster.length && roster.every((s) => authors.includes(s)))) {
    out.authors = authors;
  }
  if (settings.quotes) {
    const quotes = quoteAllowList(settings.quotes, roster, catalog, dropUnknownCustom);
    if (quotes) out.quotes = quotes;
  }
  if (settings.mineOnly) out.mineOnly = true;
  return out;
}

/**
 * A bundled-only allow-list still keeps every custom line. `c00`, or any other
 * `c` id, means the custom selection was saved and only listed custom ids stay.
 */
export function quoteKept(id: string, ids: string[] | undefined): boolean {
  if (ids == null) return true;
  if (id.startsWith("c") && !ids.some((kept) => kept.startsWith("c"))) return true;
  return ids.includes(id);
}

/**
 * Bundled lines kept by a per-author allow-list, plus custom lines from
 * `quoteKept`. An allow-list that matches nothing is ignored and the author
 * list is applied to the bundled book. An author list that matches nothing
 * falls back to the bundled book plus custom lines still kept. Explicitly
 * cleared custom lines stay out of both. Custom lines by an author outside the
 * bundled book pass the author list.
 */
export function inRotation(
  bundled: BundledQuote[],
  custom: Array<Quote & { id?: string }>,
  settings: Settings,
): { quotes: Quote[]; ignoredSelection: boolean; ignoredAuthors: boolean } {
  const keptCustom = custom.filter((quote) => !quote.id || quoteKept(quote.id, settings.quotes?.[quote.author]));
  const picked = [
    ...bundled.filter((quote) => quoteKept(quote.id, settings.quotes?.[quote.author])),
    ...keptCustom,
  ];
  // Mine only: your own kept lines, or the whole book when none are left.
  if (settings.mineOnly) {
    return keptCustom.length
      ? { quotes: keptCustom, ignoredSelection: false, ignoredAuthors: false }
      : { quotes: [...bundled], ignoredSelection: false, ignoredAuthors: true };
  }
  const ignoredSelection = picked.length === 0 && bundled.length + custom.length > 0;
  const pool = ignoredSelection ? [...bundled, ...keptCustom] : picked;
  if (!settings.authors?.length) return { quotes: pool, ignoredSelection, ignoredAuthors: false };
  // Your own lines follow their own switch, never the Stoic picks.
  const mine = new Set<Quote>(keptCustom);
  const wanted = new Set(settings.authors);
  const filtered = pool.filter((quote) => wanted.has(quote.author) || mine.has(quote));
  if (filtered.some((quote) => !mine.has(quote))) return { quotes: filtered, ignoredSelection, ignoredAuthors: false };
  return { quotes: [...bundled, ...keptCustom], ignoredSelection, ignoredAuthors: true };
}

export function describeSettings(settings: Settings, names: Map<string, { name: string }>, catalog: QuoteChoice[] = []): string {
  const seconds = settings.interval ?? DEFAULT_INTERVAL;
  if (settings.mineOnly) {
    const mine = catalog.filter((row) => row.id.startsWith("c"));
    const kept = mine.filter((row) => quoteKept(row.id, settings.quotes?.[row.author])).length;
    return `your own quotes only · ${kept} of ${mine.length} quotes · every ${seconds}s`;
  }
  const who = settings.authors?.length
    ? settings.authors.map((slug) => names.get(slug)?.name ?? slug).join(", ")
    : "all six";
  const active = catalog.filter((row) => !settings.authors?.length || settings.authors.includes(row.author) || row.id.startsWith("c"));
  const restricted = !!settings.quotes && active.some((row) => Object.hasOwn(settings.quotes ?? {}, row.author));
  if (!restricted) return `${who} · every ${seconds}s`;
  const kept = active.filter((row) => quoteKept(row.id, settings.quotes?.[row.author])).length;
  return `${who} · ${kept} of ${active.length} quotes · every ${seconds}s`;
}
