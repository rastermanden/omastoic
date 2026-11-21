/** Braille portrait encoding, transcoding, and downscaling. Display cells, not a palette. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PORTRAIT_COLS = 34;
export const PORTRAIT_ROWS = 20;
const PORTRAIT_THRESHOLD = 45;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TRANSCODE_TIMEOUT_MS = 15_000;
const DRAWING_CORNER_FLOOR = 0.85;

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
      scaled.push(seen > 0 && ink / seen >= 0.28);
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

function cleanTranscodeError(
  stderr: string,
  staged: string,
  original: string,
  missingMagick = false,
): string {
  const line = firstLine(stderr);
  if (missingMagick && (!line || /Unable to read logo image|command not found|not found/i.test(line))) {
    return "could not convert portrait image: ImageMagick (magick or convert) is not installed";
  }
  if (!line) return "could not convert portrait image";
  if (/No logo pixels found/i.test(line)) return "image produced an empty portrait";
  if (/command not found|No such file or directory.*\b(?:magick|convert)\b/i.test(line)) {
    return "could not convert portrait image: ImageMagick (magick or convert) is not installed";
  }
  if (/Unable to read logo image/i.test(line)) return `could not convert portrait image: unreadable image ${original}`;
  const cleaned = line.replaceAll(staged, original).replace(/\blogo\b/gi, "portrait");
  return `could not convert portrait image: ${cleaned}`;
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

    let isPhoto = false;
    if (imBin) {
      const probe = await runWithTimeout(
        [
          imBin,
          "-background", "white",
          staged,
          "-auto-orient",
          "-alpha", "remove", "-alpha", "off",
          "-colorspace", "Gray",
          "-resize", "64x64!",
          "-format", "%[fx:(p{0,0}+p{63,0}+p{0,63}+p{63,63}+p{32,0}+p{0,32}+p{63,32})/7]",
          "info:",
        ],
        true,
        timeoutMs,
      );
      if (probe.code !== 0) {
        throw new Error(cleanTranscodeError(probe.stderr, staged, trimmed));
      }
      const corners = Number(probe.stdout.trim());
      if (Number.isFinite(corners) && corners < DRAWING_CORNER_FLOOR) isPhoto = true;
    }

    if (isPhoto && imBin) {
      const w = PORTRAIT_COLS * 8;
      const h = PORTRAIT_ROWS * 16;
      const ellipse = `ellipse ${w / 2},${h / 2} ${(w * 0.95) / 2},${(h * 0.95) / 2} 0,360`;
      const result = await runWithTimeout(
        [
          imBin,
          "-background", "white",
          staged,
          "-auto-orient",
          "-alpha", "remove", "-alpha", "off",
          "-colorspace", "Gray",
          "-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`,
          "-blur", "0x1", "-normalize", "-level", "10%,90%",
          "(", "+clone", "-fill", "black", "-colorize", "100", "-fill", "white",
          "-draw", ellipse, "-blur", `0x${Math.round(w / 12)}`, ")",
          "-compose", "multiply", "-composite",
          "-resize", `${PORTRAIT_COLS * 2}x${PORTRAIT_ROWS * 4}!`,
          "-ordered-dither", "h4x4a",
          "-negate",
          "-compress", "none",
          "pbm:-",
        ],
        true,
        timeoutMs,
      );
      if (result.code !== 0) {
        throw new Error(cleanTranscodeError(result.stderr, staged, trimmed));
      }
      return validatePortraitArt(pbmToBraille(result.stdout));
    }

    if (omarchyTranscoder && (magickBin || !imBin)) {
      const outTxt = join(scratch, "portrait.txt");
      const result = await runWithTimeout(
        [
          omarchyTranscoder,
          staged,
          outTxt,
          "--width", String(PORTRAIT_COLS),
          "--height", String(PORTRAIT_ROWS),
          "--threshold", String(PORTRAIT_THRESHOLD),
        ],
        false,
        timeoutMs,
      );
      if (result.code !== 0) {
        throw new Error(cleanTranscodeError(result.stderr, staged, trimmed, !magickBin));
      }
      let art: string;
      try { art = readFileSync(outTxt, "utf8"); }
      catch { throw new Error("could not convert portrait image: transcoder produced no output"); }
      return validatePortraitArt(art);
    }

    const result = await runWithTimeout(
      [
        imBin!,
        "-background", "white",
        staged,
        "-auto-orient",
        "-alpha", "remove", "-alpha", "off",
        "-colorspace", "Gray",
        "-negate",
        "-bordercolor", "black", "-border", "1", "-trim", "+repage",
        "-resize", `${PORTRAIT_COLS * 2}x${PORTRAIT_ROWS * 4}`,
        "-threshold", `${PORTRAIT_THRESHOLD}%`,
        "-negate",
        "-compress", "none",
        "pbm:-",
      ],
      true,
      timeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(cleanTranscodeError(result.stderr, staged, trimmed));
    }
    return validatePortraitArt(pbmToBraille(result.stdout));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
