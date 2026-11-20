import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { portraitDownscale } from "../src/portrait.ts";

test("a portrait downscale keeps the whole drawing inside the grid", () => {
  const art = readFileSync(join(import.meta.dir, "../art/marcus.txt"), "utf8");
  const crop = portraitDownscale(art, 6, 8);
  const lines = crop.split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThanOrEqual(6);
  expect(lines.some((line) => /[^\u2800\s]/.test(line))).toBe(true);
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(8);
  // A solid block stays solid when scaled, so this is a scale and not a slice.
  const block = Array.from({ length: 12 }, () => "⣿".repeat(12)).join("\n");
  const scaled = portraitDownscale(block, 2, 2);
  expect(scaled.split("\n").every((line) => [...line].every((char) => char === "⣿"))).toBe(true);
  expect(portraitDownscale("", 4, 4)).toBe("");
  expect(portraitDownscale(art, 0, 8)).toBe("");
});
