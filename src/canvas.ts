// Compose one screensaver canvas: a braille portrait with a museum label beside
// the quote. ttfx centres whatever it is handed, so this only has to produce a
// rectangular block that fits inside the terminal it will be shown in.

import { join } from "node:path";
import { portraitDownscale } from "./portrait.ts";

export type Quote = { author: string; citation: string; text: string };
export type Author = { slug: string; name: string; dates: string };

export const ART_GAP = 4;
const MIN_LABEL_WIDTH = 20;
const MIN_SCALED_ART_ROWS = 12;
export const AUTHOR_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_AUTHOR_FIELD = 128;
const MAX_ART_BYTES = 64 * 1024;

/** Bundled ids are `q01`, `q02`, … Custom ids are `c01`, `c02`, … `c00` means custom quotes were explicitly cleared. */
export function canonicalQuoteId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  if (!/^(?:q(?:0[1-9]|[1-9]\d+)|c(?:00|0[1-9]|[1-9]\d+))$/.test(id)) return null;
  return id;
}

export type BundledQuote = Quote & { id: string };

export function indexBundled(quotes: Quote[]): BundledQuote[] {
  return quotes.map((quote, index) => ({ ...quote, id: `q${String(index + 1).padStart(2, "0")}` }));
}

export function indexCustom(quotes: Quote[]): BundledQuote[] {
  return quotes.map((quote, index) => ({ ...quote, id: `c${String(index + 1).padStart(2, "0")}` }));
}

export function parseQuotes(tsv: string): Quote[] {
  if (Buffer.byteLength(tsv) > 1024 * 1024) throw new Error("quote file exceeds 1 MiB");
  tsv = tsv.replace(/\r\n/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(tsv)) throw new Error("quote file contains terminal control characters");
  return tsv
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((f) => f.length >= 3)
    .map(([author, citation, ...rest]) => {
      const quote = { author: author.trim(), citation: citation.trim(), text: rest.join(" ").trim() };
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(quote.author)) throw new Error("invalid quote author slug");
      if (!quote.citation || quote.citation.length > 256 || !quote.text || quote.text.length > 4096) throw new Error("quote citation/text is empty or too long");
      return quote;
    });
}

/**
 * Normalise a date range to the bundled style (`" – "` with spaces around an en dash).
 * Free text that is not a range (such as `"fl. 300 BC"` or `"mid-4th c. BC"`) stays as typed.
 */
export function normalizeAuthorDates(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = /^([^-\u2013\u2014]+?)\s*[-\u2013\u2014]\s*([^-\u2013\u2014]+)$/.exec(trimmed);
  if (!match) return trimmed;
  const left = match[1]!.trim();
  const right = match[2]!.trim();
  if (!/\d/.test(left) || (!/\d/.test(right) && !/^(?:present|\?)$/i.test(right))) return trimmed;
  const formatted = `${left} \u2013 ${right}`;
  return formatted.length <= MAX_AUTHOR_FIELD ? formatted : trimmed;
}

export function parseAuthors(tsv: string): Map<string, Author> {
  if (Buffer.byteLength(tsv) > 1024 * 1024) throw new Error("author file exceeds 1 MiB");
  tsv = tsv.replace(/\r\n/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(tsv)) throw new Error("author file contains terminal control characters");
  const authors = new Map<string, Author>();
  for (const line of tsv.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 2 || fields.length > 3) throw new Error("invalid author row");
    const slug = fields[0]!.trim();
    const name = fields[1]!.trim();
    const rawDates = (fields[2] ?? "").trim();
    if (!AUTHOR_SLUG.test(slug) || slug === "all") throw new Error("invalid author slug");
    if (!name || name.length > MAX_AUTHOR_FIELD || rawDates.length > MAX_AUTHOR_FIELD) {
      throw new Error("author name or dates is empty or too long");
    }
    const dates = normalizeAuthorDates(rawDates);
    authors.set(slug, { slug, name, dates });
  }
  return authors;
}

