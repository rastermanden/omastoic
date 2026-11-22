import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cellWidth, compose, normalizeAuthorDates, parseAuthors, parseQuotes, pick, wrap, type Quote } from "../src/canvas.ts";

const root = join(import.meta.dir, "..");
const quotes = parseQuotes(readFileSync(join(root, "data/quotes.tsv"), "utf8"));
const authors = parseAuthors(readFileSync(join(root, "data/authors.tsv"), "utf8"));
const art = (slug: string) =>
  readFileSync(join(root, "art", `${slug}.txt`), "utf8").replace(/\n+$/, "").split("\n");

const width = (block: string) => Math.max(...block.split("\n").map(cellWidth));
const height = (block: string) => block.split("\n").length;

test("the quote book parses and every quote has an author, citation and text", () => {
  expect(quotes.length).toBeGreaterThan(50);
  for (const q of quotes) {
    expect(q.author).toMatch(/^[a-z]+$/);
    expect(q.citation.length).toBeGreaterThan(0);
    expect(q.text.length).toBeGreaterThan(0);
  }
});

test("every author in the book has a name, dates and a portrait", () => {
  const portraits = new Set(readdirSync(join(root, "art")).map((f) => f.replace(/\.txt$/, "")));
  for (const slug of new Set(quotes.map((q) => q.author))) {
    expect(authors.get(slug)?.name).toBeTruthy();
    expect(authors.get(slug)?.dates).toBeTruthy();
    expect(portraits.has(slug)).toBe(true);
  }
});

test("audit grid: all 84 quotes fit, or explicitly request a reading area", () => {
  for (const [cols, rows] of [[92, 25], [60, 30], [40, 24], [20, 8], [60, 12], [80, 24]]) {
    for (const q of quotes) {
      const block = compose(q, authors.get(q.author), { cols, rows, art: art(q.author) });
      expect(width(block)).toBeLessThanOrEqual(cols);
      expect(height(block)).toBeLessThanOrEqual(rows);
      expect(block.replace(/\s/g, "")).toContain(q.citation.replace(/\s/g, ""));
      if (cols >= 40) expect(block).not.toContain("Resize to read");
    }
  }
});

test("Unicode and unbroken custom text use display cells and retain graphemes", () => {
  expect(wrap("你好世界", 4)).toEqual(["你好", "世界"]);
  expect(wrap("e\u0301e\u0301e\u0301", 2)).toEqual(["e\u0301e\u0301", "e\u0301"]);
  expect(wrap("👩‍💻👩‍💻", 2)).toEqual(["👩‍💻", "👩‍💻"]);
  expect(wrap("abcdefghij", 3)).toEqual(["abc", "def", "ghi", "j"]);
  expect(() => compose(quote, undefined, { cols: 1, rows: 1, art: null })).toThrow("too small");
});

test("untrusted quote files cannot inject terminal escapes or unbounded input", () => {
  expect(() => parseQuotes("x\tcite\t\x1b[2J")).toThrow("control");
  expect(() => parseQuotes("x".repeat(1024 * 1024 + 1))).toThrow("1 MiB");
  expect(() => parseQuotes("../private\tcite\ttext")).toThrow("slug");
  expect(() => parseQuotes(`custom\tcite\t${"x".repeat(4097)}`)).toThrow("too long");
});

test("CRLF quote records normalize without accepting embedded carriage returns", () => {
  expect(parseQuotes("# custom book\r\ncustom\tSource 1\tA thought.\r\nother\tSource 2\tAnother thought.\n")).toEqual([
    { author: "custom", citation: "Source 1", text: "A thought." },
    { author: "other", citation: "Source 2", text: "Another thought." },
  ]);
  for (const record of ["cus\rtom\tSource 1\tThought.", "custom\tSource\r1\tThought.", "custom\tSource 1\tA\rthought.", "custom\tSource 1\tThought.\r"]) {
    expect(() => parseQuotes(record)).toThrow("control");
  }
  expect(() => compose({ author: "custom", citation: "Source 1", text: "A\rthought." }, undefined, { cols: 60, rows: 12, art: null })).toThrow("control");
});

test("wrap keeps every line inside the width", () => {
  const lines = wrap(quotes.map((q) => q.text).join(" "), 40);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
});

test("wrap does not lose or reorder words", () => {
  const text = "the impediment to action advances action";
  expect(wrap(text, 12).join(" ")).toBe(text);
});

const quote: Quote = {
  author: "marcus",
  citation: "Meditations VIII.47",
  text: "If thou art pained by any external thing, it is not this that disturbs thee, but thy own judgment about it.",
};

test("the full canvas fits the grid it was asked for", () => {
  const block = compose(quote, authors.get("marcus"), { cols: 111, rows: 30, art: art("marcus") });
  expect(width(block)).toBeLessThanOrEqual(111);
  expect(height(block)).toBeLessThanOrEqual(30);
  expect(block).toContain("MARCUS AURELIUS");
  expect(block).toContain("Meditations VIII.47");
});

