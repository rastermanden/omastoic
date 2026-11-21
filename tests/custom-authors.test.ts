import { test, expect } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { root, sandbox } from "./sandbox.ts";
import { pty, SHOWS } from "./pty.ts";
import { detectImageKind, headerPortraitLayout, otsuThreshold, pbmToBraille, pgmToBraille, PORTRAIT_COLS, PORTRAIT_ROWS, portraitDownscale, validatePortraitArt } from "../src/portrait.ts";
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

function writeMidGreyPhotoPng(path: string): void {
  // Noisy mid-grey gradient backdrop with a lit head and dark features/shoulders.
  const png = makePng(120, 140, (x, y) => {
    const dx = x - 60;
    const dy = y - 54;
    const inFace = (dx * dx) / (26 * 26) + (dy * dy) / (34 * 34) <= 1;
    const leftEye = (x - 49) * (x - 49) + (y - 48) * (y - 48) <= 16;
    const rightEye = (x - 71) * (x - 71) + (y - 48) * (y - 48) <= 16;
    if (leftEye || rightEye) return 28;
    if (inFace) return Math.max(150, Math.min(225, Math.round(210 - Math.hypot(dx, dy) * 1.4)));
    const inShoulders = y >= 94 && Math.abs(dx) <= 46;
    if (inShoulders) return 38;
    // Mid-grey gradient + deterministic noise (112..148)
    const noise = ((x * 37 + y * 73) % 21) - 10;
    return Math.round(135 - (y / 140) * 18 + noise);
  });
  writeFileSync(path, png);
}

function writeBlankPng(path: string): void {
  writeFileSync(path, makePng(32, 32, () => 255));
}

test("portrait helpers detect JPEG/PNG, compute Otsu threshold, suppress mid-grey noise, and enforce 34x20 bounds", () => {
  expect(detectImageKind(readFileSync(sampleJpeg))).toBe("jpeg");
  expect(detectImageKind(makePng(8, 8, () => 0))).toBe("png");
  expect(detectImageKind(Buffer.from("<svg></svg>"))).toBeNull();
  expect(detectImageKind(Buffer.from("not an image"))).toBeNull();

  // Otsu separates a bimodal distribution between its two modes.
  const bimodal = [...Array.from({ length: 100 }, () => 40), ...Array.from({ length: 100 }, () => 200)];
  const split = otsuThreshold(bimodal);
  expect(split).toBeGreaterThanOrEqual(40);
  expect(split).toBeLessThan(200);

  // pgmToBraille suppresses a noisy mid-grey border while keeping a dark center subject.
  const w = 68;
  const h = 80;
  const pixels: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - 34;
      const dy = y - 34;
      if (dx * dx + dy * dy < 12 * 12) pixels.push(25);
      else pixels.push(132 + (((x * 19 + y * 31) % 15) - 7));
    }
  }
  const midGreyArt = pgmToBraille(`P2\n${w} ${h}\n255\n${pixels.join(" ")}`);
  const midGreyLines = midGreyArt.split("\n");
  expect(midGreyArt).toMatch(/[\u2801-\u28ff]/);
  // Outer corners stay blank (no mid-grey noise).
  expect(midGreyLines[0]!.startsWith("⣿")).toBe(false);
  expect(midGreyLines[0]!.startsWith(" ")).toBe(true);

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
}, 30000);

test("PNG images, optional dates, long citations, panel state/apply, and additional quotes work end to end", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "hierocles.png");
  const longCitation = "Elements of Ethics, Book IV, Section 12 — On Concentric Circles of Concern";
  writePortraitPng(pngPath);
  try {
    // Add through the settings panel bridge without dates and with a >52-char citation.
    const applied = await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "hierocles",
        name: "Hierocles",
        image: pngPath,
        citation: longCitation,
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
    expect(sample.citation).toBe(longCitation);
    expect(sample.text).toBe("Each of us is encircled by many concentric rings.");
    expect(sample.portrait).toMatch(/[\u2801-\u28ff]/);

    // Select Hierocles and verify the >52-char citation wraps instead of dropping the portrait.
    expectOk(await s.cli(["config", "--authors", "hierocles"]), "select hierocles");
    const longCiteShown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expectOk(longCiteShown, "show with long citation");
    expect(longCiteShown.stdout).toMatch(/[\u2801-\u28ff]/);
    expect(longCiteShown.stdout).toContain("HIEROCLES");
    expect(longCiteShown.stdout.replace(/[\u2800-\u28ff\s]/gu, "")).toContain(longCitation.replace(/\s/g, ""));

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
}, 30000);

