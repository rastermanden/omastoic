import { test, expect } from "bun:test";
import {
  compactSettings,
  describeSettings,
  parseAuthorList,
  parseInterval,
} from "../src/settings.ts";

const roster = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];

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
  expect(describeSettings({}, names)).toBe("all six · every 20s");
  expect(describeSettings({ interval: 8, authors: ["marcus"] }, names)).toBe("Marcus Aurelius · every 8s");
});
