// Persisted geometry for the Quickshell settings panel.
// Stored under ~/.local/state/omastoic/panel-size.json so user settings in
// ~/.config/omastoic/config.json stay strictly limited to `omastoic config`.
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWrite } from "./files.ts";

export type PanelSize = {
  width?: number;
  height?: number;
};

export const PANEL_SIZE_MIN_STORED = 120;
export const PANEL_SIZE_MAX_STORED = 16384;
export const PANEL_SIZE_MAX_BYTES = 4096;

const ALLOWED_KEYS = new Set(["width", "height", "reset"]);

function normalizeDimension(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded < PANEL_SIZE_MIN_STORED || rounded > PANEL_SIZE_MAX_STORED) return null;
  return rounded;
}

/** Validate a stored panel-size object. Returns null when empty or malformed. */
export function normalizePanelSize(raw: unknown): PanelSize | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const result: PanelSize = {};
  if (Object.hasOwn(value, "width")) {
    const width = normalizeDimension(value.width);
    if (width == null) return null;
    result.width = width;
  }
  if (Object.hasOwn(value, "height")) {
    const height = normalizeDimension(value.height);
    if (height == null) return null;
    result.height = height;
  }
  if (result.width == null && result.height == null) return null;
  return result;
}

/** Parse one `omastoic panel size` JSON payload. `size: null` means reset to default. */
export function parsePanelSizeCommand(
  raw: string,
): { ok: true; size: PanelSize | null } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "panel size expects a JSON object" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "panel size expects a JSON object" };
  }
  const value = parsed as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: `panel size does not accept "${key}"` };
    }
  }
  const hasWidth = Object.hasOwn(value, "width");
  const hasHeight = Object.hasOwn(value, "height");
  const hasReset = Object.hasOwn(value, "reset");

  if (hasReset) {
    if (typeof value.reset !== "boolean") {
      return { ok: false, error: "panel size reset must be true or false" };
    }
    if (value.reset) {
      if (hasWidth || hasHeight) {
        return { ok: false, error: "panel size reset cannot be combined with width or height" };
      }
      return { ok: true, size: null };
    }
    if (!hasWidth && !hasHeight) {
      return { ok: false, error: "panel size reset:false requires width or height" };
    }
  }

  if (!hasWidth && !hasHeight) return { ok: true, size: null };

  const size = normalizePanelSize({
    ...(hasWidth ? { width: value.width } : {}),
    ...(hasHeight ? { height: value.height } : {}),
  });
  if (!size) {
    return {
      ok: false,
      error: `panel size width and height must be finite numbers from ${PANEL_SIZE_MIN_STORED} to ${PANEL_SIZE_MAX_STORED}`,
    };
  }
  return { ok: true, size };
}

/** Read-only load from disk. Never follows symlinks, never writes or creates directories. */
export function readPanelSize(path: string): PanelSize | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > PANEL_SIZE_MAX_BYTES) return null;
  try {
    return normalizePanelSize(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Persist a validated panel size, or remove the file on reset (`null`). Never follows symlinks. */
export function writePanelSize(path: string, size: PanelSize | null): void {
  let stat = null;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size === null) {
    if (!stat) return;
    if (!stat.isFile()) throw new Error(`refusing to remove non-file: ${path}`);
    unlinkSync(path);
    return;
  }
  if (stat && !stat.isFile()) throw new Error(`refusing to replace non-file: ${path}`);
  atomicWrite(path, `${JSON.stringify(size)}\n`);
}
