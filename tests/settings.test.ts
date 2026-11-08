import { test, expect } from "bun:test";
import {
  applyQuoteFlags,
  compactSettings,
  describeSettings,
  inRotation,
  parseAuthorList,
  parseInterval,
  parseQuoteFlag,
  DEFAULT_INTERVAL,
  normalizeSettings,
} from "../src/settings.ts";
import { indexBundled, type Quote } from "../src/canvas.ts";

const roster = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];

test("hand-edited config is schema-validated at the boundary", () => {
  for (const raw of [null, [], 3, "text", { interval: 0, authors: "marcus" }, { interval: -1 }, { interval: Infinity }, { interval: "60" }, { authors: [null] }]) expect(normalizeSettings(raw, roster)).toEqual({});
  expect(normalizeSettings({ interval: 90, authors: ["marcus", "marcus"] }, roster)).toEqual({ interval: 90, authors: ["marcus"] });
});

test("interval must be a whole number of seconds in range", () => {
  expect(parseInterval("20")).toBe(20);
  expect(parseInterval(" 8 ")).toBe(8);
  expect(parseInterval("0")).toBeNull();
  expect(parseInterval("1.5")).toBeNull();
  expect(parseInterval("nope")).toBeNull();
  expect(parseInterval("3601")).toBeNull();
});

test("author lists accept slugs, all, and reject unknown names", () => {
  expect(parseAuthorList("marcus,seneca", roster)).toEqual(["marcus", "seneca"]);
  expect(parseAuthorList("marcus seneca", roster)).toEqual(["marcus", "seneca"]);
  expect(parseAuthorList("all", roster)).toEqual([]);
  expect(parseAuthorList("*", roster)).toEqual([]);
  expect(parseAuthorList("marcus,plato", roster)).toBeNull();
});

test("the full roster is stored as no authors key", () => {
  expect(compactSettings({ interval: 20, authors: roster }, roster)).toEqual({ interval: 20 });
  expect(compactSettings({ interval: 8, authors: ["marcus"] }, roster)).toEqual({
    interval: 8,
    authors: ["marcus"],
  });
  expect(compactSettings({ authors: [] }, roster)).toEqual({});
});

test("describeSettings names the roster and the interval", () => {
  const names = new Map([
    ["marcus", { name: "Marcus Aurelius" }],
    ["seneca", { name: "Seneca" }],
  ]);
  expect(DEFAULT_INTERVAL).toBe(60);
  expect(describeSettings({}, names)).toBe("all six · every 60s");
  expect(describeSettings({ interval: 8, authors: ["marcus"] }, names)).toBe("Marcus Aurelius · every 8s");
});

const catalog = [
  { id: "q01", author: "marcus" },
  { id: "q02", author: "marcus" },
  { id: "q03", author: "seneca" },
];

test("hand-edited quote ids are canonical, ordered, and dropped when malformed", () => {
  expect(normalizeSettings({ quotes: { marcus: ["q01", "q02"] } }, roster, catalog)).toEqual({});
  expect(normalizeSettings({ quotes: { marcus: ["q02", "q02"] } }, roster, catalog)).toEqual({ quotes: { marcus: ["q02"] } });
  expect(normalizeSettings({ quotes: { marcus: ["q1"] } }, roster, catalog)).toEqual({});
  expect(normalizeSettings({ quotes: { marcus: ["q001"] } }, roster, catalog)).toEqual({});
  expect(normalizeSettings({ quotes: { marcus: ["q2", "q02"] } }, roster, catalog)).toEqual({});
  expect(normalizeSettings({ quotes: { marcus: ["q01", "q02"], seneca: [] } }, roster, catalog)).toEqual({ quotes: { seneca: [] } });
  expect(normalizeSettings({ interval: 12, quotes: { marcus: ["q99"] } }, roster, catalog)).toEqual({ interval: 12 });
  expect(normalizeSettings({ quotes: { plato: ["q01"] } }, roster, catalog)).toEqual({});
  expect(normalizeSettings({ quotes: ["q01"] }, roster, catalog)).toEqual({});
});

