/** Braille portrait encoding, transcoding, and downscaling. Display cells, not a palette. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PORTRAIT_COLS = 34;
export const PORTRAIT_ROWS = 20;
const PORTRAIT_THRESHOLD = 45;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TRANSCODE_TIMEOUT_MS = 15_000;

const DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [0x01, 0, 0],
  [0x02, 1, 0],
  [0x04, 2, 0],
  [0x40, 3, 0],
  [0x08, 0, 1],
  [0x10, 1, 1],
  [0x20, 2, 1],
  [0x80, 3, 1],
];

type Bitmap = { dots: boolean[]; width: number; height: number };

function cell(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x2800 && code <= 0x28ff ? code - 0x2800 : 0;
}

/** Ink of a braille drawing, one boolean per dot. */
function toDots(art: string): Bitmap {
  const lines = art.replace(/\n+$/, "").split("\n");
  const width = Math.max(1, ...lines.map((line) => [...line].length)) * 2;
  const height = Math.max(1, lines.length) * 4;
  const dots = Array.from({ length: height * width }, () => false);
  lines.forEach((line, row) => {
    let column = 0;
    for (const char of line) {
      const bits = cell(char);
      for (const [bit, y, x] of DOTS) {
        if (bits & bit) dots[(row * 4 + y) * width + column * 2 + x] = true;
      }
      column += 1;
    }
  });
  return { dots, width, height };
}

function inkBounds(bitmap: Bitmap): { left: number; top: number; width: number; height: number } | null {
  let left = bitmap.width;
  let right = -1;
  let top = bitmap.height;
  let bottom = -1;
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (!bitmap.dots[y * bitmap.width + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Qt draws braille from Noto Sans Symbols 2 when the UI face has none.
 * Advance is 700/1000 em. The line is 1699/1000 em.
 * Round 3 measured 24 by 18 cells at about 28 by 49 px, which is this face near 1.7 px.
 */
export const BRAILLE_ADVANCE_EM = 700 / 1000;
export const BRAILLE_LINE_EM = 1699 / 1000;
export const HEADER_SLOT_PX = 88;
export const HEADER_FONT_PX = 8;

/**
 * Cell count for a fixed legible font so the block fills the header slot.
 * A cell is 2 dots wide and 4 dots tall, so the line is two advances high
 * and the dot pitch is the same in both directions.
 */
export function headerPortraitLayout(
  slotPx = HEADER_SLOT_PX,
  fontPx = HEADER_FONT_PX,
): {
  fontPx: number;
  rows: number;
  cols: number;
  cellWidth: number;
  cellHeight: number;
  dotPitch: number;
  width: number;
  height: number;
} {
  const cellWidth = fontPx * BRAILLE_ADVANCE_EM;
  const cellHeight = cellWidth * 2;
  const cols = Math.max(1, Math.round(slotPx / cellWidth));
  const rows = Math.max(1, Math.round(slotPx / cellHeight));
  const dotPitch = cellWidth / 2;
  return {
    fontPx,
    rows,
    cols,
    cellWidth,
    cellHeight,
    dotPitch,
    width: cols * cellWidth,
    height: rows * cellHeight,
  };
}

/** Keep every cell, including blank ones, so the rendered block stays the computed size. */
export function padPortrait(art: string, rows: number, cols: number): string {
  if (art === "") return "";
  const blank = "\u2800";
  const source = art.split("\n");
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const chars = [...(source[row] ?? "")];
    while (chars.length < cols) chars.push(blank);
    lines.push(chars.slice(0, cols).join(""));
  }
  return lines.join("\n");
}

/**
 * Scale the whole drawing into `rows` by `cols` braille cells.
 * A destination dot is on when enough of the source dots under it are ink,
 * so the shape of the portrait survives instead of a window cut from the middle.
 */
export function portraitDownscale(art: string, rows: number, cols: number): string {
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) return "";
  const source = toDots(art);
  const bounds = inkBounds(source);
  if (!bounds) return "";
  const targetWidth = cols * 2;
  const targetHeight = rows * 4;
  let totalInk = 0;
  for (let y = bounds.top; y < bounds.top + bounds.height; y++) {
    for (let x = bounds.left; x < bounds.left + bounds.width; x++) {
      if (source.dots[y * source.width + x]) totalInk += 1;
    }
  }
  const density = totalInk / Math.max(1, bounds.width * bounds.height);
  // Sparse line art uses 0.28 so thin strokes survive; denser portraits raise
  // the cutoff so small header previews keep facial detail instead of blobbing.
  const cutoff = density > 0.45 ? Math.min(0.55, 0.28 + (density - 0.45) * 0.9) : 0.28;
  const scaled: boolean[] = [];
  for (let y = 0; y < targetHeight; y++) {
    const y0 = bounds.top + (y / targetHeight) * bounds.height;
    const y1 = bounds.top + ((y + 1) / targetHeight) * bounds.height;
    for (let x = 0; x < targetWidth; x++) {
      const x0 = bounds.left + (x / targetWidth) * bounds.width;
      const x1 = bounds.left + ((x + 1) / targetWidth) * bounds.width;
      let ink = 0;
      let seen = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          seen += 1;
          if (source.dots[sy * source.width + sx]) ink += 1;
        }
      }
      scaled.push(seen > 0 && ink / seen >= cutoff);
    }
  }
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      let bits = 0;
      for (const [bit, y, x] of DOTS) {
        if (scaled[(row * 4 + y) * targetWidth + col * 2 + x]) bits |= bit;
      }
      line += String.fromCodePoint(0x2800 + bits);
    }
    lines.push(line.replace(/\u2800+$/u, ""));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  while (lines.length && [...lines[0]].every((char) => cell(char) === 0)) lines.shift();
  return lines.join("\n");
}

