import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  cleanTranscodeError,
  pbmToBraille,
  pgmToBraille,
  PORTRAIT_COLS,
  PORTRAIT_ROWS,
  portraitDownscale,
  transcodePortrait,
} from "../src/portrait.ts";
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
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixel(x, y);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makePgm(width: number, height: number, pixel: (x: number, y: number) => number): string {
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.push(pixel(x, y));
  }
  return `P2\n${width} ${height}\n255\n${pixels.join(" ")}`;
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
      imBin, "-background", "white",
      "-define", `jpeg:size=${PORTRAIT_COLS * 8}x${PORTRAIT_ROWS * 16}`,
      commentedJpeg,
      "-auto-orient", "-alpha", "remove", "-alpha", "off",
      "-colorspace", "Gray",
      "-resize", `${PORTRAIT_COLS * 8}x${PORTRAIT_ROWS * 16}^>`,
      "-blur", "0x0.6",
      "-resize", `${PORTRAIT_COLS * 4}x${PORTRAIT_ROWS * 8}`,
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

test("transcodePortrait JSDoc documents the ImageMagick PGM pipeline and omarchy-transcode-ascii fallback", () => {
  const source = readFileSync(join(import.meta.dir, "../src/portrait.ts"), "utf8");
  const match = source.match(/(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*\nexport async function transcodePortrait\b/);
  expect(match).not.toBeNull();
  const doc = match![1]!;
  expect(doc).toContain("ImageMagick");
  expect(doc).toContain("PGM");
  expect(doc).toContain("pgmToBraille");
  expect(doc).toContain("omarchy-transcode-ascii");
  expect(doc).not.toContain("scripts/transcode.ts");
});

test("cleanTranscodeError limits the unreadable JPEG/PNG wording to decode failures", () => {
  // Decode failures report unreadable JPEG or PNG.
  expect(
    cleanTranscodeError(
      "magick: insufficient image data in file `/tmp/omastoic-portrait-abc/source.jpg' @ error/jpeg.c/ReadOneJPEGImage/1555.\n",
      "bad.jpg",
    ),
  ).toBe('could not convert portrait image: "bad.jpg" is not a readable JPEG or PNG image');
  expect(
    cleanTranscodeError(
      "magick: Unsupported marker type 0xb0 `/tmp/omastoic-portrait-abc/source.jpg' @ error/jpeg.c/JPEGErrorHandler/615.\n",
      "bad.jpg",
    ),
  ).toBe('could not convert portrait image: "bad.jpg" is not a readable JPEG or PNG image');
  expect(
    cleanTranscodeError(
      "magick: insufficient image data in file `/tmp/omastoic-portrait-abc/source.png' @ error/png.c/ReadPNGImage/3962.\n",
      "bad.png",
    ),
  ).toBe('could not convert portrait image: "bad.png" is not a readable JPEG or PNG image');
  expect(
    cleanTranscodeError(
      "magick: Premature end of JPEG file `/tmp/omastoic-portrait-abc/source.jpg' @ warning/jpeg.c/JPEGWarningHandler/670.\n",
      "cut.jpg",
    ),
  ).toBe('could not convert portrait image: "cut.jpg" looks damaged or truncated');

  // Non-decode failures keep a faithful reason and strip temp paths and ImageMagick internals.
  const policyErr = cleanTranscodeError(
    "magick: attempt to perform an operation not allowed by the security policy `PNG' @ error/constitute.c/IsCoderAuthorized/451.\n",
    "valid.png",
  );
  expect(policyErr).toContain("security policy");
  expect(policyErr).not.toContain("not a readable JPEG or PNG");
  expect(policyErr).not.toContain("@ error/");

  const cacheErr = cleanTranscodeError(
    "magick: Premature end of JPEG file `/tmp/omastoic-portrait-abc/source.jpg' @ warning/jpeg.c/JPEGWarningHandler/670.\n" +
      "magick: cache resources exhausted `/tmp/omastoic-portrait-abc/source.jpg' @ error/cache.c/OpenPixelCache/4044.\n",
    "photo.jpg",
  );
  expect(cacheErr).toBe('could not convert portrait image: cache resources exhausted "photo.jpg"');
  expect(cacheErr).not.toContain("omastoic-portrait-");

  const delegateErr = cleanTranscodeError(
    "convert-im6.q16: no decode delegate for this image format `JPEG' @ error/constitute.c/ReadImage/746.\n",
    "photo.jpg",
  );
  expect(delegateErr).toBe('could not convert portrait image: no decode delegate for this image format "JPEG"');

  const oomErr = cleanTranscodeError(
    "magick: Memory allocation failed `/tmp/omastoic-portrait-abc/source.png' @ error/png.c/ReadPNGImage/3962.\n",
    "huge.png",
  );
  expect(oomErr).toBe('could not convert portrait image: Memory allocation failed "huge.png"');
  expect(oomErr).not.toContain("not a readable JPEG or PNG");

  // Dimension/pixel limit failures report a dimension-limit message even from jpeg.c/png.c.
  const jpegLimitErr = cleanTranscodeError(
    "magick: width or height exceeds limit `/tmp/omastoic-portrait-abc/source.jpg' @ error/jpeg.c/ReadJPEGImage/1124.\n",
    "huge.jpg",
  );
  expect(jpegLimitErr).toBe('could not convert portrait image: "huge.jpg" dimensions exceed the image converter limit');
  expect(jpegLimitErr).not.toContain("not a readable JPEG or PNG");
  expect(jpegLimitErr).not.toContain("omastoic-portrait-");
  expect(jpegLimitErr).not.toContain("@ error/");

  const pngLimitErr = cleanTranscodeError(
    "magick: width or height exceeds limit `/tmp/omastoic-portrait-abc/source.png' @ error/png.c/ReadPNGImage/3962.\n",
    "huge.png",
  );
  expect(pngLimitErr).toBe('could not convert portrait image: "huge.png" dimensions exceed the image converter limit');

  const cacheLimitErr = cleanTranscodeError(
    "magick: width or height exceeds limit `/tmp/omastoic-portrait-abc/source.jpg' (576x864) > (10x36028797018963968) @ error/cache.c/OpenPixelCache/3813.\n",
    "huge.jpg",
  );
  expect(cacheLimitErr).toBe('could not convert portrait image: "huge.jpg" dimensions exceed the image converter limit');

  const pngIhdrLimitErr = cleanTranscodeError(
    "magick: Image width exceeds user limit in IHDR `/tmp/omastoic-portrait-abc/source.png' @ warning/png.c/MagickPNGWarningHandler/1534.\n" +
      "magick: Invalid IHDR data `/tmp/omastoic-portrait-abc/source.png' @ error/png.c/MagickPNGError/1308.\n",
    "huge.png",
  );
  expect(pngIhdrLimitErr).toBe('could not convert portrait image: "huge.png" dimensions exceed the image converter limit');
  expect(pngIhdrLimitErr).not.toContain("not a readable JPEG or PNG");

  const jpegMaxDimErr = cleanTranscodeError(
    "magick: Maximum supported image dimension is 65500 pixels `/tmp/omastoic-portrait-abc/source.jpg' @ error/jpeg.c/JPEGErrorHandler/615.\n",
    "huge.jpg",
  );
  expect(jpegMaxDimErr).toBe('could not convert portrait image: "huge.jpg" dimensions exceed the image converter limit');

  const emptyStderr = cleanTranscodeError("", "photo.png");
  expect(emptyStderr).toBe("could not convert portrait image: image converter failed");
  expect(emptyStderr).not.toContain("not a readable JPEG or PNG");

  // Existing special cases remain intact.
  expect(cleanTranscodeError("Unable to read logo image: /tmp/x/source.png\n", "a.png", true)).toContain(
    "ImageMagick (magick or convert) is not installed",
  );
  expect(cleanTranscodeError("No logo pixels found in: /tmp/x/source.png\n", "a.png", true)).toBe(
    "image produced an empty portrait",
  );
  expect(cleanTranscodeError("sh: 1: magick: command not found\n", "a.png")).toContain(
    "ImageMagick (magick or convert) is not installed",
  );
});

test("pgmToBraille keeps sparse drawings under 2% ink and rejects blank or near-blank images", () => {
  const w = 68;
  const h = 80;
  // 26 dark pixels (~0.48% ink) on white paper: below the 2% percentile cutoff.
  const sparseLight = makePgm(w, h, (x, y) =>
    (x === 34 && y >= 30 && y < 46) || (y === 38 && x >= 29 && x < 40) ? 15 : 255,
  );
  const lightArt = pgmToBraille(sparseLight);
  expect(lightArt).toMatch(/[\u2801-\u28ff]/);
  expect(lightArt.split("\n")[0]!.startsWith("⣿")).toBe(false);

  // Sparse bright marks (~0.48% ink) on a dark backdrop.
  const sparseDark = makePgm(w, h, (x, y) =>
    (x === 34 && y >= 30 && y < 46) || (y === 38 && x >= 29 && x < 40) ? 245 : 15,
  );
  const darkArt = pgmToBraille(sparseDark);
  expect(darkArt).toMatch(/[\u2801-\u28ff]/);
  expect(darkArt.split("\n")[0]!.startsWith("⣿")).toBe(false);

  // Genuine thin strokes (vertical and diagonal) under 2% ink still convert.
  const thinVertical = makePgm(w, h, (x, y) => (x === 34 && y >= 32 && y < 44 ? 15 : 255));
  expect(pgmToBraille(thinVertical)).toMatch(/[\u2801-\u28ff]/);
  const thinDiagonal = makePgm(w, h, (x, y) => (x === y && x >= 28 && x < 40 ? 15 : 255));
  expect(pgmToBraille(thinDiagonal)).toMatch(/[\u2801-\u28ff]/);

  // Blank, near-blank, and isolated dead-pixel outlier images stay empty.
  expect(pgmToBraille(makePgm(w, h, () => 255))).toBe("");
  expect(pgmToBraille(makePgm(w, h, () => 0))).toBe("");
  expect(pgmToBraille(makePgm(w, h, (x, y) => 248 + ((x * 7 + y * 13) % 8)))).toBe("");
  expect(pgmToBraille(makePgm(w, h, (x, y) => (x === 34 && y >= 30 && y < 46 ? 245 : 255)))).toBe("");
  expect(pgmToBraille(makePgm(w, h, (x, y) => (x === 34 && y === 40 ? 0 : 255)))).toBe("");
  expect(pgmToBraille(makePgm(w, h, (x, y) => (x === 34 && y === 40 ? 255 : 0)))).toBe("");
  expect(pgmToBraille(makePgm(w, h, (x, y) => ((x === 20 && y === 20) || (x === 50 && y === 60) ? 0 : 255)))).toBe("");
  expect(pgmToBraille(makePgm(w, h, (x, y) => ((x === 34 || x === 35) && y === 40 ? 0 : 255)))).toBe("");
  expect(
    pgmToBraille(
      makePgm(w, h, (x, y) => (x % 14 === 5 && y % 20 === 10 ? 0 : 255)),
    ),
  ).toBe("");
  expect(
    pgmToBraille(
      makePgm(w, h, (x, y) => (x === 34 && y === 40 ? 235 : 248 + ((x * 7 + y * 13) % 8))),
    ),
  ).toBe("");
  // Near-blank 6-level gradient with 6 isolated bright specks stays empty instead of amplifying shading.
  const hotSpecks = new Set(["5,5", "20,10", "50,12", "12,60", "60,70", "35,75"]);
  expect(
    pgmToBraille(
      makePgm(w, h, (x, y) => (hotSpecks.has(`${x},${y}`) ? 255 : (y < 40 ? 232 : 238))),
    ),
  ).toBe("");
  // A genuine sparse bright cross on that same gentle gradient still converts cleanly.
  expect(
    pgmToBraille(
      makePgm(w, h, (x, y) =>
        (x === 34 && y >= 30 && y < 46) || (y === 38 && x >= 29 && x < 40)
          ? 255
          : (y < 40 ? 232 : 238),
      ),
    ),
  ).toMatch(/[\u2801-\u28ff]/);

  // Small PGMs and symmetric percentile tails reject 1-2 isolated dark or bright pixels alike.
  expect(pgmToBraille(makePgm(7, 7, (x, y) => (x === 3 && y === 3 ? 0 : 255)))).toBe("");
  expect(pgmToBraille(makePgm(7, 7, (x, y) => (x === 3 && y === 3 ? 255 : 0)))).toBe("");
  expect(pgmToBraille(makePgm(5, 10, (x, y) => (x === 2 && y === 5 ? 0 : 255)))).toBe("");
  expect(pgmToBraille(makePgm(5, 10, (x, y) => (x === 2 && y === 5 ? 255 : 0)))).toBe("");
  expect(
    pgmToBraille(makePgm(10, 10, (x, y) => ((x === 2 && y === 2) || (x === 7 && y === 7) ? 0 : 255))),
  ).toBe("");
  expect(
    pgmToBraille(makePgm(10, 10, (x, y) => ((x === 2 && y === 2) || (x === 7 && y === 7) ? 255 : 0))),
  ).toBe("");
});

test.skipIf(!hasImageMagick)("transcodePortrait keeps sparse PNG drawings under 2% ink and rejects blank or dead-pixel images", async () => {
  const imBin = (Bun.which("magick") ?? Bun.which("convert"))!;
  const s = sandbox();
  const sparsePng = join(s.home, "sparse.png");
  const sparseDarkPng = join(s.home, "sparse-dark.png");
  const thinStrokePng = join(s.home, "thin-stroke.png");
  const smallSparsePng = join(s.home, "small-sparse-32.png");
  const blankPng = join(s.home, "blank.png");
  const nearBlankPng = join(s.home, "near-blank.png");
  const deadPixelPng = join(s.home, "dead-pixel.png");
  const brightDeadPixelPng = join(s.home, "bright-dead-pixel.png");
  const twoDotsPng = join(s.home, "two-dots.png");
  const twoAdjacentDotsPng = join(s.home, "two-adjacent-dots.png");
  const smallDead8Png = join(s.home, "dead-8.png");
  const smallDead16Png = join(s.home, "dead-16.png");
  const smallDead32Png = join(s.home, "dead-32.png");
  const smallBrightDead32Png = join(s.home, "bright-dead-32.png");
  const smallDead48TwoAdjPng = join(s.home, "dead-48-2adj.png");
  const smallDead52Png = join(s.home, "dead-52.png");
  const smallDead60TwoAdjPng = join(s.home, "dead-60-2adj.png");
  const smallDead32Jpg = join(s.home, "dead-32.jpg");
  writeFileSync(
    sparsePng,
    makePng(68, 80, (x, y) =>
      (x === 34 && y >= 30 && y < 45) || (y === 37 && x >= 29 && x < 40) ? 0 : 255,
    ),
  );
  writeFileSync(
    sparseDarkPng,
    makePng(68, 80, (x, y) =>
      (x === 34 && y >= 30 && y < 45) || (y === 37 && x >= 29 && x < 40) ? 255 : 0,
    ),
  );
  writeFileSync(
    thinStrokePng,
    makePng(68, 80, (x, y) => (x === 34 && y >= 30 && y < 42 ? 0 : 255)),
  );
  writeFileSync(
    smallSparsePng,
    makePng(32, 32, (x, y) => (x === 16 && y >= 11 && y < 21 ? 0 : 255)),
  );
  writeFileSync(blankPng, makePng(68, 80, () => 255));
  writeFileSync(nearBlankPng, makePng(68, 80, (x, y) => 248 + ((x * 7 + y * 13) % 8)));
  writeFileSync(deadPixelPng, makePng(68, 80, (x, y) => (x === 34 && y === 40 ? 0 : 255)));
  writeFileSync(brightDeadPixelPng, makePng(68, 80, (x, y) => (x === 34 && y === 40 ? 255 : 0)));
  writeFileSync(
    twoDotsPng,
    makePng(68, 80, (x, y) => ((x === 20 && y === 20) || (x === 50 && y === 60) ? 0 : 255)),
  );
  writeFileSync(
    twoAdjacentDotsPng,
    makePng(68, 80, (x, y) => ((x === 34 || x === 35) && y === 40 ? 0 : 255)),
  );
  writeFileSync(smallDead8Png, makePng(8, 8, (x, y) => (x === 4 && y === 4 ? 0 : 255)));
  writeFileSync(smallDead16Png, makePng(16, 16, (x, y) => (x === 8 && y === 8 ? 0 : 255)));
  writeFileSync(smallDead32Png, makePng(32, 32, (x, y) => (x === 16 && y === 16 ? 0 : 255)));
  writeFileSync(smallBrightDead32Png, makePng(32, 32, (x, y) => (x === 16 && y === 16 ? 255 : 0)));
  writeFileSync(
    smallDead48TwoAdjPng,
    makePng(48, 48, (x, y) => ((x === 24 || x === 25) && y === 24 ? 0 : 255)),
  );
  writeFileSync(smallDead52Png, makePng(52, 52, (x, y) => (x === 26 && y === 26 ? 0 : 255)));
  writeFileSync(
    smallDead60TwoAdjPng,
    makePng(60, 60, (x, y) => ((x === 30 || x === 31) && y === 30 ? 0 : 255)),
  );
  const jpgGen = Bun.spawnSync([imBin, smallDead32Png, "-quality", "92", smallDead32Jpg]);
  expect(jpgGen.exitCode).toBe(0);
  try {
    for (const drawing of [sparsePng, sparseDarkPng, thinStrokePng, smallSparsePng]) {
      const art = await transcodePortrait(drawing);
      const lines = art.replace(/\n+$/, "").split("\n");
      expect(art).toMatch(/[\u2801-\u28ff]/);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
      expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    }

    for (const emptyInput of [
      blankPng,
      nearBlankPng,
      deadPixelPng,
      brightDeadPixelPng,
      twoDotsPng,
      twoAdjacentDotsPng,
      smallDead8Png,
      smallDead16Png,
      smallDead32Png,
      smallBrightDead32Png,
      smallDead48TwoAdjPng,
      smallDead52Png,
      smallDead60TwoAdjPng,
      smallDead32Jpg,
    ]) {
      await expect(transcodePortrait(emptyInput)).rejects.toThrow("image produced an empty portrait");
    }
  } finally {
    s.cleanup();
  }
}, 20000);

test("non-decode converter failures report a faithful reason instead of blaming JPEG/PNG readability", async () => {
  const s = sandbox();
  const validPng = join(s.home, "valid.png");
  const corruptPng = join(s.home, "corrupt.png");
  writeFileSync(
    validPng,
    makePng(68, 80, (x, y) => ((x - 34) ** 2 + (y - 34) ** 2 < 20 ** 2 ? 20 : 250)),
  );
  writeFileSync(corruptPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

  const isolatedBin = join(s.home, "isolated-bin");
  mkdirSync(isolatedBin, { recursive: true });
  for (const [name, target] of [
    ["flock", Bun.which("flock")],
    ["sh", Bun.which("sh")],
    ["bash", Bun.which("bash")],
  ] as const) {
    if (target) {
      s.put(join(isolatedBin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(join(isolatedBin, name), 0o755);
    }
  }
  try {
    // 1. Non-decode ImageMagick failure on a valid PNG (e.g. cache resources exhausted).
    s.put(
      join(isolatedBin, "magick"),
      '#!/bin/sh\nprintf "magick: cache resources exhausted \\`%s\' @ error/cache.c/OpenPixelCache/4044.\\n" "$3" >&2\nexit 1\n',
    );
    chmodSync(join(isolatedBin, "magick"), 0o755);
    const cacheErr = await s.cli(
      [
        "config", "--add-author", "hecaton", "--name", "Hecaton of Rhodes",
        "--image", validPng, "--citation", "On Duties", "--text", "Cease to hope and you will cease to fear.",
      ],
      { PATH: isolatedBin },
    );
    expect(cacheErr.code).toBe(1);
    expect(cacheErr.stderr).toContain("cache resources exhausted");
    expect(cacheErr.stderr).not.toContain("not a readable JPEG or PNG");
    expect(cacheErr.stderr).not.toContain("omastoic-portrait-");
    expect(cacheErr.stderr).not.toContain("@ error/");

    // 1b. ImageMagick dimension-limit failure emitted from jpeg.c reports a dimension limit error.
    s.put(
      join(isolatedBin, "magick"),
      '#!/bin/sh\nprintf "magick: width or height exceeds limit \\`%s\' @ error/jpeg.c/ReadJPEGImage/1124.\\n" "$3" >&2\nexit 1\n',
    );
    chmodSync(join(isolatedBin, "magick"), 0o755);
    const limitErr = await s.cli(
      [
        "config", "--add-author", "hecaton", "--name", "Hecaton of Rhodes",
        "--image", validPng, "--citation", "On Duties", "--text", "Cease to hope and you will cease to fear.",
      ],
      { PATH: isolatedBin },
    );
    expect(limitErr.code).toBe(1);
    expect(limitErr.stderr).toContain("dimensions exceed the image converter limit");
    expect(limitErr.stderr).not.toContain("not a readable JPEG or PNG");
    expect(limitErr.stderr).not.toContain("omastoic-portrait-");
    expect(limitErr.stderr).not.toContain("@ error/");

    // 2. Non-decode omarchy-transcode-ascii failure when ImageMagick is absent.
    const fallbackBin = join(s.home, "fallback-bin");
    mkdirSync(fallbackBin, { recursive: true });
    for (const [name, target] of [
      ["flock", Bun.which("flock")],
      ["sh", Bun.which("sh")],
      ["bash", Bun.which("bash")],
    ] as const) {
      if (target) {
        s.put(join(fallbackBin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
        chmodSync(join(fallbackBin, name), 0o755);
      }
    }
    s.put(
      join(fallbackBin, "omarchy-transcode-ascii"),
      `#!/bin/sh\necho "Unable to convert logo image: $1" >&2\nexit 1\n`,
    );
    chmodSync(join(fallbackBin, "omarchy-transcode-ascii"), 0o755);
    const transcoderErr = await s.cli(
      [
        "config", "--add-author", "hecaton", "--name", "Hecaton of Rhodes",
        "--image", validPng, "--citation", "On Duties", "--text", "Cease to hope and you will cease to fear.",
      ],
      { PATH: fallbackBin },
    );
    expect(transcoderErr.code).toBe(1);
    expect(transcoderErr.stderr).toContain("Unable to convert logo image");
    expect(transcoderErr.stderr).not.toContain("not a readable JPEG or PNG");
    expect(transcoderErr.stderr).not.toContain("omastoic-portrait-");

    // 3. Real corrupt PNG still reports a JPEG/PNG readability failure.
    if (hasImageMagick) {
      const decodeErr = await s.cli([
        "config", "--add-author", "hecaton", "--name", "Hecaton of Rhodes",
        "--image", corruptPng, "--citation", "On Duties", "--text", "Cease to hope and you will cease to fear.",
      ]);
      expect(decodeErr.code).toBe(1);
      expect(decodeErr.stderr).toContain("not a readable JPEG or PNG image");
      expect(decodeErr.stderr).not.toContain("omastoic-portrait-");
      expect(decodeErr.stderr).not.toContain("@ error/");
    }
  } finally {
    s.cleanup();
  }
}, 20000);

test("ImageMagick transcode passes jpeg:size before input for JPEGs only and resizes before blur", async () => {
  const s = sandbox();
  const sampleJpg = join(root, "assets/local/marcus.jpg");
  const samplePng = join(s.home, "sample.png");
  writeFileSync(
    samplePng,
    makePng(68, 80, (x, y) => ((x - 34) ** 2 + (y - 34) ** 2 < 20 ** 2 ? 20 : 250)),
  );

  const argsLog = join(s.home, "magick-args.log");
  const callCount = join(s.home, "magick-calls.txt");
  const fakeBin = join(s.home, "fake-im-bin");
  mkdirSync(fakeBin, { recursive: true });
  for (const [name, target] of [
    ["flock", Bun.which("flock")],
    ["sh", Bun.which("sh")],
    ["bash", Bun.which("bash")],
    ["cat", Bun.which("cat")],
  ] as const) {
    if (target) {
      s.put(join(fakeBin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
      chmodSync(join(fakeBin, name), 0o755);
    }
  }
  const blankPgm = makePgm(16, 16, () => 255);
  const portraitPgm = makePgm(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? 20 : 240));
  s.put(join(s.home, "blank.pgm"), blankPgm);
  s.put(join(s.home, "portrait.pgm"), portraitPgm);
  s.put(
    join(fakeBin, "magick"),
    `#!/bin/sh
printf '%s\\0' "$@" >> "${argsLog}"
printf '\\n---END---\\n' >> "${argsLog}"
n=0
[ -f "${callCount}" ] && n=$(cat "${callCount}")
n=$((n + 1))
printf '%s' "$n" > "${callCount}"
if [ "\${FAKE_BLANK_FIRST:-0}" = "1" ] && [ "$n" -eq 1 ]; then
  cat "${join(s.home, "blank.pgm")}"
else
  cat "${join(s.home, "portrait.pgm")}"
fi
`,
  );
  chmodSync(join(fakeBin, "magick"), 0o755);

  const readCalls = () =>
    readFileSync(argsLog, "utf8")
      .split("\n---END---\n")
      .filter(Boolean)
      .map((entry) => entry.split("\0").filter(Boolean));

  try {
    // 1. JPEG primary + fallback pass: both hint jpeg:size before input and resize before blur.
    const jpgRun = await s.cli(
      [
        "config", "--add-author", "rufus", "--name", "Musonius Rufus",
        "--image", sampleJpg, "--citation", "Lectures VI", "--text", "Train both soul and body.",
      ],
      { PATH: fakeBin, FAKE_BLANK_FIRST: "1" },
    );
    expect(jpgRun.stderr).toBe("");
    expect(jpgRun.code).toBe(0);

    const jpgCalls = readCalls();
    expect(jpgCalls).toHaveLength(2);
    const expectedDims = [
      [PORTRAIT_COLS * 4, PORTRAIT_ROWS * 8],
      [PORTRAIT_COLS * 2, PORTRAIT_ROWS * 4],
    ] as const;
    for (const [idx, [w, h]] of expectedDims.entries()) {
      const argv = jpgCalls[idx]!;
      const defineIdx = argv.indexOf("-define");
      const inputIdx = argv.findIndex((arg) => arg.endsWith("/source.jpg"));
      const preResizeIdx = argv.indexOf("-resize");
      const blurIdx = argv.indexOf("-blur");
      const finalResizeIdx = argv.indexOf("-resize", blurIdx + 1);
      expect(defineIdx).toBeGreaterThanOrEqual(0);
      expect(argv[defineIdx + 1]).toBe(`jpeg:size=${w * 2}x${h * 2}`);
      expect(inputIdx).toBeGreaterThan(defineIdx + 1);
      expect(preResizeIdx).toBeGreaterThan(inputIdx);
      expect(argv[preResizeIdx + 1]).toBe(`${w * 2}x${h * 2}^>`);
      expect(blurIdx).toBeGreaterThan(preResizeIdx + 1);
      expect(argv[blurIdx + 1]).toBe("0x0.6");
      expect(finalResizeIdx).toBeGreaterThan(blurIdx + 1);
      expect(argv[finalResizeIdx + 1]).toBe(`${w}x${h}`);
    }

    // 2. PNG pass: no jpeg:size hint, and resize still precedes blur.
    writeFileSync(argsLog, "");
    writeFileSync(callCount, "0");
    const pngRun = await s.cli(
      [
        "config", "--add-author", "posidonius", "--name", "Posidonius",
        "--image", samplePng, "--citation", "Fragment 1", "--text", "Reason guides.",
      ],
      { PATH: fakeBin },
    );
    expect(pngRun.stderr).toBe("");
    expect(pngRun.code).toBe(0);

    const pngCalls = readCalls();
    expect(pngCalls).toHaveLength(1);
    const pngArgv = pngCalls[0]!;
    expect(pngArgv).not.toContain("-define");
    expect(pngArgv.some((arg) => arg.includes("jpeg:size"))).toBe(false);
    const pngInputIdx = pngArgv.findIndex((arg) => arg.endsWith("/source.png"));
    const pngPreResizeIdx = pngArgv.indexOf("-resize");
    const pngBlurIdx = pngArgv.indexOf("-blur");
    const pngFinalResizeIdx = pngArgv.indexOf("-resize", pngBlurIdx + 1);
    expect(pngInputIdx).toBeGreaterThanOrEqual(0);
    expect(pngPreResizeIdx).toBeGreaterThan(pngInputIdx);
    expect(pngArgv[pngPreResizeIdx + 1]).toBe(`${PORTRAIT_COLS * 8}x${PORTRAIT_ROWS * 16}^>`);
    expect(pngBlurIdx).toBeGreaterThan(pngPreResizeIdx + 1);
    expect(pngFinalResizeIdx).toBeGreaterThan(pngBlurIdx + 1);
    expect(pngArgv[pngFinalResizeIdx + 1]).toBe(`${PORTRAIT_COLS * 4}x${PORTRAIT_ROWS * 8}`);
  } finally {
    s.cleanup();
  }
}, 20000);

test.skipIf(!hasImageMagick)("transcodePortrait handles a ~6 MB 5990x7300 JPEG in under 5 s and keeps bundled JPEGs valid", async () => {
  const imBin = (Bun.which("magick") ?? Bun.which("convert"))!;
  const s = sandbox();
  const largeJpg = join(s.home, "large-5990x7300.jpg");
  try {
    // Tile a small portrait with noise into a 5990x7300 ~6 MB JPEG quickly without committing a binary fixture.
    const gen = Bun.spawnSync([
      imBin,
      join(root, "assets/local/marcus.jpg"),
      "-resize", "5990x7300!",
      "-attenuate", "0.35",
      "+noise", "Gaussian",
      "-quality", "86",
      largeJpg,
    ]);
    expect(gen.exitCode).toBe(0);
    const sizeBytes = readFileSync(largeJpg).length;
    expect(sizeBytes).toBeGreaterThan(4 * 1024 * 1024);

    const started = performance.now();
    const art = await transcodePortrait(largeJpg);
    const elapsedMs = performance.now() - started;

    const lines = art.replace(/\n+$/, "").split("\n");
    expect(art).toMatch(/[\u2801-\u28ff]/);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
    expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    expect(elapsedMs).toBeLessThan(5000);

    for (const slug of ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"]) {
      const portrait = await transcodePortrait(join(root, "assets/local", `${slug}.jpg`));
      const pLines = portrait.replace(/\n+$/, "").split("\n");
      expect(portrait, slug).toMatch(/[\u2801-\u28ff]/);
      expect(pLines.length, slug).toBeLessThanOrEqual(PORTRAIT_ROWS);
      expect(Math.max(...pLines.map((line) => [...line].length)), slug).toBeLessThanOrEqual(PORTRAIT_COLS);
    }
  } finally {
    s.cleanup();
  }
}, 30000);