test("quote flags merge per Stoic and a full set is the default", () => {
  expect(parseQuoteFlag("all")).toEqual({ kind: "reset" });
  expect(parseQuoteFlag("marcus=all")).toEqual({ kind: "author", author: "marcus", ids: "all" });
  expect(parseQuoteFlag("marcus=q01,q02,q02")).toEqual({ kind: "author", author: "marcus", ids: ["q01", "q02"] });
  expect(parseQuoteFlag("marcus=none")).toEqual({ kind: "author", author: "marcus", ids: [] });
  expect(parseQuoteFlag("marcus")).toBeNull();
  expect(parseQuoteFlag("*")).toBeNull();
  expect(parseQuoteFlag("marcus=*")).toBeNull();
  expect(parseQuoteFlag("marcus=-")).toBeNull();
  expect(parseQuoteFlag("marcus=q1")).toBeNull();
  expect(parseQuoteFlag("marcus=q001")).toBeNull();
  const cleared = applyQuoteFlags({ marcus: ["q01"], seneca: [] }, ["all", "Marcus=q02"], roster, catalog);
  expect(cleared).toEqual({ ok: true, quotes: { marcus: ["q02"] } });
  const restored = applyQuoteFlags({ marcus: ["q01"], seneca: [] }, ["marcus=all"], roster, catalog);
  expect(restored).toEqual({ ok: true, quotes: { seneca: [] } });
  expect(applyQuoteFlags(undefined, ["marcus=q99"], roster, catalog).ok).toBe(false);
  expect(applyQuoteFlags(undefined, ["plato=q01"], roster, catalog).ok).toBe(false);
});

test("compact quote settings omit unrestricted Stoics", () => {
  expect(compactSettings({ interval: 8, quotes: { marcus: ["q01", "q02"], seneca: ["q03"] } }, roster, catalog)).toEqual({ interval: 8 });
  expect(compactSettings({ quotes: { marcus: ["q02"], seneca: [] } }, roster, catalog)).toEqual({
    quotes: { marcus: ["q02"], seneca: [] },
  });
});

test("describeSettings counts bundled lines still in rotation", () => {
  const names = new Map([["marcus", { name: "Marcus Aurelius" }]]);
  expect(describeSettings({ quotes: { marcus: ["q02"] } }, names, catalog)).toBe("all six · 2 of 3 quotes · every 60s");
  expect(describeSettings({ authors: ["seneca"], quotes: { marcus: ["q02"] } }, names, catalog)).toBe("seneca · every 60s");
});

test("rotation keeps custom lines and falls back when a filter matches nothing", () => {
  const bundled = indexBundled([
    { author: "marcus", citation: "A", text: "first" },
    { author: "marcus", citation: "A", text: "second" },
    { author: "seneca", citation: "B", text: "third" },
  ]);
  const custom: Quote[] = [{ author: "marcus", citation: "Mine", text: "added" }];
  expect(bundled.map((quote) => quote.id)).toEqual(["q01", "q02", "q03"]);
  expect(inRotation(bundled, custom, { quotes: { marcus: ["q02"] } }).quotes.map((quote) => quote.text)).toEqual(["second", "third", "added"]);
  const indexed = [{ ...custom[0], id: "c01" }];
  expect(inRotation(bundled, indexed, { quotes: { marcus: ["q02"] } }).quotes.map((quote) => quote.text)).toEqual(["second", "third", "added"]);
  expect(inRotation(bundled, indexed, { quotes: { marcus: ["q02", "c00"] } }).quotes.map((quote) => quote.text)).toEqual(["second", "third"]);
  expect(inRotation(bundled, [], { authors: ["seneca"], quotes: { seneca: [] } })).toEqual({
    quotes: bundled,
    ignoredSelection: false,
    ignoredAuthors: true,
  });
  expect(inRotation(bundled, custom, { quotes: { marcus: [], seneca: [] } }).quotes).toEqual(custom);
  expect(inRotation(bundled, [], { quotes: { marcus: [], seneca: [] } }).ignoredSelection).toBe(true);
  expect(inRotation(bundled, [], { authors: ["marcus"], quotes: { marcus: [], seneca: [] } })).toEqual({
    quotes: bundled.filter((quote) => quote.author === "marcus"),
    ignoredSelection: true,
    ignoredAuthors: false,
  });
});