const PBM_DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;

/** Encode an ASCII PBM (P1) bitmap into Unicode braille art. */
export function pbmToBraille(pbm: string): string {
  const tokens = pbm
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens[0] !== "P1") throw new Error("expected an ASCII PBM (P1)");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("invalid PBM dimensions");
  }
  const bits = tokens.slice(3).join("");
  const on = (x: number, y: number) => x < width && y < height && bits[y * width + x] === "1";

  const rows: string[] = [];
  for (let y = 0; y < height; y += 4) {
    let row = "";
    for (let x = 0; x < width; x += 2) {
      let code = 0;
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          if (on(x + dx, y + dy)) code |= PBM_DOTS[dx][dy];
        }
      }
      row += code === 0 ? " " : String.fromCharCode(0x2800 + code);
    }
    rows.push(row.replace(/\s+$/, ""));
  }

  while (rows.length && rows[0].trim() === "") rows.shift();
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.join("\n");
}

/** Otsu between-class variance threshold on 8-bit grayscale values (0..255). */
export function otsuThreshold(values: readonly number[]): number {
  const hist = new Uint32Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, v | 0))] += 1;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let bestVar = -1;
  let firstBest = 128;
  let lastBest = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      firstBest = t;
      lastBest = t;
    } else if (between === bestVar) {
      lastBest = t;
    }
  }
  return Math.floor((firstBest + lastBest) / 2);
}

/**
 * Convert an ASCII PGM (P2) grayscale bitmap into Unicode braille art using
 * percentile auto-contrast, Otsu thresholding, and border-aware background
 * suppression so both drawings and mid-grey/dark photos stay clean.
 */
