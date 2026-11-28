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
export const PREVIEW_FONT_PX = 6;

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

/** Cell geometry for rendering a full 34x20 portrait preview with square dot pitch in Qt Text. */
export function previewPortraitLayout(fontPx = PREVIEW_FONT_PX): {
  fontPx: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
} {
  const cellWidth = fontPx * BRAILLE_ADVANCE_EM;
  const cellHeight = cellWidth * 2;
  const cols = PORTRAIT_COLS;
  const rows = PORTRAIT_ROWS;
  return {
    fontPx,
    cols,
    rows,
    cellWidth,
    cellHeight,
    width: cols * cellWidth,
    height: rows * cellHeight,
  };
}

/** Format 34x20 braille art for proportional Qt Text by replacing ASCII spaces with U+2800. */
export function panelPreviewPortrait(art: string): string {
  const trimmed = art.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!/[\u2801-\u28ff]/u.test(trimmed)) return "";
  const lines = trimmed.split("\n").map((line) => line.replace(/ /g, "\u2800"));
  while (lines.length && !/[\u2801-\u28ff]/u.test(lines[0]!)) lines.shift();
  while (lines.length && !/[\u2801-\u28ff]/u.test(lines[lines.length - 1]!)) lines.pop();
  const rows = Math.min(PORTRAIT_ROWS, lines.length);
  const cols = Math.min(PORTRAIT_COLS, Math.max(1, ...lines.slice(0, rows).map((line) => [...line].length)));
  return padPortrait(lines.slice(0, rows).join("\n"), rows, cols);
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

/** Strip Netpbm comments (`#` up to CR or LF) and split into ASCII tokens. */
function pnmTokens(text: string): string[] {
  return text.replace(/#[^\r\n]*/g, "").trim().split(/\s+/).filter(Boolean);
}

/** Encode an ASCII PBM (P1) bitmap into Unicode braille art. */
export function pbmToBraille(pbm: string): string {
  const tokens = pnmTokens(pbm);

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

const SPARSE_MIN_PIXELS = 6;
const SPARSE_MIN_SPAN_RATIO = 0.05;

function hasSparseStroke(bits: readonly string[], width: number, height: number): boolean {
  const minSpan = Math.max(4, Math.ceil(Math.max(width, height) * SPARSE_MIN_SPAN_RATIO));
  const seen = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== "1" || seen[i]) continue;
    seen[i] = 1;
    const stack = [i];
    let size = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      size += 1;
      const x = cur % width;
      const y = Math.floor(cur / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (bits[next] === "1" && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    if (size >= SPARSE_MIN_PIXELS && Math.max(maxX - minX + 1, maxY - minY + 1) >= minSpan) {
      return true;
    }
  }
  return false;
}

export type ParsedPgm = { width: number; height: number; values: Uint8Array };

/** Parse an ASCII PGM (P2) grayscale bitmap into an 8-bit pixel buffer. */
export function parsePgm(pgm: string): ParsedPgm {
  const tokens = pnmTokens(pgm);

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

  const values = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const raw = Number(tokens[4 + i]);
    values[i] = Math.max(0, Math.min(255, Math.round((raw / maxVal) * 255)));
  }
  return { width, height, values };
}

function asParsedPgm(input: string | ParsedPgm): ParsedPgm {
  if (typeof input === "string") return parsePgm(input);
  if (!Number.isInteger(input.width) || input.width < 1 || !Number.isInteger(input.height) || input.height < 1) {
    throw new Error("invalid PGM header");
  }
  if (input.values.length < input.width * input.height) {
    throw new Error("incomplete PGM pixel data");
  }
  return input;
}

function sampleBorder(
  vals: ArrayLike<number>,
  w: number,
  h: number,
  inset = Math.max(0, Math.min(2, Math.floor(Math.min(w, h) * 0.02))),
): number[] {
  const border: number[] = [];
  for (let x = inset; x < w - inset; x++) border.push(vals[inset * w + x]!);
  const sideRows = Math.max(inset + 1, Math.floor(h * 0.75));
  for (let y = inset; y < sideRows; y++) {
    border.push(vals[y * w + inset]!, vals[y * w + w - 1 - inset]!);
  }
  border.sort((a, b) => a - b);
  return border;
}

function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.max(0, Math.min(w - 1, x + k));
        acc += src[y * w + sx]! * kernel[k + radius]!;
      }
      tmp[y * w + x] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.max(0, Math.min(h - 1, y + k));
        acc += tmp[sy * w + x]! * kernel[k + radius]!;
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Classify whether a grayscale PGM is a continuous-tone photograph/painting
 * rather than a flat line drawing, sparse sketch, or extreme-aspect strip.
 */