test("a missing custom id drops only that id", () => {
  const book = [
    { id: "q01", author: "marcus" },
    { id: "q02", author: "marcus" },
    { id: "c02", author: "marcus" },
    { id: "q03", author: "seneca" },
    { id: "q04", author: "seneca" },
  ];
  expect(normalizeSettings({ quotes: { marcus: ["q01", "c01"], seneca: ["q03"] } }, roster, book)).toEqual({
    quotes: { marcus: ["q01", "c00"], seneca: ["q03"] },
  });
  expect(normalizeSettings({ quotes: { marcus: ["q01", "c01", "c02"], seneca: ["q03"] } }, roster, book)).toEqual({
    quotes: { marcus: ["q01", "c02"], seneca: ["q03"] },
  });
  expect(normalizeSettings({ interval: 12, quotes: { marcus: ["q99", "c01"] } }, roster, book)).toEqual({ interval: 12 });
  expect(normalizeSettings({ quotes: { marcus: ["q01", "c01"], seneca: ["q03"] } }, roster, book, false)).toEqual({
    quotes: { marcus: ["q01", "c01"], seneca: ["q03"] },
  });
  expect(compactSettings({ interval: 30, quotes: { marcus: ["q01", "c01"], seneca: ["q03"] } }, roster, book, false)).toEqual({
    interval: 30,
    quotes: { marcus: ["q01", "c01"], seneca: ["q03"] },
  });
  expect(applyQuoteFlags({ marcus: ["q01", "c01"], seneca: ["q03"] }, ["seneca=q04"], roster, book, false)).toEqual({
    ok: true,
    quotes: { marcus: ["q01", "c01"], seneca: ["q04"] },
  });
  const bundled = indexBundled([
    { author: "marcus", citation: "A", text: "first" },
    { author: "marcus", citation: "A", text: "second" },
    { author: "seneca", citation: "B", text: "third" },
  ]);
  const settings = normalizeSettings({ quotes: { marcus: ["q02", "c01"] } }, roster, [
    { id: "q01", author: "marcus" },
    { id: "q02", author: "marcus" },
    { id: "c02", author: "marcus" },
    { id: "q03", author: "seneca" },
  ]);
  expect(inRotation(bundled, [{ ...bundled[0], id: "c02", citation: "Old", text: "stays off" }], settings).quotes.map((quote) => quote.text)).toEqual([
    "second",
    "third",
  ]);
  expect(applyQuoteFlags({ marcus: ["q01", "c01", "c00"] }, ["marcus=q02"], roster, book, false)).toEqual({
    ok: true,
    quotes: { marcus: ["q02", "c01", "c00"] },
  });
  expect(applyQuoteFlags({ marcus: ["q01", "c00"], seneca: ["q03"] }, ["marcus=none"], roster, book, false)).toEqual({
    ok: true,
    quotes: { marcus: ["c00"], seneca: ["q03"] },
  });
});

test("cleared custom lines stay out when rotation falls back", () => {
  const bundled = indexBundled([
    { author: "marcus", citation: "A", text: "first" },
    { author: "marcus", citation: "A", text: "second" },
    { author: "seneca", citation: "B", text: "third" },
  ]);
  const cleared = [{ author: "marcus", citation: "Mine", text: "cleared", id: "c01" }];
  const authorFallback = inRotation(bundled, cleared, { authors: ["marcus"], quotes: { marcus: ["c00"] } });
  expect(authorFallback.ignoredAuthors).toBe(true);
  expect(authorFallback.quotes.map((quote) => quote.text)).toEqual(["first", "second", "third"]);
  const omitted = inRotation(bundled, cleared, { authors: ["marcus"], quotes: { marcus: ["c02"] } });
  expect(omitted.ignoredAuthors).toBe(true);
  expect(omitted.quotes.map((quote) => quote.text)).not.toContain("cleared");
  const empty = inRotation(bundled, cleared, { quotes: { marcus: ["c00"], seneca: ["c00"] } });
  expect(empty.ignoredSelection).toBe(true);
  expect(empty.quotes.map((quote) => quote.text)).toEqual(["first", "second", "third"]);
  const implicit = inRotation(bundled, [{ author: "marcus", citation: "Mine", text: "added", id: "c01" }], {
    authors: ["zeno"],
    quotes: { marcus: ["q02"] },
  });
  expect(implicit.ignoredAuthors).toBe(true);
  expect(implicit.quotes.map((quote) => quote.text)).toContain("added");
});
