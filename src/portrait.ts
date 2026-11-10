// Turn any image into a braille portrait the size of the bundled ones, so a
// quote by someone outside the roster can have a face too.
//
// Same two transcoders as scripts/transcode.ts, without its per-portrait
// manifest: the image is cropped to the portrait's shape around the centre (or
// a crop you give), flattened to grey, and then either halftoned (a photo) or
// thresholded by Omarchy's own `omarchy transcode ascii` (a drawing).

import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PORTRAIT_COLS = 34;
export const PORTRAIT_ROWS = 20;

export type PortraitOptions = {
  /** Line art: a hard threshold instead of a halftone. */
  drawing?: boolean;
  /** Drawing only: percent; lower admits more ink. */
  threshold?: number;
  /** `WxH+X+Y` in source pixels; default is the centre, at the portrait's shape. */
  crop?: string;
};

const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/** Encode a 1-bit ASCII PBM (P1) as braille: one cell per 2x4 pixels. */
export function brailleFromPbm(pbm: string): string {
  const tokens = pbm
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join(" ")
    .trim()
    .split(/\s+/);
  if (tokens[0] !== "P1") throw new Error("expected an ASCII PBM (P1)");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  // P1 pixels may or may not be separated by whitespace.
  const pixels = tokens.slice(3).join("").split("");
  const on = (x: number, y: number) => x < width && y < height && pixels[y * width + x] === "1";
  const rows: string[] = [];
  for (let y = 0; y < height; y += 4) {
    let row = "";
    for (let x = 0; x < width; x += 2) {
      let code = 0;
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 4; dy++) if (on(x + dx, y + dy)) code |= DOTS[dx][dy];
      row += code === 0 ? " " : String.fromCharCode(0x2800 + code);
    }
    rows.push(row.replace(/\s+$/, ""));
  }
  while (rows.length && rows[0].trim() === "") rows.shift();
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.join("\n");
}

export async function makePortrait(image: string, options: PortraitOptions = {}): Promise<string> {
  if (!Bun.which("magick")) throw new Error("ImageMagick (magick) is needed to make a portrait");
  if (!(await Bun.file(image).exists())) throw new Error(`no image at ${image}`);
  if (options.crop != null && !/^\d+x\d+[+-]\d+[+-]\d+$/.test(options.crop)) throw new Error("--crop expects WxH+X+Y, like 400x470+30+125");
  const cols = PORTRAIT_COLS;
  const rows = PORTRAIT_ROWS;
  // Work at 4x the dot grid so blur and levels act on real detail.
  const w = cols * 8;
  const h = rows * 16;
  const crop = options.crop
    ? ["-crop", options.crop, "+repage"]
    : ["-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`];
  const prepared = [`${image}[0]`, "-auto-orient", ...crop, "-colorspace", "Gray", "-background", "white", "-alpha", "remove", "-alpha", "off"];

  if (options.drawing) {
    if (!Bun.which("omarchy")) throw new Error("omarchy is needed for --drawing");
    const scratch = mkdtempSync(join(tmpdir(), "omastoic-portrait-"));
    try {
      const png = join(scratch, "in.png");
      const txt = join(scratch, "out.txt");
      await $`magick ${prepared} ${png}`.quiet();
      await $`omarchy transcode ascii ${png} ${txt} --width ${cols} --height ${rows} --threshold ${options.threshold ?? 45}`.quiet();
      return (await Bun.file(txt).text()).replace(/\n+$/, "");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const ellipse = `ellipse ${w / 2},${h / 2} ${(w * 0.95) / 2},${(h * 0.95) / 2} 0,360`;
  const args = [
    ...prepared,
    "-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`,
    "-blur", "0x1.5", "-normalize", "-level", "12%,88%",
    "(", "+clone", "-fill", "black", "-colorize", "100", "-fill", "white",
    "-draw", ellipse, "-blur", `0x${Math.round(w / 12)}`, ")",
    "-compose", "multiply", "-composite",
    "-resize", `${cols * 2}x${rows * 4}!`, "-ordered-dither", "h4x4a",
    "-negate", "-compress", "none", "pbm:-",
  ];
  return brailleFromPbm(await $`magick ${args}`.quiet().text());
}