export function pgmToBraille(pgm: string): string {
  const tokens = pgm
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens[0] !== "P2") throw new Error("expected an ASCII PGM (P2)");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maxVal = Number(tokens[3]);
  if (
    !Number.isInteger(width) || width < 1 ||
    !Number.isInteger(height) || height < 1 ||
    !Number.isInteger(maxVal) || maxVal < 1
  ) {
    throw new Error("invalid PGM header");
  }
  const count = width * height;
  if (tokens.length < 4 + count) throw new Error("incomplete PGM pixel data");

  const values: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const raw = Number(tokens[4 + i]);
    values[i] = Math.max(0, Math.min(255, Math.round((raw / maxVal) * 255)));
  }

  const sorted = [...values].sort((a, b) => a - b);
  const p2 = sorted[Math.floor(sorted.length * 0.02)]!;
  const p98 = sorted[Math.floor(sorted.length * 0.98)]!;
  const span = p98 - p2;
  if (span < 8) return "";

  const stretched = values.map((v) => Math.max(0, Math.min(255, Math.round(((v - p2) / span) * 255))));

  // Sample top, left, and right borders (bottom often holds shoulders/torso).
  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(stretched[x]!);
  const sideRows = Math.max(1, Math.floor(height * 0.75));
  for (let y = 0; y < sideRows; y++) {
    border.push(stretched[y * width]!, stretched[y * width + width - 1]!);
  }
  border.sort((a, b) => a - b);
  const borderMed = border[Math.floor(border.length / 2)]!;
  const borderSpread = border[Math.floor(border.length * 0.85)]! - border[Math.floor(border.length * 0.15)]!;

  const otsu = otsuThreshold(stretched);
  const darkBg = borderMed < otsu;
  // Push threshold outside the noisy border band so mid-grey backdrops stay blank.
  const margin = Math.max(18, Math.min(48, Math.round(borderSpread * 1.1 + 16)));
  const threshold = darkBg
    ? Math.max(otsu, Math.min(230, borderMed + margin))
    : Math.min(otsu, Math.max(25, borderMed - margin));

  const bits: string[] = new Array(count);
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(1, width * 0.48);
  const ry = Math.max(1, height * 0.48);
  for (let i = 0; i < count; i++) {
    const v = stretched[i]!;
    const x = i % width;
    const y = Math.floor(i / width);
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    if (Math.abs(v - borderMed) <= margin && nx * nx + ny * ny > 0.65) {
      bits[i] = "0";
      continue;
    }
    bits[i] = (darkBg ? v > threshold : v <= threshold) ? "1" : "0";
  }

  return pbmToBraille(`P1\n${width} ${height}\n${bits.join("")}`);
}

/** Identify JPEG or PNG from magic bytes. */
export function detectImageKind(bytes: Uint8Array): "png" | "jpeg" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** Validate converted braille art fits the 34x20 portrait budget and has ink. */
export function validatePortraitArt(raw: string, cols = PORTRAIT_COLS, rows = PORTRAIT_ROWS): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u.test(normalized)) {
    throw new Error("converted portrait contains terminal control characters");
  }
  const lines = normalized.split("\n").map((line) => line.replace(/[ \u2800]+$/u, ""));
  while (lines.length && lines[0].replace(/[ \u2800]/gu, "") === "") lines.shift();
  while (lines.length && lines[lines.length - 1].replace(/[ \u2800]/gu, "") === "") lines.pop();
  if (!lines.length || !lines.some((line) => /[\u2801-\u28ff]/u.test(line))) {
    throw new Error("image produced an empty portrait");
  }
  if (lines.length > rows || Math.max(...lines.map((line) => [...line].length)) > cols) {
    throw new Error(`converted portrait exceeds ${cols}x${rows} cells`);
  }
  return `${lines.join("\n")}\n`;
}

function expandHome(path: string): string {
  const home = process.env.HOME ?? "";
  if (home && (path === "~" || path.startsWith("~/"))) return join(home, path.slice(2));
  return path;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

const DECODE_WARNING =
  /Premature end|Corrupt (?:JPEG|PNG|image)|unexpected end[- ]of[- ]file|insufficient image data|Not a JPEG file|Invalid JPEG|incomplete image|Improper image header/i;
const HARMLESS_DECODE_WARNING =
  /Corrupt JPEG data:\s*\d+\s+extraneous bytes? before marker\b/i;

function decodeWarningLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => DECODE_WARNING.test(line) && !HARMLESS_DECODE_WARNING.test(line));
}

export function hasDecodeWarning(stderr: string): boolean {
  return decodeWarningLines(stderr).length > 0;
}