export const cellWidth = (text: string) => Bun.stringWidth(text);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Greedy, display-cell-aware wrap, splitting long words only at graphemes. */
export function wrap(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new Error("invalid text width");
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && cellWidth(line) + 1 + cellWidth(word) <= width) {
      line += ` ${word}`;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const { segment } of graphemes.segment(word)) {
      if (cellWidth(segment) > width) throw new Error("grid too narrow for a text grapheme");
      if (cellWidth(line) + cellWidth(segment) > width) {
        lines.push(line);
        line = "";
      }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Display-cell-aware single-line truncation with `…`, never splitting a grapheme. */
export function truncateCells(text: string, maxWidth: number): string {
  if (!Number.isInteger(maxWidth) || maxWidth < 1) return "";
  if (cellWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  const budget = maxWidth - 1;
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    if (cellWidth(out + segment) > budget) break;
    out += segment;
  }
  const trimmed = out.replace(/ +$/, "");
  return `${trimmed.length ? trimmed : out}…`;
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - cellWidth(s)));
const centre = (s: string, w: number) => pad(" ".repeat(Math.max(0, Math.floor((w - cellWidth(s)) / 2))) + s, w);
const right = (s: string, w: number) => pad(" ".repeat(Math.max(0, w - cellWidth(s))) + s, w);

/** Space uppercase single-width letters for display hierarchy when it fits on one line. */
function spaceCapitals(name: string): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const spacedWords: string[] = [];
  for (const word of words) {
    const chars = [...graphemes.segment(word)].map((entry) => entry.segment);
    if (chars.some((ch) => cellWidth(ch) !== 1)) return null;
    spacedWords.push(chars.join(" "));
  }
  return spacedWords.join("   ");
}

function formatCaption(name: string, dates: string, leftWidth: number): string[] {
  const spaced = spaceCapitals(name);
  const nameLines =
    spaced && cellWidth(spaced) <= leftWidth
      ? [centre(spaced, leftWidth)]
      : wrap(name, leftWidth).map((l) => centre(l, leftWidth));
  const dateLines = dates ? wrap(dates, leftWidth).map((l) => centre(l, leftWidth)) : [];
  return [...nameLines, ...dateLines];
}

/**
 * Pick a quote at random, avoiding the ones most recently shown. `recent` holds
 * indexes from previous calls; the returned list is the one to store back.
 */
export function pick(
  quotes: Quote[],
  recent: number[],
  random: () => number = Math.random,
): { index: number; quote: Quote; recent: number[] } {
  const memory = Math.min(recent.length, Math.max(0, quotes.length - 1));
  const skip = new Set(recent.slice(0, memory));
  const pool = quotes.map((_, i) => i).filter((i) => !skip.has(i));
  const index = pool[Math.floor(random() * pool.length)] ?? 0;
  // Remember roughly a third of the book, so a quote does not come round twice
  // in an evening but the whole book is still reachable.
  const keep = Math.max(1, Math.floor(quotes.length / 3));
  return { index, quote: quotes[index], recent: [index, ...recent].slice(0, keep) };
}

export type Layout = { cols: number; rows: number; art: string[] | null };

/**
 * Lay the quote out for a terminal of `cols` x `rows`. The portrait is included
 * only when there is room for it and the label underneath; otherwise the quote
 * stands on its own, which is what a small or oddly-shaped terminal gets.
 */