test("dark-background and mid-grey photo portraits stay clean and avoid small-panel blobs", async () => {
  const s = sandbox();
  const darkPhoto = join(s.home, "dark-photo.png");
  const midGreyPhoto = join(s.home, "midgrey-photo.png");
  writePhotoPng(darkPhoto);
  writeMidGreyPhotoPng(midGreyPhoto);
  const header = headerPortraitLayout();
  try {
    const addedDark = await s.cli([
      "config",
      "--add-author", "sowell",
      "--name", "Thomas Sowell",
      "--image", darkPhoto,
      "--citation", "A Conflict of Visions",
      "--text", "There are no solutions, only trade-offs.",
    ]);
    expectOk(addedDark, "config --add-author dark photo");
    const darkArt = readFileSync(join(s.config, "omastoic/art/sowell.txt"), "utf8");
    const darkLines = darkArt.replace(/\n+$/, "").split("\n");
    expect(darkLines.length).toBeGreaterThan(0);
    expect(darkLines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...darkLines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(darkLines[0]!.startsWith("⣿")).toBe(false);
    expect(darkArt).toMatch(/[\u2801-\u28ff]/);

    const addedMid = await s.cli([
      "config",
      "--add-author", "midgrey",
      "--name", "Mid Grey",
      "--image", midGreyPhoto,
      "--citation", "Essay I",
      "--text", "Keep the background quiet.",
    ]);
    expectOk(addedMid, "config --add-author mid-grey photo");
    const midArt = readFileSync(join(s.config, "omastoic/art/midgrey.txt"), "utf8");
    const midLines = midArt.replace(/\n+$/, "").split("\n");
    expect(midLines.length).toBeGreaterThan(0);
    expect(midLines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(midLines[0]!.startsWith("⣿")).toBe(false);
    // Small panel downscale must not collapse into a solid block of full cells.
    const small = portraitDownscale(midArt, header.rows, header.cols);
    const cells = [...small.replace(/\n/g, "")];
    const solid = cells.filter((c) => c === "⣿").length;
    expect(solid).toBeLessThan(cells.length);
  } finally { s.cleanup(); }
}, 30000);

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

    // Missing image, non-JPEG/PNG, SVG, corrupt JPEG, blank PNG all fail cleanly without ImageMagick internals.
    const badImages: Array<[string, string]> = [
      [join(s.home, "does-not-exist.jpg"), "not found"],
      [textFile, "JPEG or PNG"],
      [svgFile, "JPEG or PNG"],
      [corruptJpeg, "not a readable JPEG or PNG image"],
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
      expect(result.stderr, image).not.toContain("@ error/");
      expect(result.stderr, image).not.toContain("JPEGErrorHandler");
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
}, 30000);

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
}, 30000);

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
}, 30000);

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
}, 30000);

