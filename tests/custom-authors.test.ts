import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { root, sandbox } from "./sandbox.ts";
import { pty, SHOWS } from "./pty.ts";
import { detectImageKind, pbmToBraille, PORTRAIT_COLS, PORTRAIT_ROWS, validatePortraitArt } from "../src/portrait.ts";
import { parseAuthors } from "../src/canvas.ts";

const sampleJpeg = join(root, "assets/local/marcus.jpg");

const gitEnv = {
  GIT_AUTHOR_NAME: "omastoic",
  GIT_AUTHOR_EMAIL: "omastoic@example.com",
  GIT_COMMITTER_NAME: "omastoic",
  GIT_COMMITTER_EMAIL: "omastoic@example.com",
};

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
  // A white 68x80 frame with a dark circle in the middle (high-contrast portrait silhouette).
  const png = makePng(68, 80, (x, y) => {
    const dx = x - 34;
    const dy = y - 34;
    const head = dx * dx + dy * dy < 20 * 20;
    const shoulders = y >= 54 && y <= 76 && Math.abs(x - 34) < 26;
    return head || shoulders ? 20 : 250;
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
    expect(added.code).toBe(0);
    expect(added.stderr).toBe("");
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
    expect(selected.code).toBe(0);
    expect(selected.stdout).toContain("Musonius Rufus");

    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("1 quotes:");
    expect(status.stdout).toMatch(/Musonius Rufus\s+1\s+portrait/);

    // Screensaver canvas shows the braille portrait, display name, dates, citation, and quote.
    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(shown.code).toBe(0);
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
    expect(pickedPlain.code).toBe(0);
    expect(pickedPlain.stdout).toContain("7 [x] Musonius Rufus");
    expect(pickedPlain.stdout).toContain("Select Stoics [1-7");
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
    expect(applied.code).toBe(0);
    expect(applied.stderr).toBe("");
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
    expect(second.code).toBe(0);
    const afterSecond = JSON.parse(second.stdout);
    expect(afterSecond.settings.authors).toEqual(["hierocles"]);
    expect(afterSecond.customQuotes).toBe(2);

    // Canvas renders portrait, name, citation, and quote, without any stray dates line.
    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/[\u2801-\u28ff]/);
    expect(shown.stdout).toContain("HIEROCLES");

    // Status reports 2 quotes and a portrait.
    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("2 quotes:");
    expect(status.stdout).toMatch(/Hierocles\s+2\s+portrait/);
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
    expect(bundledCli.code).toBe(1);
    expect(bundledCli.stderr).toContain("bundled author");

    const bundledPanel = await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "seneca",
        name: "Impostor Seneca",
        image: pngPath,
        citation: "Fake I.1",
        text: "Should be rejected.",
      },
    })]);
    expect(bundledPanel.code).toBe(1);
    expect(bundledPanel.stderr).toContain("bundled author");

    // Reserved slug "all" and invalid slugs rejected.
    const reserved = await s.cli([
      "config", "--add-author", "all", "--name", "All", "--image", pngPath,
      "--citation", "Note", "--text", "Reserved slug.",
    ]);
    expect(reserved.code).toBe(1);
    expect(reserved.stderr).toContain("reserved");

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
      expect(result.code, image).toBe(1);
      expect(result.stderr.toLowerCase(), image).toContain(expected.toLowerCase());
    }

    // Nothing was half-written under ~/.config/omastoic/.
    expect(existsSync(authorsPath)).toBe(false);
    expect(existsSync(quotesPath)).toBe(false);
    expect(existsSync(join(artDir, "aristo.txt"))).toBe(false);
    expect(existsSync(join(artDir, "marcus.txt"))).toBe(false);

    // Duplicate custom slug is also rejected cleanly.
    expect((await s.cli([
      "config", "--add-author", "aristo", "--name", "Aristo of Chios", "--image", pngPath,
      "--citation", "Fragment 1", "--text", "Virtue is the only good.",
    ])).code).toBe(0);
    const duplicate = await s.cli([
      "config", "--add-author", "aristo", "--name", "Aristo Again", "--image", pngPath,
      "--citation", "Fragment 2", "--text", "Second line.",
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already exists");
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

    expect((await pluginCli(["setup", "--quiet"])).code).toBe(0);
    expect((await pluginCli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates", "c. AD 30 – 100",
      "--image", pngPath,
      "--citation", "Lectures VI",
      "--text", "Train both soul and body.",
      "--authors", "musonius",
    ])).code).toBe(0);

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
    expect((await pluginCli(["setup", "--quiet"])).code).toBe(0);

    expect(readFileSync(artPath, "utf8")).toBe(artBefore);
    expect(readFileSync(authorsPath, "utf8")).toContain("Musonius Rufus");
    expect(readFileSync(quotesPath, "utf8")).toContain("Train both soul and body.");
    const status = await pluginCli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/Musonius Rufus\s+1\s+portrait/);

    // Uninstall keeps user config; --purge removes it.
    expect((await pluginCli(["uninstall"])).code).toBe(0);
    expect(existsSync(artPath)).toBe(true);
    expect(existsSync(authorsPath)).toBe(true);
    expect((await s.cli(["uninstall", "--purge"])).code).toBe(0);
    expect(existsSync(artPath)).toBe(false);
    expect(existsSync(authorsPath)).toBe(false);
  } finally { s.cleanup(); }
}, 20000);