test("every portrait and quote pair fits the smallest grid the layout claims with horizontal margin", () => {
  for (const q of quotes) {
    const block = compose(q, authors.get(q.author), { cols: 92, rows: 25, art: art(q.author) });
    expect(width(block)).toBeLessThanOrEqual(86);
    expect(height(block)).toBeLessThanOrEqual(25);
  }
});

test("a citation longer than 52 characters wraps instead of dropping the portrait", () => {
  const longCitation = "A Conflict of Visions: Ideological Origins of Political Struggles, Chapter 2 (Revised Edition)";
  const block = compose(
    { author: "marcus", citation: longCitation, text: "There are no solutions, only trade-offs." },
    authors.get("marcus"),
    { cols: 92, rows: 25, art: art("marcus") },
  );
  expect(block).toMatch(/[\u2801-\u28ff]/);
  expect(width(block)).toBeLessThanOrEqual(86);
  expect(height(block)).toBeLessThanOrEqual(25);
  expect(block.replace(/[\u2800-\u28ff\s]/gu, "")).toContain(longCitation.replace(/\s/g, ""));
});

test("a grid too small for the portrait falls back to the quote alone", () => {
  const block = compose(quote, authors.get("marcus"), { cols: 60, rows: 12, art: art("marcus") });
  expect(block).not.toContain("⣿");
  expect(width(block)).toBeLessThanOrEqual(60);
  expect(block).toContain("— MARCUS AURELIUS");
});

test("extreme 1:9 tall and 10:1 wide portraits keep readable name and dates lines", () => {
  const marcus = authors.get("marcus");
  const tall1to9 = Array.from({ length: 18 }, () => "⣿".repeat(4));
  const tall1col = Array.from({ length: 20 }, () => "⣿");
  const wide10to1 = Array.from({ length: 2 }, () => "⣿".repeat(34));
  const smallWide10to1 = ["⣿".repeat(10)];

  for (const [cols, rows] of [[92, 25], [100, 30]] as const) {
    for (const portrait of [tall1to9, tall1col, wide10to1, smallWide10to1]) {
      const block = compose(quote, marcus, { cols, rows, art: portrait });
      const lines = block.split("\n");
      expect(block).toMatch(/[\u2801-\u28ff]/);
      expect(width(block)).toBeLessThanOrEqual(cols - 6);
      expect(height(block)).toBeLessThanOrEqual(rows);
      expect(block).toContain("MARCUS AURELIUS");
      expect(block).toContain("AD 121 – 180");
      expect(lines.find((line) => line.includes("MARCUS AURELIUS"))!.trim()).toBe("MARCUS AURELIUS");
      expect(lines.find((line) => line.includes("AD 121 – 180"))!.trim()).toBe("AD 121 – 180");
      for (const line of lines) {
        expect(line).toBe(line.replace(/\s+$/, ""));
      }
    }
  }

  const unicodeBlock = compose(quote, { slug: "kongzi", name: "孔子", dates: "551 – 479 BC" }, { cols: 92, rows: 25, art: tall1col });
  expect(unicodeBlock).toMatch(/[\u2801-\u28ff]/);
  expect(unicodeBlock).toContain("孔子");
  expect(unicodeBlock).toContain("551 – 479 BC");

  const ciceroBlock = compose(quote, { slug: "cicero", name: "Marcus Tullius Cicero", dates: "106 – 43 BC" }, { cols: 92, rows: 25, art: tall1to9 });
  expect(ciceroBlock).toMatch(/[\u2801-\u28ff]/);
  expect(ciceroBlock).toContain("MARCUS TULLIUS");
  expect(ciceroBlock).toContain("CICERO");
  expect(ciceroBlock).toContain("106 – 43 BC");

  const staggered = [" ⣿", "⣿⣿", "  ⣿"];
  const staggeredBlock = compose(quote, marcus, { cols: 92, rows: 25, art: staggered });
  const artRows = staggeredBlock.split("\n").filter((line) => line.includes("⣿"));
  const indent = (line: string) => line.indexOf("⣿");
  expect(artRows.length).toBe(3);
  expect(indent(artRows[0]!) - indent(artRows[1]!)).toBe(1);
  expect(indent(artRows[2]!) - indent(artRows[1]!)).toBe(2);

  const trailingPadded = ["⣿⣿                  ", "⣿⣿\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800\u2800"];
  const paddedBlock = compose(quote, marcus, { cols: 92, rows: 25, art: trailingPadded });
  const paddedArtLine = paddedBlock.split("\n").find((line) => line.includes("⣿"))!;
  expect(paddedArtLine.indexOf("⣿")).toBeGreaterThan(0);
});

test("typical portrait aspect ratios keep their unpadded left alignment", () => {
  const marcus = authors.get("marcus");
  const portrait3to4 = Array.from({ length: 16 }, () => "⣿".repeat(26));
  const portrait4to3 = Array.from({ length: 10 }, () => "⣿".repeat(31));
  const portrait1to1 = Array.from({ length: 15 }, () => "⣿".repeat(28));

  for (const [portrait, expectedWidth] of [
    [portrait3to4, 26],
    [portrait4to3, 31],
    [portrait1to1, 28],
  ] as const) {
    const block = compose(quote, marcus, { cols: 92, rows: 25, art: portrait });
    const lines = block.split("\n");
    expect(lines[0]!.startsWith("⣿".repeat(expectedWidth))).toBe(true);
    const quoteRow = lines.find((line) => line.includes("“"))!;
    expect(quoteRow.indexOf("“")).toBe(expectedWidth + 4);
    expect(block).toContain("MARCUS AURELIUS");
    expect(block).toContain("AD 121 – 180");
  }
});

