import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cellWidth, compose, parseAuthors, parseQuotes, pick, wrap, type Quote } from "../src/canvas.ts";

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

test("audit grid: all 64 quotes fit, or explicitly request a reading area", () => {
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

test("every portrait and quote pair fits the smallest grid the layout claims", () => {
  for (const q of quotes) {
    const block = compose(q, authors.get(q.author), { cols: 92, rows: 25, art: art(q.author) });
    expect(width(block)).toBeLessThanOrEqual(92);
    expect(height(block)).toBeLessThanOrEqual(25);
  }
});

test("a grid too small for the portrait falls back to the quote alone", () => {
  const block = compose(quote, authors.get("marcus"), { cols: 60, rows: 12, art: art("marcus") });
  expect(block).not.toContain("⣿");
  expect(width(block)).toBeLessThanOrEqual(60);
  expect(block).toContain("— MARCUS AURELIUS");
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
