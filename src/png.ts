#!/usr/bin/env bun
// Render a screensaver canvas to a PNG that looks like the screensaver does.
//
// The picker tiles and the dev preview script both go through here, so the one
// thing that matters — that a canvas is drawn at the *terminal's* cell aspect
// ratio, not a text renderer's default — is defined once.

import { $ } from "bun";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A monospace glyph advances about 0.6 of the point size, and the screensaver
// terminal's cell is 2.31 times as tall as it is wide (measured: 111x30 cells
// over 1600x1000 logical pixels). ImageMagick's own line height is 1.2, so the
// difference is made up with interline spacing.
const ADVANCE = 0.6;
const CELL_RATIO = 2.31;
const LINE = ADVANCE * CELL_RATIO;
const MAGICK_LINE = 1.2;

let cachedFont: string | null | undefined;

/** A monospace font with braille glyphs — the art is unreadable without them. */
export async function font(): Promise<string | null> {
  if (cachedFont !== undefined) return cachedFont;
  for (const family of ["JetBrainsMono Nerd Font", "monospace"]) {
    const found = (await $`fc-match -f %{file} ${family}`.text().catch(() => "")).trim();
    if (found) return (cachedFont = found);
  }
  return (cachedFont = null);
}

export type PngOptions = {
  width?: number;
  height?: number;
  foreground?: string;
  background?: string;
  /**
   * The grid the canvas will really be shown on. Given one, the canvas is drawn
   * at the size it will actually appear — a ten-line piece of art fills a tenth
   * of the tile, because that is what it does on screen. Without it the canvas
   * is scaled to fill, which is what the dev preview script wants.
   */
  grid?: { cols: number; rows: number };
};

/** Ask the current Omarchy theme for its foreground; the screensaver forces black behind it. */
export async function themeForeground(fallback = "#e8e4dc"): Promise<string> {
  const value = (await $`omarchy-theme-color foreground`.text().catch(() => "")).trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

export async function renderCanvasPng(
  canvas: string,
  out: string,
  options: PngOptions = {},
): Promise<void> {
  const {
    width = 1536,
    height = 864,
    foreground = "#e8e4dc",
    background = "#000000",
  } = options;

  const face = await font();
  if (!face) throw new Error("no monospace font found to render a preview with");

  const lines = canvas.replace(/\n+$/, "").split("\n");
  const cols = Math.max(1, ...lines.map((l) => [...l].length));
  const rows = Math.max(1, lines.length);

  // Lay out against the screen when one is given, so a canvas smaller than the
  // screen is drawn smaller. A canvas larger than the screen still shrinks to
  // fit — that is what the terminal does to it too.
  const boxCols = Math.max(cols, options.grid?.cols ?? 0);
  const boxRows = Math.max(rows, options.grid?.rows ?? 0);

  const margin = 0.92;
  const size = Math.max(
    6,
    Math.min(
      72,
      Math.floor(Math.min((width * margin) / (ADVANCE * boxCols), (height * margin) / (LINE * boxRows))),
    ),
  );
  const spacing = Math.round(size * (LINE - MAGICK_LINE));

  // `label:@file` rather than a shell argument: a canvas is full of characters a
  // command line would have opinions about.
  const source = join(tmpdir(), `omastoic-canvas-${process.pid}-${Date.now()}.txt`);
  await Bun.write(source, canvas);
  // Built as one array: Bun's shell treats a newline inside a template as a
  // command separator, so this cannot be written across lines.
  const args = [
    "-background", background, "-fill", foreground, "-font", face,
    "-pointsize", String(size), "-interline-spacing", String(spacing),
    `label:@${source}`,
    "-background", background, "-gravity", "center", "-extent", `${width}x${height}`,
    out,
  ];

  try {
    await $`magick ${args}`.quiet();
  } finally {
    try {
      unlinkSync(source);
    } catch {
      // already gone
    }
  }
}

if (import.meta.main) {
  const [input, out = "/tmp/omastoic-preview.png"] = Bun.argv.slice(2);
  if (!input) {
    console.error("usage: bun src/png.ts <canvas.txt> [out.png]");
    process.exit(1);
  }
  await renderCanvasPng(await Bun.file(input).text(), out, {
    foreground: await themeForeground(),
  });
  console.log(out);
}
