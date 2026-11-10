import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayName } from "../src/canvas.ts";
import { brailleFromPbm } from "../src/portrait.ts";
import { sandbox } from "./sandbox.ts";

test("an author outside the roster reads as a name, not a slug", () => {
  expect(displayName("tomas-sowell")).toBe("Tomas Sowell");
  expect(displayName("bell_hooks")).toBe("Bell Hooks");
  expect(displayName("x")).toBe("X");
});

test("a PBM becomes braille, one cell per 2x4 pixels, blank rows trimmed", () => {
  const pbm = "P1\n4 8\n0000\n0000\n0000\n0000\n1100\n1100\n1100\n1101\n";
  expect(brailleFromPbm(pbm)).toBe(String.fromCharCode(0x2800 + 0xff) + String.fromCharCode(0x2800 + 0x80));
  expect(() => brailleFromPbm("P4\n1 1\n")).toThrow("P1");
});

test.skipIf(!Bun.which("magick"))("portrait makes, shows and removes your own author's portrait", async () => {
  const s = sandbox();
  try {
    const image = join(s.home, "face.png");
    Bun.spawnSync(["magick", "-size", "200x240", "radial-gradient:white-black", image]);
    mkdirSync(join(s.config, "omastoic"), { recursive: true });
    writeFileSync(join(s.config, "omastoic/quotes.tsv"), "tomas-sowell\tBasic Economics\tThere are no solutions, only trade-offs.\n");
    writeFileSync(join(s.config, "omastoic/config.json"), JSON.stringify({ mineOnly: true }));

    const bare = await s.cli(["show", "--cols", "100", "--rows", "26"]);
    expect(bare.stdout).toContain("TOMAS SOWELL");
    expect(bare.stdout).not.toMatch(/[\u2801-\u28ff]/);

    const made = await s.cli(["portrait", "Tomas Sowell", image]);
    expect(made.code).toBe(0);
    const file = join(s.config, "omastoic/art/tomas-sowell.txt");
    expect(readFileSync(file, "utf8")).toMatch(/[\u2801-\u28ff]/);

    const shown = await s.cli(["show", "--cols", "100", "--rows", "26"]);
    expect(shown.stdout).toMatch(/[\u2801-\u28ff]/);
    expect(shown.stdout).toContain("TOMAS SOWELL");
    const state = JSON.parse((await s.cli(["panel", "state"])).stdout);
    expect(state.quotes.find((quote: { custom: boolean }) => quote.custom)).toMatchObject({ name: "Tomas Sowell", portrait: true });

    expect((await s.cli(["portrait", "tomas-sowell", "--remove"])).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect((await s.cli(["portrait", "tomas-sowell", join(s.home, "missing.png")])).code).toBe(1);
    expect((await s.cli(["portrait", "tomas-sowell", image, "--crop", "nonsense"])).code).toBe(1);
    expect((await s.cli(["portrait"])).code).toBe(1);
  } finally { s.cleanup(); }
});

test.skipIf(!Bun.which("magick"))("panel apply adds a quote with a picture, or neither", async () => {
  const s = sandbox();
  try {
    const image = join(s.home, "face.png");
    Bun.spawnSync(["magick", "-size", "200x240", "radial-gradient:white-black", image]);
    const quote = { author: "tomas-sowell", citation: "Basic Economics", text: "There are no solutions, only trade-offs." };

    const bad = await s.cli(["panel", "apply", JSON.stringify({ addQuote: { ...quote, image: join(s.home, "missing.png") } })]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("no image at");
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);

    const good = await s.cli(["panel", "apply", JSON.stringify({ addQuote: { ...quote, image } })]);
    expect(good.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/art/tomas-sowell.txt"), "utf8")).toMatch(/[\u2801-\u28ff]/);
    const added = JSON.parse(good.stdout).quotes.find((row: { custom: boolean }) => row.custom);
    expect(added).toMatchObject({ author: "tomas-sowell", portrait: true });
  } finally { s.cleanup(); }
});