export function isPhotographicPgm(input: string | ParsedPgm): boolean {
  const { width, height, values } = asParsedPgm(input);
  if (width < 48 || height < 48) return false;
  const aspect = width / height;
  if (aspect < 0.35 || aspect > 2.8) return false;

  const count = width * height;
  const sorted = Uint8Array.from(values.subarray(0, count)).sort();
  const lo = sorted[Math.floor(count * 0.02)]!;
  const hi = sorted[Math.floor(count * 0.98)]!;
  const span = hi - lo;
  if (span < 24) return false;

  const bins = new Uint32Array(32);
  let midCount = 0;
  for (let i = 0; i < count; i++) {
    const s = Math.max(0, Math.min(255, Math.round(((values[i]! - lo) / span) * 255)));
    bins[s >> 3]! += 1;
    if (s >= 24 && s <= 231) midCount += 1;
  }
  const midRatio = midCount / count;
  let entropy = 0;
  let midBins = 0;
  let maxBinIdx = 0;
  for (let b = 0; b < 32; b++) {
    const p = bins[b]! / count;
    if (p > 0) entropy -= p * Math.log2(p);
    if (b >= 3 && b <= 28 && p > 0.004) midBins += 1;
    if (bins[b]! > bins[maxBinIdx]!) maxBinIdx = b;
  }

  let smoothGrad = 0;
  let sharpGrad = 0;
  let totalInner = 0;
  const smoothBucketSeen = new Uint8Array(32);
  let smoothBuckets = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      totalInner += 1;
      const c = values[y * width + x]!;
      const d = Math.max(
        Math.abs(c - values[y * width + x + 1]!),
        Math.abs(c - values[(y + 1) * width + x]!),
      );
      if (d >= 1 && d <= 20) {
        smoothGrad += 1;
        const sb = c >> 3;
        if (!smoothBucketSeen[sb]) {
          smoothBucketSeen[sb] = 1;
          smoothBuckets += 1;
        }
      } else if (d > 20) {
        sharpGrad += 1;
      }
    }
  }
  const smoothRatio = smoothGrad / Math.max(1, totalInner);

  if (entropy >= 1.9 && midBins >= 6 && midRatio >= 0.14 && smoothRatio >= 0.15) {
    return true;
  }

  // Uniform-backdrop studio portraits and transparent cutouts flatten the outer
  // background into one extreme bin; evaluate smooth foreground tone diversity.
  const domFrac = bins[maxBinIdx]! / count;
  if ((maxBinIdx <= 1 || maxBinIdx >= 30) && domFrac > 0.45) {
    const fgCount = count - bins[maxBinIdx]!;
    if (fgCount >= Math.max(64, count * 0.05)) {
      let fgEntropy = 0;
      let fgMidBins = 0;
      for (let b = 0; b < 32; b++) {
        if (b === maxBinIdx) continue;
        const fp = bins[b]! / fgCount;
        if (fp > 0) fgEntropy -= fp * Math.log2(fp);
        if (b >= 3 && b <= 28 && fp > 0.004) fgMidBins += 1;
      }
      const smoothOfNonFlat = smoothGrad / Math.max(1, smoothGrad + sharpGrad);
      const hasMultiToneSmooth = smoothBuckets >= 7 || (fgEntropy >= 1.55 && fgMidBins >= 6);
      if (hasMultiToneSmooth && smoothGrad >= Math.max(40, count * 0.03) && smoothOfNonFlat >= 0.62) {
        return true;
      }
    }
  }

  return false;
}