test("grids too small for an extreme portrait and readable label fall back to quote-only", () => {
  const marcus = authors.get("marcus");
  const tall1to9 = Array.from({ length: 18 }, () => "⣿".repeat(4));
  const wide10to1 = Array.from({ length: 2 }, () => "⣿".repeat(34));

  for (const [portrait, cols, rows] of [
    [tall1to9, 55, 30],
    [tall1to9, 50, 30],
    [tall1to9, 92, 20],
    [wide10to1, 68, 25],
    [wide10to1, 92, 4],
    [["", ""], 92, 25],
    [[" ", "   "], 92, 20],
    [["\u2800\u2800"], 92, 25],
  ] as const) {
    const block = compose(quote, marcus, { cols, rows, art: [...portrait] });
    expect(block).not.toMatch(/[\u2801-\u28ff]/);
    expect(width(block)).toBeLessThanOrEqual(cols);
    expect(height(block)).toBeLessThanOrEqual(rows);
    expect(block).toContain("— MARCUS AURELIUS");
  }
});

test("an author with no portrait still renders", () => {
  const block = compose({ ...quote, author: "nobody" }, undefined, { cols: 92, rows: 25, art: null });
  expect(block).toContain("— NOBODY");
});

test("no line ever carries trailing whitespace", () => {
  for (const grid of [
    { cols: 111, rows: 30, art: art("seneca") },
    { cols: 60, rows: 12, art: null },
  ]) {
    for (const line of compose(quote, authors.get("marcus"), grid).split("\n")) {
      expect(line).toBe(line.replace(/\s+$/, ""));
    }
  }
});

test("pick avoids the quotes it was just given", () => {
  const recent = [0, 1, 2];
  for (let i = 0; i < 200; i++) {
    expect(recent).not.toContain(pick(quotes, recent).index);
  }
});

test("pick remembers what it chose, newest first, without growing forever", () => {
  let recent: number[] = [];
  for (let i = 0; i < 200; i++) recent = pick(quotes, recent).recent;
  expect(recent.length).toBe(Math.floor(quotes.length / 3));
  expect(new Set(recent).size).toBe(recent.length);
});

test("pick still returns something when every quote is in the recent list", () => {
  const recent = quotes.map((_, i) => i);
  expect(quotes[pick(quotes, recent).index]).toBeDefined();
});

test("normalizeAuthorDates formats ranges to the bundled en-dash style and keeps free text", () => {
  expect(normalizeAuthorDates("1632-1704")).toBe("1632 – 1704");
  expect(normalizeAuthorDates("1632–1704")).toBe("1632 – 1704");
  expect(normalizeAuthorDates("1632—1704")).toBe("1632 – 1704");
  expect(normalizeAuthorDates("1632 - 1704")).toBe("1632 – 1704");
  expect(normalizeAuthorDates("1632  –  1704")).toBe("1632 – 1704");
  expect(normalizeAuthorDates("AD 121-180")).toBe("AD 121 – 180");
  expect(normalizeAuthorDates("c. 4 BC-AD 65")).toBe("c. 4 BC – AD 65");
  expect(normalizeAuthorDates("c. AD 30 – 100")).toBe("c. AD 30 – 100");
  expect(normalizeAuthorDates("1950-present")).toBe("1950 – present");
  expect(normalizeAuthorDates("1632-?")).toBe("1632 – ?");

  // Non-range text and multi-hyphen dates stay as typed.
  expect(normalizeAuthorDates("fl. 300 BC")).toBe("fl. 300 BC");
  expect(normalizeAuthorDates("c. 260 BC")).toBe("c. 260 BC");
  expect(normalizeAuthorDates("mid-4th c. BC")).toBe("mid-4th c. BC");
  expect(normalizeAuthorDates("late 1st-century AD")).toBe("late 1st-century AD");
  expect(normalizeAuthorDates("2024-01-15")).toBe("2024-01-15");
  expect(normalizeAuthorDates("")).toBe("");
  expect(normalizeAuthorDates("   ")).toBe("");

  // All bundled authors are already normalized and idempotent.
  for (const author of authors.values()) {
    expect(normalizeAuthorDates(author.dates)).toBe(author.dates);
  }

  // parseAuthors normalizes existing rows on read.
  const parsed = parseAuthors("locke\tJohn Locke\t1632–1704\nhume\tDavid Hume\t1711-1776\nz\tZeno\tfl. 300 BC\n");
  expect(parsed.get("locke")?.dates).toBe("1632 – 1704");
  expect(parsed.get("hume")?.dates).toBe("1711 – 1776");
  expect(parsed.get("z")?.dates).toBe("fl. 300 BC");
});
