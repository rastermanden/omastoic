import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pbmToBraille, pgmToBraille, PORTRAIT_COLS, PORTRAIT_ROWS, portraitDownscale } from "../src/portrait.ts";
import { root, sandbox } from "./sandbox.ts";

const hasImageMagick = Boolean(Bun.which("magick") ?? Bun.which("convert"));

/** Insert a JPEG COM marker (0xFF 0xFE) immediately after the SOI marker. */
function withJpegComment(jpeg: Buffer, comment: string): Buffer {
  const payload = Buffer.from(comment, "utf8");
  const length = payload.length + 2;
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xfe, (length >> 8) & 0xff, length & 0xff]),
    payload,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

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

test("pgmToBraille strips #comment\\r# lines and Netpbm comments per spec", () => {
  const w = 16;
  const h = 16;
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) {
      row.push(x >= 4 && x < 12 && y >= 4 && y < 12 ? 20 : 240);
    }
    rows.push(row.join(" "));
  }
  const body = rows.join("\n");
  const clean = pgmToBraille(`P2\n${w} ${h}\n255\n${body}\n`);
  expect(clean).toMatch(/[\u2801-\u28ff]/);

  // ImageMagick writes CRLF JPEG comment metadata as `#text\r#\n`.
  const magickComments = `P2\n#RAMSAY, Allan\r#\n# (b. 1713, Edinburgh, d. 1784, Dover)\r#\n${w} ${h}\n255\n${body}\n`;
  expect(pgmToBraille(magickComments)).toBe(clean);

  // CR-only line endings terminate comments without swallowing the next token.
  const crOnlyComment = `P2\n#cr-only comment\r${w} ${h}\n255\n${body}\n`;
  expect(pgmToBraille(crOnlyComment)).toBe(clean);

  // Inline comments, multiple hashes, Unicode line separators, pixel comments, and EOF comments.
  const specComments =
    `P2#magic\n#a # b\r\n#\n#unicode\u2028sep\n#para\u2029sep\n` +
    `${w}#width\r${h}#height\r\n255#maxval\n` +
    `${rows[0]}#first row\r${rows.slice(1).join("\n")}#eof`;
  expect(pgmToBraille(specComments)).toBe(clean);

  expect(() => pgmToBraille("P2\n#only comments\r#\n")).toThrow("invalid PGM header");
});

test("pbmToBraille strips #comment\\r# lines and Netpbm comments per spec", async () => {
  const expected = String.fromCharCode(0x2800 | 0x01 | 0x02 | 0x10 | 0x20);
  expect(pbmToBraille("P1\n2 4\n1 0\n1 1\n0 1\n0 0\n")).toBe(expected);

  const magickPbm = "P1\n#RAMSAY, Allan\r#\n# (b. 1713)\r#\n2 4\n1 0\n1 1\n0 1\n0 0\n";
  expect(pbmToBraille(magickPbm)).toBe(expected);

  const specPbm = "P1#magic\n#u\u2028sep\n#cr\r2#w\r4#h\r\n10#r0\r11#r1\n01\n00#eof";
  expect(pbmToBraille(specPbm)).toBe(expected);

  // scripts/braille.ts wraps pbmToBraille for the halftone portrait pipeline.
  const proc = Bun.spawn([process.execPath, join(root, "scripts/braille.ts")], {
    stdin: new Response(magickPbm),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout.trimEnd()).toBe(expected);
});

test.skipIf(!hasImageMagick)("config --add-author accepts a JPEG with CRLF comment metadata and matches its stripped copy", async () => {
  const imBin = (Bun.which("magick") ?? Bun.which("convert"))!;
  const s = sandbox();
  try {
    const strippedJpeg = join(s.home, "hume-stripped.jpg");
    const commentedJpeg = join(s.home, "hume-commented.jpg");
    const reStrippedJpeg = join(s.home, "hume-restripped.jpg");

    // Strip first so commentedJpeg and strippedJpeg share identical JPEG scan data
    // and differ only in the CRLF comment marker (avoiding lossy re-encode drift).
    const baseStrip = Bun.spawnSync([imBin, join(root, "assets/local/marcus.jpg"), "-strip", strippedJpeg]);
    expect(new TextDecoder().decode(baseStrip.stderr)).toBe("");
    expect(baseStrip.exitCode).toBe(0);

    writeFileSync(
      commentedJpeg,
      withJpegComment(
        readFileSync(strippedJpeg),
        "RAMSAY, Allan\r\n (b. 1713, Edinburgh, d. 1784, Dover)\r\nPortrait of David Hume",
      ),
    );

    // Confirm ImageMagick really emits `#text\r#` comments in PGM output for this fixture.
    const rawPgm = Bun.spawnSync([
      imBin, "-background", "white", commentedJpeg,
      "-auto-orient", "-alpha", "remove", "-alpha", "off",
      "-colorspace", "Gray", "-blur", "0x0.6",
      "-resize", `${PORTRAIT_COLS * 2}x${PORTRAIT_ROWS * 4}`,
      "-compress", "none", "pgm:-",
    ]);
    expect(new TextDecoder().decode(rawPgm.stderr)).toBe("");
    expect(rawPgm.exitCode).toBe(0);
    expect(new TextDecoder().decode(rawPgm.stdout.subarray(0, 200))).toContain("\r#");

    const addCommented = await s.cli([
      "config",
      "--add-author", "hume",
      "--name", "David Hume",
      "--dates", "1711 – 1776",
      "--image", commentedJpeg,
      "--citation", "An Enquiry Concerning Human Understanding, Section X",
      "--text", "A wise man proportions his belief to the evidence.",
    ]);
    expect(addCommented.stderr).toBe("");
    expect(addCommented.code).toBe(0);

    const artPath = join(s.config, "omastoic/art/hume.txt");
    expect(existsSync(artPath)).toBe(true);
    const commentedArt = readFileSync(artPath, "utf8");
    const artLines = commentedArt.replace(/\n+$/, "").split("\n");
    expect(artLines.length).toBeGreaterThan(0);
    expect(artLines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...artLines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(commentedArt).toMatch(/[\u2801-\u28ff]/);
    expect(readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8")).toContain("hume\tDavid Hume\t1711 – 1776\n");

    const addStripped = await s.cli([
      "config",
      "--add-author", "hume-stripped",
      "--name", "David Hume Stripped",
      "--dates", "1711 – 1776",
      "--image", strippedJpeg,
      "--citation", "An Enquiry Concerning Human Understanding, Section X",
      "--text", "A wise man proportions his belief to the evidence.",
    ]);
    expect(addStripped.stderr).toBe("");
    expect(addStripped.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/art/hume-stripped.txt"), "utf8")).toBe(commentedArt);

    // Also verify running `-strip` directly on the commented JPEG still succeeds.
    const reStrip = Bun.spawnSync([imBin, commentedJpeg, "-strip", reStrippedJpeg]);
    expect(new TextDecoder().decode(reStrip.stderr)).toBe("");
    expect(reStrip.exitCode).toBe(0);
    const addReStripped = await s.cli([
      "config",
      "--add-author", "hume-restripped",
      "--name", "David Hume Re-stripped",
      "--dates", "1711 – 1776",
      "--image", reStrippedJpeg,
      "--citation", "An Enquiry Concerning Human Understanding, Section X",
      "--text", "A wise man proportions his belief to the evidence.",
    ]);
    expect(addReStripped.stderr).toBe("");
    expect(addReStripped.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/art/hume-restripped.txt"), "utf8")).toMatch(/[\u2801-\u28ff]/);
  } finally {
    s.cleanup();
  }
}, 30000);