test("config --replace-author updates portrait or selected fields, is idempotent, and rolls back on failure", async () => {
  const s = sandbox();
  const pngA = join(s.home, "portrait-a.png");
  const pngB = join(s.home, "portrait-b.png");
  const textFile = join(s.home, "fake.png");
  const corruptJpeg = join(s.home, "corrupt.jpg");
  const blankPng = join(s.home, "blank.png");
  writePortraitPng(pngA);
  writePhotoPng(pngB);
  writeFileSync(textFile, "not an image\n");
  writeFileSync(corruptJpeg, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]));
  writeBlankPng(blankPng);
  const roDir = join(s.home, "ro-quotes");

  try {
    expectOk(await s.cli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates", "c. AD 30 – 100",
      "--image", pngA,
      "--citation", "Lectures VI",
      "--text", "We will train both soul and body.",
    ]), "add musonius");
    expectOk(await s.cli([
      "config",
      "--add-author", "hierocles",
      "--name", "Hierocles",
      "--image", pngA,
      "--citation", "Elements",
      "--text", "Draw the outer circles inward.",
    ]), "add hierocles");
    expectOk(await s.cli(["config", "--add", "seneca\tDesk note\tSeneca custom line."]), "add seneca custom quote");
    expectOk(await s.cli(["config", "--quotes", "seneca=q19,c03"]), "select seneca custom quote");

    const artPath = join(s.config, "omastoic/art/musonius.txt");
    const authorsPath = join(s.config, "omastoic/authors.tsv");
    const quotesPath = join(s.config, "omastoic/quotes.tsv");
    const artBefore = readFileSync(artPath, "utf8");
    const authorsBefore = readFileSync(authorsPath, "utf8");
    const quotesBefore = readFileSync(quotesPath, "utf8");

    // Replace portrait only: name, dates, and quotes stay unchanged.
    const replacedArt = await s.cli(["config", "--replace-author", "musonius", "--image", pngB]);
    expectOk(replacedArt, "replace portrait only");
    const artAfter = readFileSync(artPath, "utf8");
    expect(artAfter).not.toBe(artBefore);
    expect(artAfter).toMatch(/[\u2801-\u28ff]/);
    const artLines = artAfter.replace(/\n+$/, "").split("\n");
    expect(artLines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...artLines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(readFileSync(authorsPath, "utf8")).toBe(authorsBefore);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesBefore);

    // Replace name and clear dates: portrait and quotes stay unchanged.
    expectOk(await s.cli([
      "config", "--replace-author", "musonius", "--name", "Gaius Musonius Rufus", "--dates", "",
    ]), "replace name and clear dates");
    expect(readFileSync(artPath, "utf8")).toBe(artAfter);
    expect(readFileSync(authorsPath, "utf8")).toContain("musonius\tGaius Musonius Rufus\t\n");
    expect(readFileSync(authorsPath, "utf8")).toContain("hierocles\tHierocles\t\n");
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesBefore);

    // Replace quotes with two --add lines: other authors' quotes and remapped config ids stay valid.
    const replaceQuotesArgs = [
      "config", "--replace-author", "musonius",
      "--add", "musonius\tLectures XI\tFirst replaced line.",
      "--add", "musonius\tLectures XII\tSecond replaced line.",
    ];
    expectOk(await s.cli(replaceQuotesArgs), "replace quotes");
    const quotesAfterReplace = readFileSync(quotesPath, "utf8");
    expect(quotesAfterReplace).not.toContain("We will train both soul and body.");
    expect(quotesAfterReplace).toContain("musonius\tLectures XI\tFirst replaced line.\n");
    expect(quotesAfterReplace).toContain("musonius\tLectures XII\tSecond replaced line.\n");
    expect(quotesAfterReplace).toContain("hierocles\tElements\tDraw the outer circles inward.\n");
    expect(quotesAfterReplace).toContain("seneca\tDesk note\tSeneca custom line.\n");
    // Seneca's custom quote shifted from c03 to c04 after musonius gained a second line.
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).quotes.seneca).toEqual(["q19", "c04"]);

    // Idempotent repeat leaves identical files.
    const authorsAfterQuotes = readFileSync(authorsPath, "utf8");
    expectOk(await s.cli(replaceQuotesArgs), "idempotent repeat replace");
    expect(readFileSync(artPath, "utf8")).toBe(artAfter);
    expect(readFileSync(authorsPath, "utf8")).toBe(authorsAfterQuotes);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesAfterReplace);

    // Failed transcodes leave previous portrait, author row, and quotes intact.
    for (const bad of [join(s.home, "missing.jpg"), textFile, corruptJpeg, blankPng]) {
      const failed = await s.cli([
        "config", "--replace-author", "musonius",
        "--name", "Should Not Land",
        "--image", bad,
        "--citation", "Broken",
        "--text", "Must not be written.",
      ]);
      expect(failed.code, bad).toBe(1);
      expect(readFileSync(artPath, "utf8")).toBe(artAfter);
      expect(readFileSync(authorsPath, "utf8")).toBe(authorsAfterQuotes);
      expect(readFileSync(quotesPath, "utf8")).toBe(quotesAfterReplace);
    }

    // Failed write mid-transaction (read-only quotes directory) rolls back art and authors.tsv too.
    mkdirSync(roDir, { recursive: true });
    const roQuotes = join(roDir, "quotes.tsv");
    writeFileSync(roQuotes, quotesAfterReplace);
    rmSync(quotesPath);
    symlinkSync(roQuotes, quotesPath);
    chmodSync(roDir, 0o555);
    const failedWrite = await s.cli([
      "config", "--replace-author", "musonius",
      "--name", "Rolled Back Name",
      "--image", pngA,
      "--citation", "Rolled Back",
      "--text", "Must roll back everything.",
    ]);
    chmodSync(roDir, 0o755);
    expect(failedWrite.code).toBe(1);
    expect(readFileSync(artPath, "utf8")).toBe(artAfter);
    expect(readFileSync(authorsPath, "utf8")).toBe(authorsAfterQuotes);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesAfterReplace);
    expect(readdirSync(join(s.config, "omastoic/art")).some((name) => name.includes(".omastoic-"))).toBe(false);
    expect(readdirSync(join(s.config, "omastoic")).some((name) => name.includes(".omastoic-"))).toBe(false);
  } finally {
    try { chmodSync(roDir, 0o755); } catch { /* may not exist */ }
    s.cleanup();
  }
}, 30000);

