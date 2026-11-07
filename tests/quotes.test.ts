import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuotes } from "../src/canvas.ts";

const quotes = parseQuotes(readFileSync(join(import.meta.dir, "../data/quotes.tsv"), "utf8"));
const ledger = JSON.parse(readFileSync(join(import.meta.dir, "../docs/quote-sources.json"), "utf8"));
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";

test("all 79 entries retain reviewed citations and words from independent source passages", () => {
  // The oracle is the manual source review ledger, not the renderer. This
  // rejects miscitation, paraphrase or unmarked joining of separate passages.
  // It is consistency evidence, not an automated proof of ancient authorship.
  expect(quotes).toHaveLength(79);
  expect(ledger.quotes).toHaveLength(79);
  const ids = new Set<string>();
  for (const [i, source] of ledger.quotes.entries()) {
    ids.add(source.id);
    expect(quotes[i].author).toBe(source.author);
    expect(quotes[i].citation).toBe(source.citation);
    expect(new URL(source.url).protocol).toBe("https:");
    const segments = quotes[i].text.split("…").map((s) => words(s)).filter(Boolean);
    expect(source.passages).toHaveLength(segments.length);
    for (const [j, segment] of segments.entries()) expect(words(source.passages[j])).toContain(segment);
  }
  expect(ids.size).toBe(79);
});

test("confirmed erroneous citations cannot return", () => {
  const find = (fragment: string) => quotes.find((q) => q.text.includes(fragment));
  expect(find("ten thousand years")?.citation).toBe("Meditations IV.17");
  expect(find("remedy for anger")?.citation).toBe("On Anger II.29");
  expect(find("equally faulty")?.citation).toBe("Letters 3.4");
  expect(find("every day ought")?.citation).toBe("Letters 12.8");
  expect(find("postpone nothing")?.citation).toBe("Letters 101.7");
  expect(find("some troubles")?.citation).toBe("Letters 13.10");
  expect(find("good by chance")?.citation).toBe("Letters 123.16");
  expect(find("attended to the multitude")?.citation).toBe("Diogenes Laertius VII.182");
  expect(find("poverty which produces")?.citation).toBe("Fragments XXV (Long)");
});
