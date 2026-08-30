#!/usr/bin/env bun
// Rebuild art/*.txt from the source images named in assets/portraits.json.
//
// Photographs need more than the hard threshold a logo transcoder uses: a bust
// thresholded flat is a white blob. Each portrait is blurred just enough to lose
// the marble's grain, levelled so the sitter's own shadows survive, masked with a
// soft ellipse so the museum wall behind it does not, and finally halftoned — a
// clustered 4x4 pattern, which the braille grid renders as tone rather than the
// static a diffusion dither turns into at this size.
//
// Usage: bun scripts/transcode.ts [slug...]   (default: all)
//   Source images live in assets/sources/ — fetch them with scripts/fetch-sources.sh.

import { $ } from "bun";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const manifest = await Bun.file(join(root, "assets/portraits.json")).json();
const { cols, rows } = manifest.size;
const only = new Set(Bun.argv.slice(2));

for (const p of manifest.portraits) {
  if (only.size && !only.has(p.slug)) continue;

  const source = join(root, "assets/sources", p.file);
  if (!(await Bun.file(source).exists())) {
    console.error(`skip ${p.slug}: missing ${source} (run scripts/fetch-sources.sh)`);
    continue;
  }

  // Work at 4x the final dot grid so the blur and levels act on real detail,
  // then drop to the dot grid in one final resize.
  const w = cols * 8;
  const h = rows * 16;
  const { blur, black, white } = p.tone;
  const ellipse =
    `ellipse ${w / 2},${h / 2} ${(w * 0.95) / 2},${(h * 0.95) / 2} 0,360`;

  const args = [
    source, "-auto-orient", "-crop", p.crop, "+repage",
    "-colorspace", "Gray",
    "-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`,
    "-blur", `0x${blur}`, "-normalize", "-level", `${black}%,${white}%`,
    "(", "+clone", "-fill", "black", "-colorize", "100", "-fill", "white",
    "-draw", ellipse, "-blur", `0x${Math.round(w / 12)}`, ")",
    "-compose", "multiply", "-composite",
    "-resize", `${cols * 2}x${rows * 4}!`, "-ordered-dither", "h4x4a",
    "-negate", "-compress", "none", "pbm:-",
  ];

  const pbm = await $`magick ${args}`.arrayBuffer();
  const art = await $`bun ${join(root, "scripts/braille.ts")} < ${new Response(pbm)}`.text();
  await Bun.write(join(root, "art", `${p.slug}.txt`), art);

  const lines = art.trimEnd().split("\n");
  console.log(`${p.slug.padEnd(12)} ${Math.max(...lines.map((l) => [...l].length))}x${lines.length}`);
}
