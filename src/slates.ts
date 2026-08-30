// The screensavers omastoic can switch between, and the preview tiles the
// Omarchy image picker shows for them.
//
// A "slate" is one thing the screensaver can display: the Stoics, who are drawn
// fresh every time, or a fixed piece of art in a text file — Omarchy's own logo,
// whatever was in the slot before omastoic arrived, or anything the user drops
// in ~/.config/omastoic/screensavers.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const STOICS = "Stoics";

export type Slate =
  | { name: string; kind: "stoics" }
  | { name: string; kind: "art"; path: string };

export type SlatePaths = {
  /** ~/.config/omarchy/branding/screensaver.txt.pre-omastoic */
  backup: string;
  /** ~/.config/omastoic/screensavers */
  userDir: string;
  /** $OMARCHY_PATH/logo.txt */
  omarchyLogo: string;
};

const exists = async (path: string) => Bun.file(path).exists();

/**
 * Every slate on offer, Stoics first. Names double as the preview filenames the
 * picker hands back, so they are made unique here rather than hoped about.
 */
export async function discover(paths: SlatePaths): Promise<Slate[]> {
  const slates: Slate[] = [{ name: STOICS, kind: "stoics" }];
  const taken = new Set([STOICS.toLowerCase()]);

  const add = (name: string, path: string) => {
    let unique = name;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name} ${n}`;
    taken.add(unique.toLowerCase());
    slates.push({ name: unique, kind: "art", path });
  };

  if (await exists(paths.backup)) add("Previous", paths.backup);
  if (await exists(paths.omarchyLogo)) add("Omarchy", paths.omarchyLogo);

  let entries: string[] = [];
  try {
    entries = readdirSync(paths.userDir).filter((f) => f.endsWith(".txt")).sort();
  } catch {
    // no user slates yet
  }
  for (const entry of entries) add(entry.replace(/\.txt$/, ""), join(paths.userDir, entry));

  return slates;
}

export function find(slates: Slate[], name: string): Slate | undefined {
  const wanted = name.trim().toLowerCase();
  return slates.find((s) => s.name.toLowerCase() === wanted);
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Build one preview PNG per slate and return where they landed.
 *
 * Tiles are cached against the hash of what they depict, so opening the picker
 * again is instant while an edited slate still redraws. `stoicsCanvas` is a
 * fixed sample rather than a live draw: a tile that showed a different quote
 * every time would read as a different screensaver every time.
 */
export async function buildPreviews(
  slates: Slate[],
  dir: string,
  stoicsCanvas: string,
  render: (canvas: string, out: string) => Promise<void>,
): Promise<Map<string, string>> {
  mkdirSync(dir, { recursive: true });
  const previews = new Map<string, string>();

  for (const slate of slates) {
    const canvas =
      slate.kind === "stoics" ? stoicsCanvas : await Bun.file(slate.path).text().catch(() => "");
    if (!canvas.trim()) continue;

    const png = join(dir, `${slate.name}.png`);
    const stamp = join(dir, `${slate.name}.sig`);
    const signature = digest(canvas);

    const cached = await Bun.file(stamp).text().catch(() => "");
    if (cached.trim() !== signature || !(await exists(png))) {
      await render(canvas, png);
      await Bun.write(stamp, signature);
    }
    previews.set(slate.name, png);
  }

  return previews;
}