function cleanTranscodeError(
  stderr: string,
  original: string,
  missingMagick = false,
): string {
  const line = firstLine(stderr);
  if (missingMagick && (!line || /Unable to read logo image|command not found|not found/i.test(line))) {
    return "could not convert portrait image: ImageMagick (magick or convert) is not installed";
  }
  if (/No logo pixels found|geometry does not contain image/i.test(line)) {
    return "image produced an empty portrait";
  }
  if (/command not found|No such file or directory.*\b(?:magick|convert)\b/i.test(line)) {
    return "could not convert portrait image: ImageMagick (magick or convert) is not installed";
  }
  if (
    decodeWarningLines(stderr).some((entry) =>
      /Premature end|unexpected end[- ]of[- ]file|incomplete image|Corrupt (?:JPEG|PNG|image)/i.test(entry),
    )
  ) {
    return `could not convert portrait image: "${original}" looks damaged or truncated`;
  }
  return `could not convert portrait image: "${original}" is not a readable JPEG or PNG image`;
}

function transcodeTimeoutMs(override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  const fromEnv = Number(process.env.OMASTOIC_TRANSCODE_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TRANSCODE_TIMEOUT_MS;
}

async function runWithTimeout(
  cmd: string[],
  captureStdout: boolean,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutBin = Bun.which("timeout");
  const seconds = `${Math.max(0.05, timeoutMs / 1000).toFixed(3)}s`;
  const argv = timeoutBin ? [timeoutBin, "-k", "1s", seconds, ...cmd] : cmd;
  const proc = Bun.spawn(argv, {
    stdout: captureStdout ? "pipe" : "ignore",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      try { void proc.stdout?.cancel?.(); } catch { /* ignore */ }
      try { void proc.stderr?.cancel?.(); } catch { /* ignore */ }
      reject(new Error("portrait image conversion timed out"));
    }, timeoutBin ? timeoutMs + 1000 : timeoutMs);
  });
  const finished = (async () => {
    const [stdout, stderr, code] = await Promise.all([
      captureStdout && proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timeoutBin && (code === 124 || code === 137)) {
      throw new Error("portrait image conversion timed out");
    }
    return { stdout, stderr, code };
  })();
  finished.catch(() => {});
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Convert a user-supplied JPEG or PNG into a 34x20 braille portrait.
 * Light-paper drawings use Omarchy's `omarchy-transcode-ascii` (or ImageMagick
 * threshold fallback). Darker-background photographs use the halftone vignette
 * pipeline from `scripts/transcode.ts` so backgrounds do not turn into solid
 * braille blocks.
 */