function findHeadCrop(
  vals: Float32Array,
  w: number,
  h: number,
  dstW: number,
  dstH: number,
): { x0: number; y0: number; cropW: number; cropH: number } {
  const border = sampleBorder(vals, w, h);
  const bMed = border[Math.floor(border.length / 2)]!;
  const bSpread = border[Math.floor(border.length * 0.85)]! - border[Math.floor(border.length * 0.15)]!;

  const diffs = new Float32Array(w * h);
  const upperDiffs: number[] = [];
  const upperLimit = Math.max(1, Math.ceil(h * 0.55));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.abs(vals[i]! - bMed);
      diffs[i] = d;
      if (y < upperLimit) upperDiffs.push(d);
    }
  }
  upperDiffs.sort((a, b) => a - b);
  const upperP95Diff = upperDiffs[Math.floor(upperDiffs.length * 0.95)]!;
  const strongThresh = Math.max(26, bSpread * 1.7 + 16, upperP95Diff * 0.32);

  type RowSpan = { count: number; xMin: number; xMax: number; cx: number };
  const collectRows = (thresh: number): RowSpan[] => {
    const out: RowSpan[] = [];
    for (let y = 0; y < h; y++) {
      const xs: number[] = [];
      for (let x = 0; x < w; x++) {
        if (diffs[y * w + x]! >= thresh) xs.push(x);
      }
      if (xs.length >= Math.max(3, Math.floor(w * 0.06))) {
        out.push({
          count: xs.length,
          xMin: xs[Math.floor(xs.length * 0.05)]!,
          xMax: xs[Math.floor(xs.length * 0.95)]!,
          cx: xs[Math.floor(xs.length * 0.5)]!,
        });
      } else {
        out.push({ count: 0, xMin: w, xMax: -1, cx: w / 2 });
      }
    }
    return out;
  };

  const firstRunTop = (rows: RowSpan[], maxY: number): number => {
    for (let y = 0; y < Math.min(h - 2, maxY); y++) {
      if (rows[y]!.count > 0 && rows[y + 1]!.count > 0 && rows[y + 2]!.count > 0) {
        return y;
      }
    }
    return -1;
  };

  let rowSpan = collectRows(strongThresh);
  let topY = firstRunTop(rowSpan, h);
  if (topY < 0) topY = 0;

  // High-contrast collars or dark clothing in the lower half can push strongThresh
  // past a subtler upper face; re-seed the upper rows with a noise-floor threshold.
  if (topY >= Math.floor(h * 0.38)) {
    const looseThresh = Math.max(20, bSpread * 1.2 + 12);
    if (looseThresh < strongThresh) {
      const looseRows = collectRows(looseThresh);
      const looseTop = firstRunTop(looseRows, topY);
      if (looseTop >= 0) {
        rowSpan = looseRows;
        topY = looseTop;
      }
    }
  }

  const headRowsStart = Math.min(h - 1, topY + Math.round(h * 0.04));
  const headRowsEnd = Math.min(h, topY + Math.round(h * 0.28));
  const widths: number[] = [];
  const centers: number[] = [];
  for (let y = headRowsStart; y < headRowsEnd; y++) {
    if (rowSpan[y]!.count > 0) {
      widths.push(rowSpan[y]!.xMax - rowSpan[y]!.xMin + 1);
      centers.push(rowSpan[y]!.cx);
    }
  }
  widths.sort((a, b) => a - b);
  centers.sort((a, b) => a - b);
  const headW = widths.length ? widths[Math.floor(widths.length * 0.75)]! : w * 0.55;
  const headCx = centers.length ? centers[Math.floor(centers.length * 0.5)]! : w / 2;

  const targetAspect = dstW / dstH;
  const fullCropW = Math.min(w, h * targetAspect);
  let cropW = Math.min(w, Math.max(fullCropW * 0.45, headW * 1.38));
  let cropH = cropW / targetAspect;
  if (cropH > h) {
    cropH = h;
    cropW = Math.min(w, cropH * targetAspect);
  }
  let y0 = Math.max(0, topY - cropH * 0.04);
  if (y0 + cropH > h) y0 = Math.max(0, h - cropH);
  const x0 = Math.max(0, Math.min(w - cropW, headCx - cropW / 2));
  return { x0, y0, cropW, cropH };
}

