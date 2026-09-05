#!/usr/bin/env bun
// Rebuild art/*.txt from the source images named in assets/portraits.json.
//
// Two transcoders, because two kinds of picture end up here:
//
//   halftone  A photograph needs more than the hard threshold a logo
//             transcoder uses: a bust thresholded flat is a white blob. The
//             image is blurred just enough to lose the marble's grain,
//             levelled so the sitter's own shadows survive, masked with a soft
//             ellipse so the museum wall behind it is not, and halftoned with a
//             clustered 4x4 pattern — which the braille grid renders as tone,
//             where a diffusion dither at this size turns into static.
//   ascii     A drawing already is a hard threshold: strong strokes on bare
//             paper, with no grain to lose and no wall to hide. That is what
//             `omarchy transcode ascii` does, so line art goes through Omarchy's
//             own transcoder rather than a second copy of it here.
//
// Either way the source is first cropped to the sitter's head and flattened to
// grey, and the result is 34x20 braille cells.
//
// Usage: bun scripts/transcode.ts [slug...]   (default: all)

import { $ } from "bun";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = dirname(import.meta.dir);
const manifest = await Bun.file(join(root, "assets/portraits.json")).json();
const { cols, rows } = manifest.size;
const only = new Set(Bun.argv.slice(2));

// "commons" sources are public domain or CC0 and are fetched into
// assets/sources/ by scripts/fetch-sources.sh. "local" sources cannot be
// re-fetched from anywhere, so they are committed in assets/local/.
const SOURCE_DIRS: Record<string, string> = {
  commons: "assets/sources",
  local: "assets/local",
};

const scratch = mkdtempSync(join(tmpdir(), "omastoic-art-"));

try {
  for (const p of manifest.portraits) {
    if (only.size && !only.has(p.slug)) continue;

    const origin = p.origin ?? "commons";
    const dir = SOURCE_DIRS[origin];
    if (!dir) {
      console.error(`skip ${p.slug}: unknown origin "${origin}"`);
      continue;
    }

    const source = join(root, dir, p.file);
    if (!(await Bun.file(source).exists())) {
      const remedy =
        origin === "local"
          ? `put it in ${dir}/ — a local source is committed because it cannot be re-fetched`
          : "run scripts/fetch-sources.sh";
      console.error(`skip ${p.slug}: missing ${source} (${remedy})`);
      continue;
    }

    const transcoder = p.transcoder ?? "halftone";
    if (transcoder !== "halftone" && transcoder !== "ascii") {
      console.error(`skip ${p.slug}: unknown transcoder "${transcoder}"`);
      continue;
    }

    // Work at 4x the final dot grid so the blur and levels act on real detail,
    // then drop to the dot grid in one final resize.
    const w = cols * 8;
    const h = rows * 16;

    // Some exports bake their transparency checkerboard in as pixels. Flatten
    // everything above the floor to one white so the background is a single
    // colour that a trim or a threshold can tell from the sitter.
    const floorArgs = p.floor == null ? [] : ["-white-threshold", `${p.floor}%`];
    const prepared = [
      source, "-auto-orient", "-crop", p.crop, "+repage",
      "-colorspace", "Gray", "-alpha", "remove", "-alpha", "off",
      ...floorArgs,
    ];

    let art: string;
    if (transcoder === "ascii") {
      const png = join(scratch, `${p.slug}.png`);
      await $`magick ${prepared} ${png}`;
      const txt = join(scratch, `${p.slug}.txt`);
      await $`omarchy transcode ascii ${png} ${txt} --width ${cols} --height ${rows} --threshold ${p.threshold ?? 45}`.quiet();
      art = await Bun.file(txt).text();
    } else {
      const { blur, black, white } = p.tone;
      const ellipse =
        `ellipse ${w / 2},${h / 2} ${(w * 0.95) / 2},${(h * 0.95) / 2} 0,360`;
      const args = [
        ...prepared,
        "-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`,
        "-blur", `0x${blur}`, "-normalize", "-level", `${black}%,${white}%`,
        "(", "+clone", "-fill", "black", "-colorize", "100", "-fill", "white",
        "-draw", ellipse, "-blur", `0x${Math.round(w / 12)}`, ")",
        "-compose", "multiply", "-composite",
        "-resize", `${cols * 2}x${rows * 4}!`, "-ordered-dither", "h4x4a",
        "-negate", "-compress", "none", "pbm:-",
      ];
      const pbm = await $`magick ${args}`.arrayBuffer();
      art = await $`bun ${join(root, "scripts/braille.ts")} < ${new Response(pbm)}`.text();
    }

    await Bun.write(join(root, "art", `${p.slug}.txt`), art);

    const lines = art.trimEnd().split("\n");
    const size = `${Math.max(...lines.map((l) => [...l].length))}x${lines.length}`;
    console.log(`${p.slug.padEnd(12)} ${origin.padEnd(8)} ${transcoder.padEnd(8)} ${size}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