export function compose(quote: Quote, author: Author | undefined, layout: Layout): string {
  const { cols, rows, art } = layout;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error("invalid canvas grid");
  if (/[\x00-\x1f\x7f-\x9f]/u.test(quote.text + quote.citation + quote.author + (author?.name ?? "") + (author?.dates ?? "") + (art ? art.join("") : ""))) throw new Error("canvas contains terminal control characters");
  const fits = (lines: string[]) => lines.length <= rows && lines.every((l) => cellWidth(l) <= cols);
  const finish = (lines: string[]) => lines.map((l) => l.trimEnd()).join("\n");
  const name = (author?.name ?? quote.author).toUpperCase();
  const dates = author?.dates ?? "";

  if (art && art.length) {
    const baseArt = art.map((l) => l.replace(/[\s\u2800]+$/u, ""));
    const baseArtWidth = Math.max(...baseArt.map(cellWidth));
    const verticalMargin = rows >= 26 ? 2 : 1;
    const maxRows = rows - verticalMargin * 2;
    if (baseArtWidth > 0 && maxRows >= 1) {
      let activeArt = baseArt;
      let artWidth = baseArtWidth;
      let leftWidth = Math.max(artWidth, MIN_LABEL_WIDTH);
      let caption = formatCaption(name, dates, leftWidth);

      // Keep top and bottom breathing room by scaling tall portraits down to
      // fit the available rows before falling back to quote-only.
      for (let pass = 0; pass < 2 && activeArt.length + caption.length > maxRows; pass++) {
        const maxArtRows = maxRows - caption.length;
        if (maxArtRows < MIN_SCALED_ART_ROWS || maxArtRows >= baseArt.length) break;
        const targetCols = Math.max(1, Math.min(baseArtWidth, Math.round((baseArtWidth * maxArtRows) / baseArt.length)));
        const scaled = portraitDownscale(baseArt.join("\n"), maxArtRows, targetCols);
        if (!scaled) break;
        const scaledLines = scaled.split("\n").map((l) => l.replaceAll("\u2800", " ").replace(/\s+$/, ""));
        const scaledWidth = Math.max(0, ...scaledLines.map(cellWidth));
        if (!scaledLines.length || scaledWidth === 0) break;
        activeArt = scaledLines;
        artWidth = scaledWidth;
        leftWidth = Math.max(artWidth, MIN_LABEL_WIDTH);
        caption = formatCaption(name, dates, leftWidth);
      }

      const margin = cols >= 72 ? 6 : 4;
      const textWidth = Math.min(52, cols - leftWidth - ART_GAP - margin);
      if (textWidth >= 28 && activeArt.length + caption.length <= maxRows) {
        const body = wrap(`“${quote.text}”`, textWidth);
        const citation = wrap(`— ${quote.citation}`, textWidth).map((l) => right(l, textWidth));
        const text = [...body, "", ...citation];

        const artInset = " ".repeat(Math.floor((leftWidth - artWidth) / 2));
        const leftPlate = [
          ...activeArt.map((l) => pad(artInset + l, leftWidth)),
          ...caption,
        ];

        // Anchor the caption directly under the portrait and centre the quote
        // block against the entire plate (portrait plus caption).
        const plateRows = Math.max(leftPlate.length, text.length);
        const leftTop = Math.floor((plateRows - leftPlate.length) / 2);
        const textTop = Math.floor((plateRows - text.length) / 2);
        const gap = " ".repeat(ART_GAP);

        const out: string[] = [];
        for (let i = 0; i < plateRows; i++) {
          const l = pad(i >= leftTop ? (leftPlate[i - leftTop] ?? "") : "", leftWidth);
          const r = i >= textTop ? (text[i - textTop] ?? "") : "";
          out.push((l + gap + r).replace(/\s+$/, ""));
        }
        if (out.length <= maxRows && fits(out)) return finish(out);
      }
    }
  }

  // Lose decoration before content. Try the quiet measure, then a smaller margin,
  // then the full width, then remove dates/blank lines. Never truncate a quote or its citation.
  for (const width of [...new Set([Math.min(64, Math.max(1, cols - 8)), Math.max(1, cols - 4), cols])]) {
    const body = wrap(`“${quote.text}”`, width);
    const citation = wrap(quote.citation, width).map((l) => right(l, width));
    for (const compact of [false, true]) {
      const attribution = wrap(dates && !compact ? `— ${name} · ${dates}` : `— ${name}`, width).map((l) => right(l, width));
      const lines = [...body, ...(compact ? [] : [""]), ...attribution, ...citation];
      if (fits(lines)) return finish(lines);
    }
  }
  // Below the supported reading area, show an explicit placeholder, not a
  // misleading partial quotation. Keep the source so it can still be looked up.
  const notice = [...wrap("Resize to read quote", cols), ...wrap(quote.citation, cols)];
  if (fits(notice)) return finish(notice);
  throw new Error(`grid ${cols}x${rows} too small to show citation: ${quote.citation}`);
}

/** Read the art for an author, or null when there is no portrait for them. */
export async function loadArt(artDir: string, slug: string): Promise<string[] | null> {
  if (!AUTHOR_SLUG.test(slug)) return null;
  const file = Bun.file(join(artDir, `${slug}.txt`));
  if (!(await file.exists())) return null;
  if (file.size > MAX_ART_BYTES) throw new Error("portrait art file exceeds 64 KiB");
  const text = (await file.text()).replace(/\r\n/g, "\n");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u.test(text)) throw new Error("portrait art contains terminal control characters");
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.length && lines.some((line) => line.length > 0) ? lines : null;
}