function trimLeadingBlankColumns(art: string): string {
  if (!art) return "";
  const lines = art.split("\n");
  let minLead = Infinity;
  for (const line of lines) {
    const chars = [...line];
    const firstInk = chars.findIndex((ch) => ch !== " " && ch !== "\u2800");
    if (firstInk !== -1 && firstInk < minLead) minLead = firstInk;
  }
  if (!Number.isFinite(minLead) || minLead <= 0) return art;
  return lines
    .map((line) => [...line].slice(minLead).join("").replace(/[ \u2800]+$/u, ""))
    .join("\n");
}

/**
 * Convert a continuous-tone grayscale PGM into 34x20 braille art via
 * head-and-shoulders framing, local contrast sharpening, dark/light-background-aware
 * levels, a soft corner vignette, Atkinson halftone dithering, and common
 * leading-blank column trimming so the inked portrait centres cleanly.
 */
export function pgmToHalftoneBraille(input: string | ParsedPgm): string {
  const { width: w, height: h, values } = asParsedPgm(input);
  if (w < 4 || h < 4) return "";
  const vals = Float32Array.from(values);

  const dstW = PORTRAIT_COLS * 2;
  const dstH = PORTRAIT_ROWS * 4;
  const crop = findHeadCrop(vals, w, h, dstW, dstH);

  const workW = dstW * 2;
  const workH = dstH * 2;
  const work = new Float32Array(workW * workH);
  for (let y = 0; y < workH; y++) {
    const sy = crop.y0 + ((y + 0.5) / workH) * crop.cropH - 0.5;
    const iy = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const iy1 = Math.min(h - 1, iy + 1);
    const fy = Math.max(0, Math.min(1, sy - iy));
    for (let x = 0; x < workW; x++) {
      const sx = crop.x0 + ((x + 0.5) / workW) * crop.cropW - 0.5;
      const ix = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const ix1 = Math.min(w - 1, ix + 1);
      const fx = Math.max(0, Math.min(1, sx - ix));
      work[y * workW + x] =
        (vals[iy * w + ix]! * (1 - fx) + vals[iy * w + ix1]! * fx) * (1 - fy) +
        (vals[iy1 * w + ix]! * (1 - fx) + vals[iy1 * w + ix1]! * fx) * fy;
    }
  }

  const blurLo = gaussianBlur(work, workW, workH, 3.5);
  const enhanced = new Float32Array(workW * workH);
  for (let i = 0; i < workW * workH; i++) {
    enhanced[i] = Math.max(0, Math.min(255, work[i]! + 1.6 * (work[i]! - blurLo[i]!)));
  }
  const smooth = gaussianBlur(enhanced, workW, workH, 0.7);

  const cb = sampleBorder(smooth, workW, workH);
  const cropBMed = cb[Math.floor(cb.length / 2)]!;
  const cropB75 = cb[Math.floor(cb.length * 0.75)]!;
  const cropB85 = cb[Math.floor(cb.length * 0.85)]!;
  const cropB15 = cb[Math.floor(cb.length * 0.15)]!;
  const cropBSpread = cropB85 - cropB15;

  const center: number[] = [];
  for (let y = Math.floor(workH * 0.10); y < Math.floor(workH * 0.90); y++) {
    for (let x = Math.floor(workW * 0.12); x < Math.floor(workW * 0.88); x++) {
      center.push(smooth[y * workW + x]!);
    }
  }
  center.sort((a, b) => a - b);
  const p03 = center[Math.floor(center.length * 0.03)]!;
  const p97 = center[Math.floor(center.length * 0.97)]!;
  const span = p97 - p03;
  if (span < 16) return "";

  const otsu = otsuThreshold(Array.from(smooth, (v) => Math.round(v)));
  const isDarkBg = cropBMed < otsu || (cropBMed < 165 && p97 - cropBMed >= 28);

  let blackPt: number;
  let whitePt: number;
  if (isDarkBg) {
    // Use lower border quantiles (p50..p75) so uneven halos behind the head do not clip mid-tone faces.
    const upperSpread = Math.max(0, cropB75 - cropBMed);
    const bgFloor = cropBMed + Math.max(14, Math.min(36, upperSpread * 0.7 + 14));
    const darkCap = Math.min(p03 + span * 0.45, Math.max(cropBMed + 38, otsu * 0.65));
    blackPt = Math.min(darkCap, Math.max(bgFloor, p03 + span * 0.12));
    whitePt = Math.max(blackPt + 24, p97);
  } else {
    const safeBorderLo = Math.max(cropB15, cropBMed - 36);
    const bgCeil = safeBorderLo - Math.max(8, Math.min(24, cropBSpread * 0.35));
    blackPt = p03;
    whitePt = Math.max(p03 + span * 0.55, Math.min(bgCeil, p97 - span * 0.08));
    if (whitePt < blackPt + 24) whitePt = Math.max(blackPt + 24, p97);
  }

  const grid = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const v = (
        smooth[(y * 2) * workW + x * 2]! +
        smooth[(y * 2) * workW + x * 2 + 1]! +
        smooth[(y * 2 + 1) * workW + x * 2]! +
        smooth[(y * 2 + 1) * workW + x * 2 + 1]!
      ) / 4;
      let t = Math.max(0, Math.min(1, (v - blackPt) / (whitePt - blackPt)));
      if (!isDarkBg) t = 1 - t;
      t = Math.pow(t, isDarkBg ? 1.12 : 0.88);
      const nx = (x + 0.5 - dstW / 2) / (dstW * 0.56);
      const ny = (y + 0.5 - dstH / 2) / (dstH * 0.54);
      const r = Math.hypot(nx, ny);
      if (r > 0.86) {
        const fade = Math.max(0, 1 - (r - 0.86) / 0.25);
        t *= fade * fade * (3 - 2 * fade);
      }
      grid[y * dstW + x] = t;
    }
  }

  const buf = new Float32Array(grid);
  const bits = new Array<string>(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const idx = y * dstW + x;
      const old = buf[idx]!;
      const on = old >= 0.5 ? 1 : 0;
      bits[idx] = on ? "1" : "0";
      const err = (old - on) / 8;
      if (x + 1 < dstW) buf[idx + 1]! += err;
      if (x + 2 < dstW) buf[idx + 2]! += err;
      if (y + 1 < dstH) {
        if (x > 0) buf[idx + dstW - 1]! += err;
        buf[idx + dstW]! += err;
        if (x + 1 < dstW) buf[idx + dstW + 1]! += err;
      }
      if (y + 2 < dstH) buf[idx + dstW * 2]! += err;
    }
  }
  return trimLeadingBlankColumns(pbmToBraille(`P1\n${dstW} ${dstH}\n${bits.join("")}`));
}