export async function transcodePortrait(
  imagePath: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const trimmed = imagePath.trim();
  if (!trimmed) throw new Error("portrait image path is required");
  const resolved = expandHome(trimmed);

  let stat;
  try { stat = statSync(resolved); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`image file not found: ${trimmed}`);
    throw new Error(`could not read image: ${(error as Error).message}`);
  }
  if (!stat.isFile()) throw new Error(`image path is not a file: ${trimmed}`);
  if (stat.size === 0) throw new Error(`image file is empty: ${trimmed}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image file exceeds 20 MiB: ${trimmed}`);

  let bytes: Uint8Array;
  try { bytes = readFileSync(resolved); }
  catch (error) { throw new Error(`could not read image: ${(error as Error).message}`); }

  const kind = detectImageKind(bytes);
  if (!kind) throw new Error("portrait image must be a JPEG or PNG file");

  const timeoutMs = transcodeTimeoutMs(options.timeoutMs);
  const omarchyTranscoder = Bun.which("omarchy-transcode-ascii");
  const magickBin = Bun.which("magick");
  const convertBin = Bun.which("convert");
  const imBin = magickBin ?? convertBin;

  if (!imBin && !omarchyTranscoder) {
    throw new Error("could not convert portrait image: install omarchy-transcode-ascii or ImageMagick (magick or convert)");
  }

  const scratch = mkdtempSync(join(tmpdir(), "omastoic-portrait-"));
  try {
    const staged = join(scratch, `source.${kind === "png" ? "png" : "jpg"}`);
    writeFileSync(staged, bytes, { mode: 0o600 });

    if (imBin) {
      const deadline = Date.now() + timeoutMs;
      const runIm = (w: number, h: number) =>
        runWithTimeout(
          [
            imBin,
            "-background", "white",
            staged,
            "-auto-orient",
            "-alpha", "remove", "-alpha", "off",
            "-colorspace", "Gray",
            "-blur", "0x0.6",
            "-resize", `${w}x${h}`,
            "-compress", "none",
            "pgm:-",
          ],
          true,
          Math.max(1, deadline - Date.now()),
        );

      const result = await runIm(PORTRAIT_COLS * 4, PORTRAIT_ROWS * 8);
      if (result.code !== 0 || hasDecodeWarning(result.stderr) || !result.stdout.trim()) {
        throw new Error(cleanTranscodeError(result.stderr, trimmed));
      }
      let art = pgmToBraille(result.stdout);
      if (!art) {
        if (deadline - Date.now() <= 0) throw new Error("portrait image conversion timed out");
        const fallback = await runIm(PORTRAIT_COLS * 2, PORTRAIT_ROWS * 4);
        if (fallback.code !== 0 || hasDecodeWarning(fallback.stderr) || !fallback.stdout.trim()) {
          throw new Error(cleanTranscodeError(fallback.stderr, trimmed));
        }
        art = pgmToBraille(fallback.stdout);
      }
      return validatePortraitArt(fitPortraitToBudget(art));
    }

    const outTxt = join(scratch, "portrait.txt");
    const result = await runWithTimeout(
      [
        omarchyTranscoder!,
        staged,
        outTxt,
        "--width", String(PORTRAIT_COLS),
        "--height", String(PORTRAIT_ROWS),
        "--threshold", String(PORTRAIT_THRESHOLD),
      ],
      false,
      timeoutMs,
    );
    if (result.code !== 0 || hasDecodeWarning(result.stderr)) {
      throw new Error(cleanTranscodeError(result.stderr, trimmed, !magickBin));
    }
    let art: string;
    try { art = readFileSync(outTxt, "utf8"); }
    catch { throw new Error("could not convert portrait image: transcoder produced no output"); }
    return validatePortraitArt(fitPortraitToBudget(art));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const MIN_PORTRAIT_ASPECT = 0.55;
const MAX_PORTRAIT_ASPECT = 1.35;
const MAX_HAIRLINE_DOTS = 6;

function tightenBox(
  source: Bitmap,
  x0: number,
  y0: number,
  w: number,
  h: number,
): { left: number; top: number; width: number; height: number } | null {
  let left = x0 + w;
  let right = -1;
  let top = y0 + h;
  let bottom = -1;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!source.dots[y * source.width + x]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < left || bottom < top
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function fitPortraitToBudget(art: string): string {
  if (!art) return "";
  const source = toDots(art);
  const initial = inkBounds(source);
  if (!initial) return "";

  let box = initial;
  const hairline = Math.min(box.width, box.height) <= MAX_HAIRLINE_DOTS;

  if (!hairline) {
    for (let pass = 0; pass < 2; pass++) {
      const aspect = box.width / box.height;
      let nextLeft = box.left;
      let nextTop = box.top;
      let nextWidth = box.width;
      let nextHeight = box.height;

      if (aspect < MIN_PORTRAIT_ASPECT) {
        nextHeight = Math.max(1, Math.min(box.height, Math.round(box.width / MIN_PORTRAIT_ASPECT)));
        const rowScore = new Int32Array(box.height);
        for (let y = 0; y < box.height; y++) {
          const sy = box.top + y;
          let ink = 0;
          let transitions = 0;
          let prev = false;
          for (let x = box.left; x < box.left + box.width; x++) {
            const on = Boolean(source.dots[sy * source.width + x]);
            if (on) ink += 1;
            if (on !== prev) transitions += 1;
            prev = on;
          }
          if (prev) transitions += 1;
          rowScore[y] = ink + Math.max(0, transitions - 2) * 64;
        }
        let current = 0;
        for (let y = 0; y < nextHeight; y++) current += rowScore[y]!;
        let best = current;
        let bestY = 0;
        for (let y = 1; y <= box.height - nextHeight; y++) {
          current += rowScore[y + nextHeight - 1]! - rowScore[y - 1]!;
          if (current > best) {
            best = current;
            bestY = y;
          }
        }
        nextTop = box.top + bestY;
      } else if (aspect > MAX_PORTRAIT_ASPECT) {
        nextWidth = Math.max(1, Math.min(box.width, Math.round(box.height * MAX_PORTRAIT_ASPECT)));
        const colScore = new Int32Array(box.width);
        for (let x = 0; x < box.width; x++) {
          const sx = box.left + x;
          let ink = 0;
          let transitions = 0;
          let prev = false;
          for (let y = box.top; y < box.top + box.height; y++) {
            const on = Boolean(source.dots[y * source.width + sx]);
            if (on) ink += 1;
            if (on !== prev) transitions += 1;
            prev = on;
          }
          if (prev) transitions += 1;
          // Square column thickness so heads outscore long thin horizontal rules.
          colScore[x] = ink * ink + Math.max(0, transitions - 2) * 64;
        }
        let current = 0;
        for (let x = 0; x < nextWidth; x++) current += colScore[x]!;
        let best = current;
        let bestX = 0;
        for (let x = 1; x <= box.width - nextWidth; x++) {
          current += colScore[x + nextWidth - 1]! - colScore[x - 1]!;
          if (current > best) {
            best = current;
            bestX = x;
          }
        }
        nextLeft = box.left + bestX;
      } else {
        break;
      }

      const tightened = tightenBox(source, nextLeft, nextTop, nextWidth, nextHeight);
      if (!tightened) break;
      box = tightened;
      if (Math.min(box.width, box.height) <= 2) break;
    }
  }

  let cropInk = 0;
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      if (source.dots[y * source.width + x]) cropInk += 1;
    }
  }
  const density = cropInk / Math.max(1, box.width * box.height);
  const cutoff = density > 0.35 ? Math.min(0.5, 0.25 + (density - 0.35) * 0.8) : 0.25;

  const maxDotW = PORTRAIT_COLS * 2;
  const maxDotH = PORTRAIT_ROWS * 4;
  const rawScale = Math.min(maxDotW / box.width, maxDotH / box.height);
  const scale = hairline || Math.min(box.width, box.height) <= 3 ? Math.min(1, rawScale) : rawScale;
  const dstW = Math.max(1, Math.min(maxDotW, Math.round(box.width * scale)));
  const dstH = Math.max(1, Math.min(maxDotH, Math.round(box.height * scale)));
  const cols = Math.ceil(dstW / 2);
  const rows = Math.ceil(dstH / 4);

  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      let code = 0;
      for (const [bit, dy, dx] of DOTS) {
        const y = row * 4 + dy;
        const x = col * 2 + dx;
        if (x >= dstW || y >= dstH) continue;
        const sx0 = box.left + (x / dstW) * box.width;
        const sx1 = box.left + ((x + 1) / dstW) * box.width;
        const sy0 = box.top + (y / dstH) * box.height;
        const sy1 = box.top + ((y + 1) / dstH) * box.height;
        const ix0 = Math.floor(sx0);
        const ix1 = Math.max(ix0 + 1, Math.ceil(sx1));
        const iy0 = Math.floor(sy0);
        const iy1 = Math.max(iy0 + 1, Math.ceil(sy1));
        let on = 0;
        let seen = 0;
        for (let sy = iy0; sy < iy1 && sy < source.height; sy++) {
          for (let sx = ix0; sx < ix1 && sx < source.width; sx++) {
            seen += 1;
            if (source.dots[sy * source.width + sx]) on += 1;
          }
        }
        if (seen > 0 && on / seen >= cutoff) code |= bit;
      }
      line += code === 0 ? " " : String.fromCodePoint(0x2800 + code);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}