test("config --remove-author deletes row, quotes, art, and selection while keeping bundled and other custom authors intact", async () => {
  const s = sandbox();
  const pngPath = join(s.home, "portrait.png");
  writePortraitPng(pngPath);
  const bundledAuthorsBefore = readFileSync(join(root, "data/authors.tsv"), "utf8");
  const bundledQuotesBefore = readFileSync(join(root, "data/quotes.tsv"), "utf8");
  const bundledArtBefore = readdirSync(join(root, "art")).sort();

  try {
    // Removing from an empty config fails clearly and writes nothing.
    const missingInitial = await s.cli(["config", "--remove-author", "musonius"]);
    expect(missingInitial.code).toBe(1);
    expect(missingInitial.stderr).toContain("not a custom author");
    expect(existsSync(join(s.config, "omastoic"))).toBe(false);

    expectOk(await s.cli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates", "c. AD 30 – 100",
      "--image", pngPath,
      "--citation", "Lectures VI",
      "--text", "Musonius line.",
    ]), "add musonius");
    expectOk(await s.cli([
      "config",
      "--add-author", "hierocles",
      "--name", "Hierocles",
      "--image", pngPath,
      "--citation", "Elements",
      "--text", "Hierocles line.",
    ]), "add hierocles");
    expectOk(await s.cli(["config", "--add", "seneca\tDesk note\tSeneca custom line."]), "add seneca custom");
    expectOk(await s.cli(["config", "--authors", "marcus,musonius", "--quotes", "seneca=q19,c03"]), "select musonius and seneca c03");

    const removed = await s.cli(["config", "--remove-author", "musonius"]);
    expectOk(removed, "remove musonius");
    expect(removed.stdout).toContain("removed author Musonius Rufus (musonius)");

    // Bundled files stay untouched.
    expect(readFileSync(join(root, "data/authors.tsv"), "utf8")).toBe(bundledAuthorsBefore);
    expect(readFileSync(join(root, "data/quotes.tsv"), "utf8")).toBe(bundledQuotesBefore);
    expect(readdirSync(join(root, "art")).sort()).toEqual(bundledArtBefore);

    // Target custom author files removed; other custom author and seneca custom quote kept.
    const authorsAfter = readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8");
    const quotesAfter = readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8");
    expect(authorsAfter).not.toContain("musonius");
    expect(authorsAfter).toContain("hierocles\tHierocles");
    expect(quotesAfter).not.toContain("Musonius line.");
    expect(quotesAfter).toContain("Hierocles line.");
    expect(quotesAfter).toContain("Seneca custom line.");
    expect(existsSync(join(s.config, "omastoic/art/musonius.txt"))).toBe(false);
    expect(existsSync(join(s.config, "omastoic/art/hierocles.txt"))).toBe(true);

    // Config dropped musonius from selected authors and remapped seneca c03 -> c02.
    const savedConfig = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(savedConfig.authors).toEqual(["marcus"]);
    expect(savedConfig.quotes.seneca).toEqual(["q19", "c02"]);

    // Removing the same author again fails cleanly without touching hierocles.
    const repeatRemove = await s.cli(["config", "--remove-author", "musonius"]);
    expect(repeatRemove.code).toBe(1);
    expect(repeatRemove.stderr).toContain("not a custom author");
    expect(readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8")).toBe(authorsAfter);
    expect(existsSync(join(s.config, "omastoic/art/hierocles.txt"))).toBe(true);

    // Removing the only selected author falls back cleanly to remaining Stoics.
    expectOk(await s.cli(["config", "--authors", "hierocles"]), "select only hierocles");
    expectOk(await s.cli(["config", "--remove-author", "hierocles"]), "remove only selected author");
    expect(existsSync(join(s.config, "omastoic/art/hierocles.txt"))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).authors).toBeUndefined();
    const statusAfter = await s.cli(["status"]);
    expectOk(statusAfter, "status after removing sole selected author");
    expect(statusAfter.stdout).toContain("Marcus Aurelius");
  } finally { s.cleanup(); }
}, 30000);