/**
 * Convert an ASCII PGM (P2) grayscale bitmap into Unicode braille art using
 * percentile auto-contrast, Otsu thresholding, and border-aware background
 * suppression so both drawings and sparse marks stay clean.
 */
export function pgmToBraille(input: string | ParsedPgm): string {
  const { width, height, values } = asParsedPgm(input);
  const count = width * height;

  const sorted = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
  const tail = Math.min(
    Math.max(2, Math.floor(sorted.length * 0.02)),
    Math.floor((sorted.length - 1) / 2),
  );
  const lo = sorted[tail]!;
  const hi = sorted[sorted.length - 1 - tail]!;
  const span = hi - lo;
  if (span < 8) {
    if (sorted.length < SPARSE_MIN_PIXELS * 2) return "";
    const edge = SPARSE_MIN_PIXELS - 1;
    const darkGap = lo - sorted[edge]!;
    const brightGap = sorted[sorted.length - 1 - edge]! - hi;
    if (Math.max(darkGap, brightGap) < 16) return "";
    const darkBg = brightGap > darkGap;
    const threshold = darkBg
      ? Math.max(hi + 12, Math.round((hi + sorted[sorted.length - 1]!) / 2))
      : Math.min(lo - 12, Math.round((sorted[0]! + lo) / 2));
    const bits: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      bits[i] = (darkBg ? values[i]! > threshold : values[i]! <= threshold) ? "1" : "0";
    }
    if (!hasSparseStroke(bits, width, height)) return "";
    return pbmToBraille(`P1\n${width} ${height}\n${bits.join("")}`);
  }

  const stretched = Array.from(values.subarray(0, count), (v) =>
    Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255))),
  );

  // Sample top, left, and right borders (bottom often holds shoulders/torso).
  const border = sampleBorder(stretched, width, height, 0);
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

