// Compose one screensaver canvas: a braille portrait with a museum label beside
// the quote. ttfx centres whatever it is handed, so this only has to produce a
// rectangular block that fits inside the terminal it will be shown in.

import { join } from "node:path";

export type Quote = { author: string; citation: string; text: string };
export type Author = { slug: string; name: string; dates: string };

export const ART_GAP = 4;

export function parseQuotes(tsv: string): Quote[] {
  return tsv
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((f) => f.length >= 3)
    .map(([author, citation, ...rest]) => ({
      author: author.trim(),
      citation: citation.trim(),
      text: rest.join("\t").trim(),
    }));
}

export function parseAuthors(tsv: string): Map<string, Author> {
  const authors = new Map<string, Author>();
  for (const line of tsv.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [slug, name, dates] = line.split("\t");
    if (slug && name) authors.set(slug.trim(), { slug: slug.trim(), name: name.trim(), dates: (dates ?? "").trim() });
  }
  return authors;
}

/** Greedy wrap. Words longer than the width are left long rather than broken. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length));
const centre = (s: string, w: number) => {
  const left = Math.max(0, Math.floor((w - [...s].length) / 2));
  return pad(" ".repeat(left) + s, w);
};
const right = (s: string, w: number) => {
  const left = Math.max(0, w - [...s].length);
  return pad(" ".repeat(left) + s, w);
};

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
  const name = (author?.name ?? quote.author).toUpperCase();
  const dates = author?.dates ?? "";

  if (art && art.length) {
    const artWidth = Math.max(...art.map((l) => [...l].length));
    const textWidth = Math.min(52, Math.max(30, cols - artWidth - ART_GAP - 2));
    const body = wrap(`“${quote.text}”`, textWidth);
    const text = [...body, "", right(quote.citation, textWidth)];

    const label = ["", centre(name, artWidth), ...(dates ? [centre(dates, artWidth)] : [])];
    const left = [...art.map((l) => pad(l, artWidth)), ...label];

    // Sit the quote against the portrait's optical centre, a little above the
    // label so the two blocks read as one plate.
    const offset = Math.max(0, Math.floor((art.length - text.length) / 2));
    const height = Math.max(left.length, offset + text.length);
    const gap = " ".repeat(ART_GAP);

    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      const l = pad(left[i] ?? "", artWidth);
      const r = i >= offset ? (text[i - offset] ?? "") : "";
      out.push((l + gap + r).replace(/\s+$/, ""));
    }
    if (out.length <= rows) return out.join("\n");
  }

  // Quote alone, centred as a block.
  const textWidth = Math.min(64, Math.max(28, cols - 8));
  const body = wrap(`“${quote.text}”`, textWidth);
  const attribution = dates ? `— ${name} · ${dates}` : `— ${name}`;
  return [...body, "", right(attribution, textWidth), right(quote.citation, textWidth)]
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n");
}

/** Read the art for an author, or null when there is no portrait for them. */
export async function loadArt(artDir: string, slug: string): Promise<string[] | null> {
  const file = Bun.file(join(artDir, `${slug}.txt`));
  if (!(await file.exists())) return null;
  const lines = (await file.text()).replace(/\n+$/, "").split("\n");
  return lines.length ? lines : null;
}