test("bundled slug protection, replace hint on duplicate add, repeated --image, and flag validation", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  const pngB = join(s.home, "b.png");
  writePortraitPng(pngA);
  writePhotoPng(pngB);

  try {
    // Repeated --image is rejected before writing anything on add or replace.
    const doubleAddImg = await s.cli([
      "config", "--add-author", "musonius", "--name", "Musonius Rufus",
      "--image", pngA, "--image", pngB,
      "--citation", "Lectures VI", "--text", "Train both.",
    ]);
    expect(doubleAddImg.code).toBe(1);
    expect(doubleAddImg.stderr).toContain("--image");
    expect(existsSync(join(s.config, "omastoic/authors.tsv"))).toBe(false);

    // Add musonius cleanly, then test duplicate --add-author guidance and repeated --image on replace.
    expectOk(await s.cli([
      "config", "--add-author", "musonius", "--name", "Musonius Rufus",
      "--image", pngA, "--citation", "Lectures VI", "--text", "Train both.",
    ]), "add musonius");
    const artBefore = readFileSync(join(s.config, "omastoic/art/musonius.txt"), "utf8");

    const dupAdd = await s.cli([
      "config", "--add-author", "musonius", "--name", "Musonius Again",
      "--image", pngB, "--citation", "Lectures VII", "--text", "Second line.",
    ]);
    expect(dupAdd.code).toBe(1);
    expect(dupAdd.stderr).toContain("already exists");
    expect(dupAdd.stderr).toContain("--replace-author musonius");
    expect(readFileSync(join(s.config, "omastoic/art/musonius.txt"), "utf8")).toBe(artBefore);

    const doubleReplaceImg = await s.cli([
      "config", "--replace-author", "musonius", "--image", pngA, "--image", pngB,
    ]);
    expect(doubleReplaceImg.code).toBe(1);
    expect(doubleReplaceImg.stderr).toContain("--image");
    expect(readFileSync(join(s.config, "omastoic/art/musonius.txt"), "utf8")).toBe(artBefore);

    // Bundled slugs are rejected for replace and remove.
    const bundledReplace = await s.cli(["config", "--replace-author", "marcus", "--image", pngB]);
    expect(bundledReplace.code).toBe(1);
    expect(bundledReplace.stderr).toContain("bundled author");
    const bundledRemove = await s.cli(["config", "--remove-author", "marcus"]);
    expect(bundledRemove.code).toBe(1);
    expect(bundledRemove.stderr).toContain("bundled author");

    // Mutually exclusive / empty / invalid flag combinations fail clearly.
    expect((await s.cli(["config", "--replace-author", "musonius"])).code).toBe(1);
    expect((await s.cli(["config", "--add-author", "a", "--replace-author", "musonius", "--image", pngB])).code).toBe(1);
    expect((await s.cli(["config", "--remove-author", "musonius", "--image", pngB])).code).toBe(1);
    expect((await s.cli(["config", "--remove-author", "musonius", "--add", "marcus\tCite\tLine."])).code).toBe(1);
    const doubleAuthors = await s.cli(["config", "--authors", "marcus", "--authors", "seneca"]);
    expect(doubleAuthors.code).toBe(1);
    expect(doubleAuthors.stderr).toContain("--authors");
    const doubleInterval = await s.cli(["config", "--interval", "30", "--interval", "60"]);
    expect(doubleInterval.code).toBe(1);
    expect(doubleInterval.stderr).toContain("--interval");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
    expect(existsSync(join(s.config, "omastoic/art/musonius.txt"))).toBe(true);
  } finally { s.cleanup(); }
}, 30000);

