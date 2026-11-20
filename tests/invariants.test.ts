import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAuthors, parseQuotes } from "../src/canvas.ts";

const root = join(import.meta.dir, "..");
const quotes = parseQuotes(readFileSync(join(root, "data/quotes.tsv"), "utf8"));
const authors = parseAuthors(readFileSync(join(root, "data/authors.tsv"), "utf8"));
const ledger = JSON.parse(readFileSync(join(root, "docs/quote-sources.json"), "utf8"));

test("every bundled quote has an author and an exact source", () => {
  expect(quotes.length).toBeGreaterThan(0);
  expect(ledger.quotes).toHaveLength(quotes.length);
  for (const [index, quote] of quotes.entries()) {
    const source = ledger.quotes[index];
    expect(authors.has(quote.author), `${source.id} author`).toBe(true);
    expect(quote.author).toBe(source.author);
    expect(quote.citation.length).toBeGreaterThan(0);
    expect(quote.citation).toBe(source.citation);
    expect(source.edition.length).toBeGreaterThan(0);
    expect(source.url).toMatch(/^https:\/\//);
    expect(source.passages.length).toBeGreaterThan(0);
  }
});