function readImageDimensions(
  bytes: Uint8Array,
  kind: "png" | "jpeg",
): { width: number; height: number } | null {
  if (kind === "png") {
    if (
      bytes.length < 24 ||
      bytes[12] !== 0x49 ||
      bytes[13] !== 0x48 ||
      bytes[14] !== 0x44 ||
      bytes[15] !== 0x52
    ) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    while (pos < bytes.length && bytes[pos] === 0xff) pos += 1;
    if (pos >= bytes.length) return null;
    const marker = bytes[pos]!;
    pos += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
    if (pos + 2 > bytes.length) return null;
    const segLen = (bytes[pos]! << 8) | bytes[pos + 1]!;
    if (segLen < 2 || pos + segLen > bytes.length) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (segLen < 7) return null;
      const height = (bytes[pos + 3]! << 8) | bytes[pos + 4]!;
      const width = (bytes[pos + 5]! << 8) | bytes[pos + 6]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += segLen;
  }
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

function primaryErrorLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => !/@\s*warning\//i.test(line)) ?? lines[0] ?? "";
}

const DECODE_WARNING =
  /Premature end|Corrupt (?:JPEG|PNG|image)|unexpected end[- ]of[- ]file|insufficient image data|Not a JPEG file|Invalid JPEG|incomplete image|Improper image header/i;
// Exempt only header, metadata, and SOS markers that may follow harmless padding; DHT (0xC4), EOI (0xD9), and RST0-RST7 (0xD0-0xD7) can signal mid-scan corruption.
const HARMLESS_DECODE_WARNING =
  /Corrupt JPEG data:\s*\d+\s+extraneous bytes? before marker\s+0x(?:c[0-35-9a-f]|d[abd]|e[0-9a-f]|fe)\b/i;

function decodeWarningLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => DECODE_WARNING.test(line) && !HARMLESS_DECODE_WARNING.test(line));
}

export function hasDecodeWarning(stderr: string): boolean {
  return decodeWarningLines(stderr).length > 0;
}

const DIMENSION_LIMIT_ERROR_RE =
  /width or height exceeds limit|image (?:width|height) exceeds user limit|maximum supported image dimension|maximum pixel limit/i;

const NON_DECODE_ERROR_RE =
  /memory allocation failed|cache resources exhausted|not allowed by the security policy|resource limit|no decode delegate/i;

const DECODE_ERROR_RE =
  /@\s*(?:error|fatal)\/(?:jpeg|png)\.c\/|JPEGErrorHandler|MagickPNGErrorHandler|Read(?:One)?(?:JPEG|PNG)Image|CorruptImageError|insufficient image data|corrupt (?:image|jpeg|png)|improper image header|negative or zero image size|not a (?:jpeg|png) file|premature end of|unexpected end[- ]of[- ]file|invalid (?:jpeg|png)|libpng error|Unable to read logo image/i;