test("panel state and panel apply replace and remove custom authors while protecting bundled Stoics", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  const pngB = join(s.home, "b.png");
  const badImg = join(s.home, "bad.png");
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  writePortraitPng(pngA);
  writePhotoPng(pngB);
  writeFileSync(badImg, "not a png\n");
  s.put(branding, "my art\n");

  try {
    expectOk(await s.cli(["setup", "--on-first", "--quiet"]), "setup");
    expectOk(await s.cli(["on"]), "on");

    // Add a custom author via panel apply.
    const added = await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "musonius",
        name: "Musonius Rufus",
        dates: "c. AD 30 – 100",
        image: pngA,
        citation: "Lectures VI",
        text: "Original panel quote.",
      },
    })]);
    expectOk(added, "panel apply addAuthor");
    const stateAfterAdd = JSON.parse(added.stdout);
    const marcusRow = stateAfterAdd.authors.find((entry: { slug: string }) => entry.slug === "marcus");
    const musoniusRow = stateAfterAdd.authors.find((entry: { slug: string }) => entry.slug === "musonius");
    const musoniusSampleBefore = stateAfterAdd.samples.find((entry: { slug: string }) => entry.slug === "musonius");
    expect(marcusRow.custom).toBe(false);
    expect(musoniusRow.custom).toBe(true);
    expect(musoniusSampleBefore.custom).toBe(true);

    // Replace portrait and name via panel apply; verify portrait changes and daemon restarts.
    s.put(join(s.home, "systemctl.log"), "");
    const replaced = await s.cli(["panel", "apply", JSON.stringify({
      replaceAuthor: {
        slug: "musonius",
        name: "C. Musonius Rufus",
        dates: "",
        image: pngB,
        citation: "Lectures IX",
        text: "Updated panel quote.",
      },
    })]);
    expectOk(replaced, "panel apply replaceAuthor");
    expect(s.log()).toContain("restart omastoic.service");
    const stateAfterReplace = JSON.parse(replaced.stdout);
    const musoniusSampleAfter = stateAfterReplace.samples.find((entry: { slug: string }) => entry.slug === "musonius");
    expect(musoniusSampleAfter.name).toBe("C. Musonius Rufus");
    expect(musoniusSampleAfter.dates).toBe("");
    expect(musoniusSampleAfter.citation).toBe("Lectures IX");
    expect(musoniusSampleAfter.text).toBe("Updated panel quote.");
    expect(musoniusSampleAfter.portrait).not.toBe(musoniusSampleBefore.portrait);

    // Failed transcode via panel apply keeps previous portrait and metadata.
    const artAfterReplace = readFileSync(join(s.config, "omastoic/art/musonius.txt"), "utf8");
    const failedReplace = await s.cli(["panel", "apply", JSON.stringify({
      replaceAuthor: { slug: "musonius", name: "Broken", image: badImg },
    })]);
    expect(failedReplace.code).toBe(1);
    expect(readFileSync(join(s.config, "omastoic/art/musonius.txt"), "utf8")).toBe(artAfterReplace);
    expect(readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8")).toContain("C. Musonius Rufus");

    // Bundled Stoic rejected for replaceAuthor and removeAuthor.
    const bundledReplace = await s.cli(["panel", "apply", JSON.stringify({
      replaceAuthor: { slug: "marcus", name: "Impostor" },
    })]);
    expect(bundledReplace.code).toBe(1);
    expect(bundledReplace.stderr).toContain("bundled author");
    const bundledRemove = await s.cli(["panel", "apply", JSON.stringify({ removeAuthor: "marcus" })]);
    expect(bundledRemove.code).toBe(1);
    expect(bundledRemove.stderr).toContain("bundled author");

    // Remove custom author via panel apply; verify files removed, state updated, and daemon restarts.
    expectOk(await s.cli(["config", "--authors", "marcus,musonius"]), "select marcus and musonius");
    s.put(join(s.home, "systemctl.log"), "");
    const removed = await s.cli(["panel", "apply", JSON.stringify({ removeAuthor: "musonius" })]);
    expectOk(removed, "panel apply removeAuthor");
    expect(s.log()).toContain("restart omastoic.service");
    const stateAfterRemove = JSON.parse(removed.stdout);
    expect(stateAfterRemove.authors.map((entry: { slug: string }) => entry.slug)).not.toContain("musonius");
    expect(stateAfterRemove.samples.map((entry: { slug: string }) => entry.slug)).not.toContain("musonius");
    expect(stateAfterRemove.settings.authors).toEqual(["marcus"]);
    expect(existsSync(join(s.config, "omastoic/art/musonius.txt"))).toBe(false);
    expect(readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8")).not.toContain("Updated panel quote.");

    // Removing unknown slug fails cleanly.
    const missingRemove = await s.cli(["panel", "apply", JSON.stringify({ removeAuthor: "musonius" })]);
    expect(missingRemove.code).toBe(1);
    expect(missingRemove.stderr).toContain("not a custom author");

    // Panel errors use UI wording rather than CLI flags or file paths.
    expectOk(await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "hierocles",
        name: "Hierocles",
        image: pngA,
        citation: "Elements",
        text: "Circle line.",
      },
    })]), "add hierocles via panel");
    const dupPanelAdd = await s.cli(["panel", "apply", JSON.stringify({
      addAuthor: {
        slug: "hierocles",
        name: "Hierocles",
        image: pngA,
        citation: "Elements",
        text: "Another line.",
      },
    })]);
    expect(dupPanelAdd.code).toBe(1);
    expect(dupPanelAdd.stderr).toContain("Edit");
    expect(dupPanelAdd.stderr).not.toContain("--replace-author");
    expect(dupPanelAdd.stderr).not.toContain("authors.tsv");

    const emptyPanelReplace = await s.cli(["panel", "apply", JSON.stringify({
      replaceAuthor: { slug: "hierocles" },
    })]);
    expect(emptyPanelReplace.code).toBe(1);
    expect(emptyPanelReplace.stderr).not.toContain("--image");
    expect(emptyPanelReplace.stderr).not.toContain("--name");
  } finally { s.cleanup(); }
}, 30000);