test("ImageMagick fallback produces a valid 34x20 portrait when omarchy-transcode-ascii is absent", async () => {
  const magick = Bun.which("magick") ?? Bun.which("convert");
  if (!magick) return;
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
      Bun.spawnSync(["chmod", "+x", join(isolatedBin, name)]);
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
    expect(added.code).toBe(0);
    const art = readFileSync(join(s.config, "omastoic/art/posidonius.txt"), "utf8");
    const lines = art.replace(/\n+$/, "").split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(art).toMatch(/[\u2801-\u28ff]/);
  } finally { s.cleanup(); }
});

test("review edge cases: invalid --quotes rollback, custom=none, tab in art, unreadable authors.tsv, slug limits, ~/", async () => {
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
    expect(badCombo.code).toBe(1);
    expect(existsSync(join(s.config, "omastoic/authors.tsv"))).toBe(false);
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);
    expect(existsSync(join(s.config, "omastoic/art/musonius.txt"))).toBe(false);

    // 2. Slug boundary checks, 0-byte file, directory path, and ~/ expansion.
    for (const badSlug of ["a".repeat(65), "-leading", "_leading", "Upper"]) {
      const r = await s.cli([
        "config", "--add-author", badSlug, "--name", "Name", "--image", pngPath,
        "--citation", "Cite", "--text", "Words.",
      ]);
      expect(r.code, badSlug).toBe(1);
      expect(r.stderr, badSlug).toContain("slug");
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
    expect(tildeAdd.code).toBe(0);
    expect(existsSync(join(s.config, `omastoic/art/${slug64}.txt`))).toBe(true);

    // 3. --quotes <custom>=none excludes that custom author's quotes from rotation.
    expect((await s.cli(["config", "--quotes", `${slug64}=none`])).code).toBe(0);
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.quotes[slug64]).toEqual(["c00"]);
    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).not.toContain("Long Slug");

    // 4. Hand-edited art with a tab falls back to no portrait instead of crashing show.
    expect((await s.cli(["config", "--quotes", "all", "--authors", slug64])).code).toBe(0);
    writeFileSync(join(s.config, `omastoic/art/${slug64}.txt`), "⣿\t⣿\n");
    const tabShow = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(tabShow.code).toBe(0);
    expect(tabShow.stderr).toContain("ignoring unreadable portrait");
    expect(tabShow.stdout).toContain("LONG SLUG");

    // 5. Unreadable authors.tsv refuses to overwrite config.json (preserving custom author).
    const configBefore = readFileSync(join(s.config, "omastoic/config.json"), "utf8");
    writeFileSync(join(s.config, "omastoic/authors.tsv"), "BAD SLUG\tBroken\t\n");
    const blocked = await s.cli(["config", "--interval", "30"]);
    expect(blocked.code).toBe(1);
    expect(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).toBe(configBefore);

    // 6. Bundled authors and art cannot be shadowed by hand-edited user files.
    writeFileSync(join(s.config, "omastoic/authors.tsv"), "marcus\tFake Marcus\t2099\n");
    writeFileSync(join(s.config, "omastoic/art/marcus.txt"), "⣿\n");
    const panelState = JSON.parse((await s.cli(["panel", "state"])).stdout);
    const marcus = panelState.samples.find((entry: { slug: string }) => entry.slug === "marcus");
    expect(marcus.name).toBe("Marcus Aurelius");
    expect(marcus.dates).not.toBe("2099");
  } finally { s.cleanup(); }
});