function sanitizeTranscodeLine(line: string, original: string): string {
  return line
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
    .replace(/\s*@\s*(?:error|fatal|warning)\/\S+\.?$/i, "")
    .replace(/^(?:[^\s:]*\/)?(?:(?:magick|convert)(?:-[^\s:]+)?|omarchy-transcode-ascii):\s*/i, "")
    .replace(/`[^']*omastoic-portrait-[^']*'/g, () => `"${original}"`)
    .replace(/'[^']*omastoic-portrait-[^']*'/g, () => `"${original}"`)
    .replace(/"[^"]*omastoic-portrait-[^"]*"/g, () => `"${original}"`)
    .replace(/[^\s`'"()]*omastoic-portrait-[^\s`'"()]*/g, () => original)
    .replace(/`([^']*)'/g, '"$1"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Turn converter stderr into a user-facing error without leaking temp paths or internals. */
export function cleanTranscodeError(
  stderr: string,
  original: string,
  missingMagick = false,
): string {
  const line = primaryErrorLine(stderr);
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
    DIMENSION_LIMIT_ERROR_RE.test(line) ||
    (!NON_DECODE_ERROR_RE.test(line) && DIMENSION_LIMIT_ERROR_RE.test(stderr))
  ) {
    return `could not convert portrait image: "${original}" dimensions exceed the image converter limit`;
  }
  if (!NON_DECODE_ERROR_RE.test(line)) {
    if (
      decodeWarningLines(stderr).some((entry) =>
        /Premature end|unexpected end[- ]of[- ]file|incomplete image|Corrupt (?:JPEG|PNG|image)/i.test(entry),
      )
    ) {
      return `could not convert portrait image: "${original}" looks damaged or truncated`;
    }
    if (DECODE_ERROR_RE.test(line)) {
      return `could not convert portrait image: "${original}" is not a readable JPEG or PNG image`;
    }
  }
  const reason = sanitizeTranscodeLine(line, original);
  if (!reason) {
    return "could not convert portrait image: image converter failed";
  }
  return `could not convert portrait image: ${reason}`;
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
 * When ImageMagick (`magick` or `convert`) is installed, it decodes the image
 * to grayscale ASCII PGM and routes continuous-tone photographs (detected by
 * `isPhotographicPgm`) through `pgmToHalftoneBraille` (head-and-shoulders
 * framing, local contrast sharpening, dark/light-background levels, soft corner
 * vignette, and Atkinson halftone dithering into `pbmToBraille`), while routing
 * line drawings and small canvases through `pgmToBraille` (auto-contrast, Otsu
 * thresholding, border-aware background suppression, and sparse/dead-pixel
 * filtering). When ImageMagick is absent, it falls back to
 * `omarchy-transcode-ascii`.
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
      const dims = readImageDimensions(bytes, kind);
      const smallSource =
        dims !== null && (dims.width < PORTRAIT_COLS * 2 || dims.height < PORTRAIT_ROWS * 4);
      if (smallSource) {
        const result = await runWithTimeout(
          [
            imBin,
            "-background", "white",
            staged,
            "-auto-orient",
            "-alpha", "remove", "-alpha", "off",
            "-colorspace", "Gray",
            "-resize", `${PORTRAIT_COLS * 4}x${PORTRAIT_ROWS * 8}>`,
            "-compress", "none",
            "pgm:-",
          ],
          true,
          Math.max(1, deadline - Date.now()),
        );
        if (result.code !== 0 || hasDecodeWarning(result.stderr) || !result.stdout.trim()) {
          throw new Error(cleanTranscodeError(result.stderr, trimmed));
        }
        return validatePortraitArt(fitPortraitToBudget(pgmToBraille(result.stdout)));
      }
      const runIm = (w: number, h: number) =>
        runWithTimeout(
          [
            imBin,
            "-background", "white",
            ...(kind === "jpeg" ? ["-define", `jpeg:size=${w * 2}x${h * 2}`] : []),
            staged,
            "-auto-orient",
            "-alpha", "remove", "-alpha", "off",
            "-colorspace", "Gray",
            "-resize", `${w * 2}x${h * 2}^>`,
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
      const parsed = parsePgm(result.stdout);
      if (isPhotographicPgm(parsed)) {
        const halftone = pgmToHalftoneBraille(parsed);
        if (halftone) return validatePortraitArt(halftone);
      }
      let art = pgmToBraille(parsed);
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