test("remove rollback on read-only art/ and replace rollback when config.json save fails", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  const pngB = join(s.home, "b.png");
  const roCfgDir = join(s.home, "ro-cfg");
  const artDir = join(s.config, "omastoic/art");
  writePortraitPng(pngA);
  writePhotoPng(pngB);

  try {
    expectOk(await s.cli([
      "config",
      "--add-author", "musonius",
      "--name", "Musonius Rufus",
      "--dates", "c. AD 30 – 100",
      "--image", pngA,
      "--citation", "Lectures VI",
      "--text", "Musonius initial line.",
    ]), "add musonius");
    expectOk(await s.cli(["config", "--add", "seneca\tDesk note\tSeneca custom line."]), "add seneca custom");
    expectOk(await s.cli(["config", "--authors", "marcus,musonius", "--quotes", "seneca=q19,c02"]), "save config");

    const authorsPath = join(s.config, "omastoic/authors.tsv");
    const quotesPath = join(s.config, "omastoic/quotes.tsv");
    const configPath = join(s.config, "omastoic/config.json");
    const artPath = join(artDir, "musonius.txt");

    const authorsBefore = readFileSync(authorsPath, "utf8");
    const quotesBefore = readFileSync(quotesPath, "utf8");
    const configBefore = readFileSync(configPath, "utf8");
    const artBefore = readFileSync(artPath, "utf8");

    // 1. Remove with read-only art/ fails and restores authors.tsv, quotes.tsv, config.json, and art/.
    chmodSync(artDir, 0o555);
    const failedRemove = await s.cli(["config", "--remove-author", "musonius"]);
    chmodSync(artDir, 0o755);
    expect(failedRemove.code).toBe(1);
    expect(readFileSync(authorsPath, "utf8")).toBe(authorsBefore);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesBefore);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(readFileSync(artPath, "utf8")).toBe(artBefore);

    // 2. Replace whose config.json save fails restores art, authors.tsv, quotes.tsv, and config.json.
    mkdirSync(roCfgDir, { recursive: true });
    const roCfg = join(roCfgDir, "config.json");
    writeFileSync(roCfg, configBefore);
    rmSync(configPath);
    symlinkSync(roCfg, configPath);
    chmodSync(roCfgDir, 0o555);
    const failedReplaceSave = await s.cli([
      "config", "--replace-author", "musonius",
      "--name", "Rolled Back Name",
      "--image", pngB,
      "--add", "musonius\tNew I\tFirst replacement.",
      "--add", "musonius\tNew II\tSecond replacement.",
    ]);
    chmodSync(roCfgDir, 0o755);
    expect(failedReplaceSave.code).toBe(1);
    expect(readFileSync(artPath, "utf8")).toBe(artBefore);
    expect(readFileSync(authorsPath, "utf8")).toBe(authorsBefore);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesBefore);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  } finally {
    try { chmodSync(artDir, 0o755); } catch { /* may not exist */ }
    try { chmodSync(roCfgDir, 0o755); } catch { /* may not exist */ }
    s.cleanup();
  }
}, 30000);
