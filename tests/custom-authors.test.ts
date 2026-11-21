import { test, expect } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { root, sandbox } from "./sandbox.ts";
import { pty, SHOWS } from "./pty.ts";
import { detectImageKind, pbmToBraille, PORTRAIT_COLS, PORTRAIT_ROWS, validatePortraitArt } from "../src/portrait.ts";
import { parseAuthors } from "../src/canvas.ts";

const sampleJpeg = join(root, "assets/local/marcus.jpg");
const hasImageMagick = Boolean(Bun.which("magick") ?? Bun.which("convert"));

const gitEnv = {
  GIT_AUTHOR_NAME: "omastoic",
  GIT_AUTHOR_EMAIL: "omastoic@example.com",
  GIT_COMMITTER_NAME: "omastoic",
  GIT_COMMITTER_EMAIL: "omastoic@example.com",
};

/** Assert stderr before exit code so CI logs always surface the failure message. */
function expectOk(result: { stdout: string; stderr: string; code: number }, label?: string): void {
  expect(result.stderr, label).toBe("");
  expect(result.code, label).toBe(0);
}

/** Build a real valid grayscale PNG in pure TS so tests never depend on an image generator. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      raw[y * (width + 1) + 1 + x] = pixel(x, y);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writePortraitPng(path: string): void {
  // Light-paper drawing silhouette (corners near white).
  const png = makePng(68, 80, (x, y) => {
    const dx = x - 34;
    const dy = y - 34;
    const head = dx * dx + dy * dy < 20 * 20;
    const shoulders = y >= 54 && y <= 76 && Math.abs(x - 34) < 26;
    return head || shoulders ? 20 : 250;
  });
  writeFileSync(path, png);
}

function writePhotoPng(path: string): void {
  // Dark-background photograph-style portrait (lit face on a dark backdrop).
  const png = makePng(120, 140, (x, y) => {
    const dx = x - 60;
    const dy = y - 54;
    const inFace = (dx * dx) / (28 * 28) + (dy * dy) / (36 * 36) <= 1;
    const leftEye = (x - 49) * (x - 49) + (y - 48) * (y - 48) <= 16;
    const rightEye = (x - 71) * (x - 71) + (y - 48) * (y - 48) <= 16;
    if (leftEye || rightEye) return 35;
    if (inFace) return Math.max(80, Math.min(220, Math.round(205 - Math.hypot(dx, dy) * 2)));
    const inShoulders = y >= 92 && Math.abs(dx) <= 46;
    if (inShoulders) return 95;
    return 42;
  });
  writeFileSync(path, png);
}

function writeBlankPng(path: string): void {
  writeFileSync(path, makePng(32, 32, () => 255));
}

test("portrait helpers detect JPEG/PNG, encode PBM to braille, and enforce 34x20 bounds", () => {
  expect(detectImageKind(readFileSync(sampleJpeg))).toBe("jpeg");
  expect(detectImageKind(makePng(8, 8, () => 0))).toBe("png");
  expect(detectImageKind(Buffer.from("<svg></svg>"))).toBeNull();
  expect(detectImageKind(Buffer.from("not an image"))).toBeNull();

  const pbm = "P1\n2 4\n1 0\n1 1\n0 1\n0 0\n";
  const braille = pbmToBraille(pbm);
  expect(braille).toBe(String.fromCharCode(0x2800 | 0x01 | 0x02 | 0x10 | 0x20));
  expect(validatePortraitArt(braille)).toBe(`${braille}\n`);
  expect(() => validatePortraitArt("   \n\u2800\u2800\n")).toThrow("empty portrait");
  expect(() => validatePortraitArt(`${"⣿".repeat(PORTRAIT_COLS + 1)}\n`)).toThrow("exceeds");
  expect(() => validatePortraitArt(`${Array.from({ length: PORTRAIT_ROWS + 1 }, () => "⣿").join("\n")}\n`)).toThrow("exceeds");
  expect(() => validatePortraitArt("⣿\x1b[2J\n")).toThrow("control characters");
  expect(() => validatePortraitArt("⣿\t⣿\n")).toThrow("control characters");
});

test("parseAuthors rejects control characters, invalid slugs, reserved slugs, and overlong fields", () => {
  expect(parseAuthors("musonius\tMusonius Rufus\tc. AD 30 – 100\n").get("musonius")).toEqual({
    slug: "musonius",
    name: "Musonius Rufus",
    dates: "c. AD 30 – 100",
  });
  expect(parseAuthors("musonius\tMusonius Rufus\t\n").get("musonius")?.dates).toBe("");
  expect(() => parseAuthors("Marcus\tMarcus\t\n")).toThrow("slug");
  expect(() => parseAuthors("all\tEveryone\t\n")).toThrow("slug");
  expect(() => parseAuthors("musonius\tMusonius\x1b[2J\t\n")).toThrow("control");
  expect(() => parseAuthors(`musonius\t${"a".repeat(129)}\t\n`)).toThrow("too long");
});

test("config --add-author adds a JPEG author under ~/.config/omastoic/ without touching the plugin tree", async () => {
  const s = sandbox();
  const bundledAuthorsBefore = readFileSync(join(root, "data/authors.tsv"), "utf8");
  const bundledQuotesBefore = readFileSync(join(root, "data/quotes.tsv"), "utf8");
  try {
    const added = await s.cli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates", "c. AD 30 – 100",
      "--image", sampleJpeg,
      "--add", "musonius\tLectures VI\tWe will train both soul and body.",
    ]);
    expectOk(added, "config --add-author JPEG");
    expect(added.stdout).toContain("added author Musonius Rufus (musonius)");
    expect(added.stdout).toContain("all 7");

    // Plugin checkout is untouched.
    expect(readFileSync(join(root, "data/authors.tsv"), "utf8")).toBe(bundledAuthorsBefore);
    expect(readFileSync(join(root, "data/quotes.tsv"), "utf8")).toBe(bundledQuotesBefore);
    expect(existsSync(join(root, "art/musonius.txt"))).toBe(false);

    // Everything lives under ~/.config/omastoic/.
    const userAuthors = readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8");
    expect(userAuthors).toContain("musonius\tMusonius Rufus\tc. AD 30 – 100\n");
    const userQuotes = readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8");
    expect(userQuotes).toContain("musonius\tLectures VI\tWe will train both soul and body.\n");
    const artPath = join(s.config, "omastoic/art/musonius.txt");
    expect(existsSync(artPath)).toBe(true);
    const artLines = readFileSync(artPath, "utf8").replace(/\n+$/, "").split("\n");
    expect(artLines.length).toBeGreaterThan(0);
    expect(artLines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...artLines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(artLines.join("")).toMatch(/[\u2801-\u28ff]/);

    // Author can be selected via --authors and status reports a portrait.
    const selected = await s.cli(["config", "--authors", "musonius"]);
    expectOk(selected, "config --authors musonius");
    expect(selected.stdout).toContain("Musonius Rufus");

    const status = await s.cli(["status"]);
    expectOk(status, "status");
    expect(status.stdout).toContain("1 quotes:");
    expect(status.stdout).toMatch(/Musonius Rufus\s+1\s+portrait/);

    // Screensaver canvas shows the braille portrait, display name, dates, citation, and quote.
    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expectOk(shown, "show");
    expect(shown.stdout).toMatch(/[\u2801-\u28ff]/);
    expect(shown.stdout).toContain("MUSONIUS RUFUS");
    expect(shown.stdout).toContain("c. AD 30 – 100");
    expect(shown.stdout).toContain("Lectures VI");
    expect(shown.stdout).toContain("We will train both soul and body.");

    // Appears in config --plain picker and can be selected by number 7.
    const pickedPlain = await s.exec([
      "/bin/bash", "-c",
      `printf '%b' ${JSON.stringify("7\\n\\n45\\nn\\n")} | '${process.execPath}' '${join(root, "src/cli.ts")}' config --plain`,
    ]);
    expectOk(pickedPlain, "config --plain");
    expect(pickedPlain.stdout).toContain("7 [x] Musonius Rufus");
    expect(pickedPlain.stdout).toContain("Select authors [1-7");
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({
      interval: 45,
      authors: ["musonius"],
    });
  } finally { s.cleanup(); }
});

test("PNG images, optional dates, panel state/apply, and additional quotes work end to end", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "hierocles.png");
  writePortraitPng(pngPath);
  try {
    // Add through the settings panel bridge without dates.
    const applied = await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "hierocles",
        name: "Hierocles",
        image: pngPath,
        citation: "Elements of Ethics",
        text: "Each of us is encircled by many concentric rings.",
      },
    })]);
    expectOk(applied, "panel apply addAuthor");
    const state = JSON.parse(applied.stdout);
    expect(state.authors.map((a: { slug: string }) => a.slug)).toContain("hierocles");
    const sample = state.samples.find((entry: { slug: string }) => entry.slug === "hierocles");
    expect(sample).toBeDefined();
    expect(sample.name).toBe("Hierocles");
    expect(sample.dates).toBe("");
    expect(sample.id).toBe("c01");
    expect(sample.citation).toBe("Elements of Ethics");
    expect(sample.text).toBe("Each of us is encircled by many concentric rings.");
    expect(sample.portrait).toMatch(/[\u2801-\u28ff]/);

    // Panel can select the new author and add another quote for them.
    const second = await s.cli(["panel", "apply", JSON.stringify({
      authors: ["hierocles"],
      addQuote: {
        author: "hierocles",
        citation: "On Duties",
        text: "Draw the outer circles inward.",
      },
    })]);
    expectOk(second, "panel apply addQuote");
    const afterSecond = JSON.parse(second.stdout);
    expect(afterSecond.settings.authors).toEqual(["hierocles"]);
    expect(afterSecond.customQuotes).toBe(2);

    // Canvas renders portrait, name, citation, and quote, without any stray dates line.
    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expectOk(shown, "show");
    expect(shown.stdout).toMatch(/[\u2801-\u28ff]/);
    expect(shown.stdout).toContain("HIEROCLES");

    // Status reports 2 quotes and a portrait.
    const status = await s.cli(["status"]);
    expectOk(status, "status");
    expect(status.stdout).toContain("2 quotes:");
    expect(status.stdout).toMatch(/Hierocles\s+2\s+portrait/);
  } finally { s.cleanup(); }
});

test("dark-background photo portraits use halftone vignette instead of solid-block backgrounds", async () => {
  const s = sandbox();
  const photoPath = join(s.home, "photo.png");
  writePhotoPng(photoPath);
  try {
    const added = await s.cli([
      "config",
      "--add-author", "sowell",
      "--name", "Thomas Sowell",
      "--image", photoPath,
      "--citation", "A Conflict of Visions",
      "--text", "There are no solutions, only trade-offs.",
    ]);
    expectOk(added, "config --add-author photo");
    const art = readFileSync(join(s.config, "omastoic/art/sowell.txt"), "utf8");
    const lines = art.replace(/\n+$/, "").split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    // Top-left corner of the vignette must not be solid-block ink.
    expect(lines[0]!.startsWith("⣿")).toBe(false);
    expect(art).toMatch(/[\u2801-\u28ff]/);
  } finally { s.cleanup(); }
});

test("bundled slug collisions and unusable images fail clearly and leave nothing half-written", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "valid.png");
  const textFile = join(s.home, "fake.png");
  const svgFile = join(s.home, "vector.svg");
  const corruptJpeg = join(s.home, "corrupt.jpg");
  const blankPng = join(s.home, "blank.png");
  writePortraitPng(pngPath);
  writeFileSync(textFile, "not a png at all\n");
  writeFileSync(svgFile, "<svg xmlns='http://www.w3.org/2000/svg'></svg>\n");
  writeFileSync(corruptJpeg, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]));
  writeBlankPng(blankPng);

  const authorsPath = join(s.config, "omastoic/authors.tsv");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  const artDir = join(s.config, "omastoic/art");
  try {
    // Bundled slug rejected via CLI and via panel apply.
    const bundledCli = await s.cli([
      "config",
      "--add-author", "marcus",
      "--name", "Impostor Marcus",
      "--image", pngPath,
      "--citation", "Fake I.1",
      "--text", "Should be rejected.",
    ]);
    expect(bundledCli.stderr).toContain("bundled author");
    expect(bundledCli.code).toBe(1);

    const bundledPanel = await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "seneca",
        name: "Impostor Seneca",
        image: pngPath,
        citation: "Fake I.1",
        text: "Should be rejected.",
      },
    })]);
    expect(bundledPanel.stderr).toContain("bundled author");
    expect(bundledPanel.code).toBe(1);

    // Reserved slug "all" rejected.
    const reserved = await s.cli([
      "config", "--add-author", "all", "--name", "All", "--image", pngPath,
      "--citation", "Note", "--text", "Reserved slug.",
    ]);
    expect(reserved.stderr).toContain("reserved");
    expect(reserved.code).toBe(1);

    // Missing image, non-JPEG/PNG, SVG, corrupt JPEG, blank PNG all fail cleanly.
    const badImages: Array<[string, string]> = [
      [join(s.home, "does-not-exist.jpg"), "not found"],
      [textFile, "JPEG or PNG"],
      [svgFile, "JPEG or PNG"],
      [corruptJpeg, "could not convert"],
      [blankPng, "portrait"],
    ];
    for (const [image, expected] of badImages) {
      const result = await s.cli([
        "config",
        "--add-author", "aristo",
        "--name", "Aristo of Chios",
        "--image", image,
        "--citation", "Fragment 1",
        "--text", "Virtue is the only good.",
      ]);
      expect(result.stderr.toLowerCase(), image).toContain(expected.toLowerCase());
      expect(result.stderr, image).not.toContain("omastoic-portrait-");
      expect(result.code, image).toBe(1);
    }

    // Nothing was half-written under ~/.config/omastoic/, including no empty art/ directory.
    expect(existsSync(authorsPath)).toBe(false);
    expect(existsSync(quotesPath)).toBe(false);
    expect(existsSync(artDir)).toBe(false);

    // Duplicate custom slug is also rejected cleanly.
    const created = await s.cli([
      "config", "--add-author", "aristo", "--name", "Aristo of Chios", "--image", pngPath,
      "--citation", "Fragment 1", "--text", "Virtue is the only good.",
    ]);
    expectOk(created, "add aristo");
    const duplicate = await s.cli([
      "config", "--add-author", "aristo", "--name", "Aristo Again", "--image", pngPath,
      "--citation", "Fragment 2", "--text", "Second line.",
    ]);
    expect(duplicate.stderr).toContain("already exists");
    expect(duplicate.code).toBe(1);
    expect(readFileSync(quotesPath, "utf8")).not.toContain("Second line.");
  } finally { s.cleanup(); }
});

test("interactive TTY config --add-author and author picker handle a user-added author", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "musonius.png");
  writePortraitPng(pngPath);
  try {
    const created = await pty(s, ["config", "--add-author"], [
      { marker: SHOWS.author, keys: "musonius\r" },
      { marker: "Display name: ", keys: "Musonius Rufus\r" },
      { marker: "Dates (optional): ", keys: "c. AD 30 – 100\r" },
      { marker: "Portrait image (JPEG or PNG): ", keys: `${pngPath}\r` },
      { marker: SHOWS.citation, keys: "Lectures VI\r" },
      { marker: SHOWS.text, keys: "We will train both soul and body.\x04" },
    ]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8")).toContain("musonius\tMusonius Rufus\t");
    expect(existsSync(join(s.config, "omastoic/art/musonius.txt"))).toBe(true);

    // Interactive `omastoic config` lists the 7th author and lets digit 7 toggle them.
    const picked = await pty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n7\r" },
      { marker: SHOWS.quotes, keys: "\r" },
      { marker: SHOWS.interval, keys: "\x1530\r" },
      { marker: SHOWS.confirm, keys: "n" },
    ]);
    expect(picked.stderr).toBe("");
    expect(picked.code).toBe(0);
    expect(picked.stdout).toContain("7 [ ] Musonius Rufus");
    expect(picked.stdout).toContain("Quotes from Musonius Rufus");
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({
      authors: ["musonius"],
      interval: 30,
    });
  } finally { s.cleanup(); }
}, 20000);

test("user-added author, portrait and quotes survive a plugin update and uninstall, and purge removes them", async () => {
  const s = sandbox();
  const origin = join(s.home, "origin");
  const pngPath = join(s.home, "musonius.png");
  writePortraitPng(pngPath);
  const pluginCli = (args: string[]) => s.exec([process.execPath, join(s.plugin, "src/cli.ts"), ...args]);
  const git = (args: string[]) => s.exec(["git", ...args], gitEnv);
  try {
    rmSync(origin, { recursive: true, force: true });
    mkdirSync(origin, { recursive: true });
    for (const path of ["src", "data", "art", "bin", "scripts", "completions", "manifest.json"]) {
      cpSync(join(root, path), join(origin, path), { recursive: true });
    }
    expect((await git(["init", "-b", "main", origin])).code).toBe(0);
    expect((await git(["-C", origin, "add", "."])).code).toBe(0);
    expect((await git(["-C", origin, "commit", "-m", "base"])).code).toBe(0);
    rmSync(s.plugin, { recursive: true, force: true });
    expect((await git(["clone", origin, s.plugin])).code).toBe(0);

    expectOk(await pluginCli(["setup", "--quiet"]), "setup");
    expectOk(await pluginCli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates", "c. AD 30 – 100",
      "--image", pngPath,
      "--citation", "Lectures VI",
      "--text", "Train both soul and body.",
      "--authors", "musonius",
    ]), "pluginCli --add-author");

    const authorsPath = join(s.config, "omastoic/authors.tsv");
    const artPath = join(s.config, "omastoic/art/musonius.txt");
    const quotesPath = join(s.config, "omastoic/quotes.tsv");
    const artBefore = readFileSync(artPath, "utf8");
    expect(existsSync(join(s.plugin, "art/musonius.txt"))).toBe(false);
    expect(readFileSync(join(s.plugin, "data/authors.tsv"), "utf8")).not.toContain("musonius");

    // Simulate `omarchy plugin update` (git fetch + ff-only merge + setup).
    const bundled = join(origin, "data/quotes.tsv");
    writeFileSync(bundled, `${readFileSync(bundled, "utf8")}# plugin update\n`);
    expect((await git(["-C", origin, "add", "data/quotes.tsv"])).code).toBe(0);
    expect((await git(["-C", origin, "commit", "-m", "update"])).code).toBe(0);
    expect((await git(["-C", s.plugin, "fetch", "origin"])).code).toBe(0);
    expect((await git(["-C", s.plugin, "merge", "--ff-only", "FETCH_HEAD"])).code).toBe(0);
    expectOk(await pluginCli(["setup", "--quiet"]), "post-update setup");

    expect(readFileSync(artPath, "utf8")).toBe(artBefore);
    expect(readFileSync(authorsPath, "utf8")).toContain("Musonius Rufus");
    expect(readFileSync(quotesPath, "utf8")).toContain("Train both soul and body.");
    const status = await pluginCli(["status"]);
    expectOk(status, "post-update status");
    expect(status.stdout).toMatch(/Musonius Rufus\s+1\s+portrait/);

    // Uninstall keeps user config; --purge removes it.
    expectOk(await pluginCli(["uninstall"]), "uninstall");
    expect(existsSync(artPath)).toBe(true);
    expect(existsSync(authorsPath)).toBe(true);
    expectOk(await s.cli(["uninstall", "--purge"]), "uninstall --purge");
    expect(existsSync(artPath)).toBe(false);
    expect(existsSync(authorsPath)).toBe(false);
  } finally { s.cleanup(); }
}, 20000);

test.skipIf(!hasImageMagick)("ImageMagick fallback produces a valid 34x20 portrait when omarchy-transcode-ascii is absent", async () => {
  const magick = Bun.which("magick") ?? Bun.which("convert");
  const s = sandbox();
  const pngPath = join(s.home, "fallback.png");
  writePortraitPng(pngPath);
  const isolatedBin = join(s.home, "isolated-bin");
  mkdirSync(isolatedBin, { recursive: true });
  const toolName = Bun.which("magick") ? "magick" : "convert";
  const flock = Bun.which("flock");
  const sh = Bun.which("sh");
  const bash = Bun.which("bash");
  for (const [name, target] of [[toolName, magick], ["flock", flock], ["sh", sh], ["bash", bash]] as const) {
    if (target) {
      s.put(join(isolatedBin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(join(isolatedBin, name), 0o755);
    }
  }
  try {
    const added = await s.cli(
      [
        "config",
        "--add-author", "posidonius",
        "--name", "Posidonius",
        "--image", pngPath,
        "--citation", "Fragment 18",
        "--text", "Live in contemplation of the truth and order of the whole.",
      ],
      { PATH: isolatedBin },
    );
    expectOk(added, "ImageMagick fallback");
    const art = readFileSync(join(s.config, "omastoic/art/posidonius.txt"), "utf8");
    const lines = art.replace(/\n+$/, "").split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(art).toMatch(/[\u2801-\u28ff]/);
  } finally { s.cleanup(); }
});

test("missing ImageMagick reports the missing tool and slow converters time out cleanly without holding the state lock", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "portrait.png");
  writePortraitPng(pngPath);
  const isolatedBin = join(s.home, "isolated-bin");
  mkdirSync(isolatedBin, { recursive: true });
  const flock = Bun.which("flock");
  const sh = Bun.which("sh");
  const bash = Bun.which("bash");
  for (const [name, target] of [["flock", flock], ["sh", sh], ["bash", bash]] as const) {
    if (target) {
      s.put(join(isolatedBin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(join(isolatedBin, name), 0o755);
    }
  }
  // Stub omarchy-transcode-ascii behaving as it does when magick is missing.
  s.put(join(isolatedBin, "omarchy-transcode-ascii"), "#!/bin/sh\necho \"Unable to read logo image: $1\" >&2\nexit 1\n");
  chmodSync(join(isolatedBin, "omarchy-transcode-ascii"), 0o755);
  try {
    const missingMagick = await s.cli(
      [
        "config", "--add-author", "panaetius", "--name", "Panaetius",
        "--image", pngPath, "--citation", "On Duties", "--text", "Act according to reason.",
      ],
      { PATH: isolatedBin },
    );
    expect(missingMagick.stderr).toContain("ImageMagick");
    expect(missingMagick.stderr).not.toContain("unreadable image");
    expect(missingMagick.code).toBe(1);

    // Replace stub with a slow converter and verify timeout kills it without creating state lock.
    s.put(join(isolatedBin, "omarchy-transcode-ascii"), "#!/bin/sh\nexec /bin/sleep 5\n");
    chmodSync(join(isolatedBin, "omarchy-transcode-ascii"), 0o755);
    const timedOut = await s.cli(
      [
        "config", "--add-author", "panaetius", "--name", "Panaetius",
        "--image", pngPath, "--citation", "On Duties", "--text", "Act according to reason.",
      ],
      { PATH: isolatedBin, OMASTOIC_TRANSCODE_TIMEOUT_MS: "250" },
    );
    expect(timedOut.stderr).toContain("timed out");
    expect(timedOut.code).toBe(1);
    expect(existsSync(join(s.state, "transaction.flock"))).toBe(false);
  } finally { s.cleanup(); }
});

test("review edge cases: invalid --quotes rollback, --dates missing value, custom=none vs bundled=none, tab in art, unreadable authors.tsv", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "portrait.png");
  const emptyFile = join(s.home, "empty.png");
  const dirPath = join(s.home, "a-dir");
  writePortraitPng(pngPath);
  writeFileSync(emptyFile, "");
  mkdirSync(dirPath, { recursive: true });
  try {
    // 1. --add-author with invalid --quotes leaves nothing written.
    const badCombo = await s.cli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--image", pngPath,
      "--citation", "Lectures VI",
      "--text", "Train both soul and body.",
      "--quotes", "bogus=q01",
    ]);
    expect(badCombo.stderr).toContain("unknown author");
    expect(badCombo.code).toBe(1);
    expect(existsSync(join(s.config, "omastoic/authors.tsv"))).toBe(false);
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);
    expect(existsSync(join(s.config, "omastoic/art"))).toBe(false);

    // 2. --dates with no value fails clearly.
    const emptyDates = await s.cli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates",
      "--image", pngPath,
      "--citation", "Lectures VI",
      "--text", "Train both soul and body.",
    ]);
    expect(emptyDates.stderr).toContain("--dates requires a value");
    expect(emptyDates.code).toBe(1);

    // 3. Slug boundary checks, 0-byte file, directory path, and ~/ expansion.
    for (const badSlug of ["a".repeat(65), "-leading", "_leading", "Upper"]) {
      const r = await s.cli([
        "config", "--add-author", badSlug, "--name", "Name", "--image", pngPath,
        "--citation", "Cite", "--text", "Words.",
      ]);
      expect(r.stderr, badSlug).toContain("slug");
      expect(r.code, badSlug).toBe(1);
    }
    expect((await s.cli([
      "config", "--add-author", "emptyimg", "--name", "Empty", "--image", emptyFile,
      "--citation", "Cite", "--text", "Words.",
    ])).code).toBe(1);
    expect((await s.cli([
      "config", "--add-author", "dirimg", "--name", "Dir", "--image", dirPath,
      "--citation", "Cite", "--text", "Words.",
    ])).code).toBe(1);

    const slug64 = "a".repeat(64);
    const tildeAdd = await s.cli([
      "config", "--add-author", slug64, "--name", "Long Slug", "--image", "~/portrait.png",
      "--citation", "Book I", "--text", "Sixty-four characters fit.",
    ]);
    expectOk(tildeAdd, "64-char slug with ~/");
    expect(existsSync(join(s.config, `omastoic/art/${slug64}.txt`))).toBe(true);

    // 4. --quotes marcus=none keeps main's behavior ([]), while --quotes <custom>=none uses ["c00"].
    expectOk(await s.cli(["config", "--add", "marcus\tDesk note\tCustom marcus line."]), "add custom marcus quote");
    expectOk(await s.cli(["config", "--quotes", "marcus=none", "--quotes", `${slug64}=none`]), "quotes none");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.quotes.marcus).toEqual([]);
    expect(saved.quotes[slug64]).toEqual(["c00"]);
    const status = await s.cli(["status"]);
    expectOk(status, "status after quotes none");
    expect(status.stdout).not.toContain("Long Slug");
    expect(status.stdout).toMatch(/Marcus Aurelius\s+1\s+portrait/);

    // 5. Hand-edited art with a tab falls back to no portrait instead of crashing show.
    expectOk(await s.cli(["config", "--quotes", "all", "--authors", slug64]), "select custom author");
    writeFileSync(join(s.config, `omastoic/art/${slug64}.txt`), "⣿\t⣿\n");
    const tabShow = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(tabShow.stderr).toContain("ignoring unreadable portrait");
    expect(tabShow.code).toBe(0);
    expect(tabShow.stdout).toContain("LONG SLUG");

    // 6. Unreadable authors.tsv refuses to overwrite config.json (preserving custom author).
    const configBefore = readFileSync(join(s.config, "omastoic/config.json"), "utf8");
    writeFileSync(join(s.config, "omastoic/authors.tsv"), "BAD SLUG\tBroken\t\n");
    const blocked = await s.cli(["config", "--interval", "30"]);
    expect(blocked.code).toBe(1);
    expect(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).toBe(configBefore);

    // 7. Bundled authors and art cannot be shadowed by hand-edited user files.
    writeFileSync(join(s.config, "omastoic/authors.tsv"), "marcus\tFake Marcus\t2099\n");
    writeFileSync(join(s.config, "omastoic/art/marcus.txt"), "⣿\n");
    const panelState = JSON.parse((await s.cli(["panel", "state"])).stdout);
    const marcus = panelState.samples.find((entry: { slug: string }) => entry.slug === "marcus");
    expect(marcus.name).toBe("Marcus Aurelius");
    expect(marcus.dates).not.toBe("2099");
  } finally { s.cleanup(); }
});
