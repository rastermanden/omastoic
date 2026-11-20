/** Braille portrait scaled to a smaller cell grid. Display cells, not a palette. */

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
