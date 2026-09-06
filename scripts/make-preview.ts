#!/usr/bin/env bun
// Build the listing still (preview.png) and the README animation (preview.gif)
// from the committed art, so a change to a portrait can be shown without
// setting up a screen recording.
//
// Every frame is a real canvas: the same compose() the screensaver writes to
// its branding file, laid out on the same 111x30 grid, drawn at the terminal's
// cell aspect ratio. The only liberty is colour — the plates are rendered white
// on black and then multiplied through a gradient, which is what the 1.x
// listing still did too.
//
// Usage: bun scripts/make-preview.ts [--still <slug>] [--mono] [--no-gif] [--no-mp4]
//   preview.png  1600x957, the still, default slug marcus
//   preview.gif  800x479, one plate per Stoic, 2.5s each
//   demo.mp4     1600x957, the same plates at full size
// The gif and the mp4 are gitignored: they are release assets, so that
// `omarchy plugin add` does not clone them.

import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compose, parseAuthors, parseQuotes, type Quote } from "../src/canvas.ts";
import { renderCanvasPng } from "../src/png.ts";

const root = dirname(import.meta.dir);
const GRID = { cols: 111, rows: 30 };
const STILL = { width: 1600, height: 957 };
const GIF = { width: 800, seconds: 2.5 };
const GRADIENT = ["#5FDBFF", "#8B5CF6"] as const;

const argv = Bun.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const still = value("still") ?? "marcus";
const mono = flag("mono");

const quotes = parseQuotes(await Bun.file(join(root, "data/quotes.tsv")).text());
const authors = parseAuthors(await Bun.file(join(root, "data/authors.tsv")).text());

/**
 * The shortest quote each Stoic has, so a frame is a portrait beside a line
 * that fits rather than a wall of text — and so the same input always gives the
 * same preview.
 */
function frameQuote(slug: string): Quote | undefined {
  return quotes
    .filter((q) => q.author === slug)
    .sort((a, b) => a.text.length - b.text.length || a.citation.localeCompare(b.citation))[0];
}

const scratch = mkdtempSync(join(tmpdir(), "omastoic-preview-"));

try {
  const frames: string[] = [];
  for (const [i, slug] of [...authors.keys()].entries()) {
    const quote = frameQuote(slug);
    if (!quote) {
      console.error(`skip ${slug}: no quote in the book`);
      continue;
    }
    const art = (await Bun.file(join(root, "art", `${slug}.txt`)).text())
      .replace(/\n+$/, "")
      .split("\n");
    const canvas = compose(quote, authors.get(slug), { ...GRID, art });

    const plate = join(scratch, `${String(i).padStart(2, "0")}-${slug}.png`);
    await renderCanvasPng(canvas, plate, {
      ...STILL,
      grid: GRID,
      foreground: "#ffffff",
      background: "#000000",
    });

    if (!mono) {
      // White on black is a mask: multiplied through the gradient it keeps the
      // dots and leaves the ground alone.
      await $`magick -size ${`${STILL.width}x${STILL.height}`} gradient:${`${GRADIENT[0]}-${GRADIENT[1]}`} ${plate} -compose multiply -composite ${plate}`.quiet();
    }
    frames.push(plate);
    console.log(`${slug.padEnd(12)} ${quote.citation}`);
  }

  if (!frames.length) throw new Error("no frames to build a preview from");

  const chosen = frames.find((f) => f.includes(`-${still}.png`)) ?? frames[0];
  await $`cp ${chosen} ${join(root, "preview.png")}`;
  console.log(`\npreview.png  ${STILL.width}x${STILL.height}  (${still})`);

  if (!flag("no-gif")) {
    const list = join(scratch, "frames.txt");
    // ffconcat wants the last frame repeated to give it a duration.
    const lines = [
      "ffconcat version 1.0",
      ...frames.flatMap((f) => [`file '${f}'`, `duration ${GIF.seconds}`]),
      `file '${frames[frames.length - 1]}'`,
    ];
    await Bun.write(list, lines.join("\n"));

    const gif = join(root, "preview.gif");
    const filter =
      `scale=${GIF.width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=none`;
    await $`ffmpeg -y -loglevel error -f concat -safe 0 -i ${list} -filter_complex ${filter} -loop 0 ${gif}`;
    const size = (await Bun.file(gif).arrayBuffer()).byteLength;
    console.log(`preview.gif  ${GIF.width}px  ${frames.length} frames  ${(size / 1024 / 1024).toFixed(1)}MB`);
  }

  if (!flag("no-mp4")) {
    const list = join(scratch, "frames-mp4.txt");
    const lines = [
      "ffconcat version 1.0",
      ...frames.flatMap((f) => [`file '${f}'`, `duration ${GIF.seconds}`]),
      `file '${frames[frames.length - 1]}'`,
    ];
    await Bun.write(list, lines.join("\n"));

    const mp4 = join(root, "demo.mp4");
    // yuv420p and even dimensions, or the clip will not play everywhere.
    await $`ffmpeg -y -loglevel error -f concat -safe 0 -i ${list} -vf ${"scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25"} -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart ${mp4}`;
    const size = (await Bun.file(mp4).arrayBuffer()).byteLength;
    console.log(`demo.mp4     ${STILL.width}x${STILL.height}  ${(size / 1024 / 1024).toFixed(1)}MB`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
