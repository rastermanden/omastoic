import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { portraitCrop } from "../src/portrait.ts";

test("a portrait crop keeps braille and stays inside the requested size", () => {
  const art = readFileSync(join(import.meta.dir, "../art/marcus.txt"), "utf8");
  const crop = portraitCrop(art, 8, 18);
  const lines = crop.split("\n");
  expect(lines.length).toBeLessThanOrEqual(8);
  expect(lines.some((line) => /\S/.test(line))).toBe(true);
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(18);
  expect(portraitCrop("", 4, 4)).toBe("");
  expect(portraitCrop(art, 0, 8)).toBe("");
});
