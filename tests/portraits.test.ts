import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAuthors } from "../src/canvas.ts";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "assets/portraits.json"), "utf8"));
const authors = parseAuthors(readFileSync(join(root, "data/authors.tsv"), "utf8"));
const credits = readFileSync(join(root, "CREDITS.md"), "utf8");

const SOURCE_DIRS: Record<string, string> = {
  commons: "assets/sources",
  local: "assets/local",
};

test("every author has a portrait entry, and every entry an author", () => {
  const slugs = manifest.portraits.map((p: { slug: string }) => p.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  expect(slugs.slice().sort()).toEqual([...authors.keys()].sort());
});

test("every portrait names a source the transcoder can reach", () => {
  for (const p of manifest.portraits) {
    const dir = SOURCE_DIRS[p.origin ?? "commons"];
    expect(dir).toBeTruthy();
    expect(p.file).toBeTruthy();
    expect(p.crop).toMatch(/^\d+x\d+\+\d+\+\d+$/);
    // A local source cannot be re-fetched, so it has to be in the repo. A
    // commons one is downloaded on demand and deliberately is not.
    if ((p.origin ?? "commons") === "local") {
      expect(existsSync(join(root, dir, p.file))).toBe(true);
    }
  }
});

test("every portrait carries the settings its transcoder reads", () => {
  for (const p of manifest.portraits) {
    const transcoder = p.transcoder ?? "halftone";
    expect(["ascii", "halftone"]).toContain(transcoder);
    if (transcoder === "ascii") {
      expect(p.threshold).toBeGreaterThan(0);
      expect(p.threshold).toBeLessThan(100);
    } else {
      expect(p.tone?.blur).toBeGreaterThanOrEqual(0);
      expect(p.tone?.black).toBeLessThan(p.tone?.white);
    }
  }
});

test("every portrait is credited, with its licence", () => {
  for (const p of manifest.portraits) {
    expect(p.credit).toBeTruthy();
    expect(p.license).toBeTruthy();
    expect(credits).toContain(p.credit);
    expect(credits).toContain(p.license);
  }
});

test("the art fits the grid the manifest says it is drawn on", () => {
  const { cols, rows } = manifest.size;
  for (const p of manifest.portraits) {
    const lines = readFileSync(join(root, "art", `${p.slug}.txt`), "utf8")
      .replace(/\n+$/, "")
      .split("\n");
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(cols);
  }
});

test("the plugin clone does not ship the portrait sources", () => {
  const install = readFileSync(join(root, "install.sh"), "utf8");
  expect(install).toContain("--exclude assets/sources");
  expect(install).toContain("--exclude assets/local");
});
