import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePanelSize,
  PANEL_SIZE_MAX_BYTES,
  PANEL_SIZE_MAX_STORED,
  PANEL_SIZE_MIN_STORED,
  parsePanelSizeCommand,
  readPanelSize,
  writePanelSize,
} from "../src/panel-size.ts";

test("normalizePanelSize accepts valid dimensions (including compact theme minimums) and rounds fractional pixels", () => {
  expect(normalizePanelSize({ width: 640, height: 520 })).toEqual({ width: 640, height: 520 });
  expect(normalizePanelSize({ width: 240, height: 192 })).toEqual({ width: 240, height: 192 });
  expect(normalizePanelSize({ width: 640.4 })).toEqual({ width: 640 });
  expect(normalizePanelSize({ height: 520.6 })).toEqual({ height: 521 });
  expect(normalizePanelSize({ width: PANEL_SIZE_MIN_STORED, height: PANEL_SIZE_MAX_STORED })).toEqual({
    width: PANEL_SIZE_MIN_STORED,
    height: PANEL_SIZE_MAX_STORED,
  });
});

test("normalizePanelSize rejects empty, non-object, null, non-finite, or out-of-range inputs", () => {
  for (const bad of [
    null,
    undefined,
    [],
    "640x480",
    {},
    { width: null },
    { height: null },
    { width: null, height: null },
    { width: 640, height: null },
    { width: PANEL_SIZE_MIN_STORED - 1 },
    { height: PANEL_SIZE_MAX_STORED + 1 },
    { width: -100, height: 500 },
    { width: Number.NaN, height: 500 },
    { width: Number.POSITIVE_INFINITY },
    { width: "640" },
  ]) {
    expect(normalizePanelSize(bad)).toBeNull();
  }
});

test("parsePanelSizeCommand handles width, height, reset, and rejects bad payloads", () => {
  expect(parsePanelSizeCommand('{"width":720,"height":600}')).toEqual({ ok: true, size: { width: 720, height: 600 } });
  expect(parsePanelSizeCommand('{"width":720}')).toEqual({ ok: true, size: { width: 720 } });
  expect(parsePanelSizeCommand('{"width":240,"height":192}')).toEqual({ ok: true, size: { width: 240, height: 192 } });
  expect(parsePanelSizeCommand('{"reset":false,"width":640}')).toEqual({ ok: true, size: { width: 640 } });
  expect(parsePanelSizeCommand('{"reset":true}')).toEqual({ ok: true, size: null });
  expect(parsePanelSizeCommand("{}")).toEqual({ ok: true, size: null });

  for (const bad of [
    "not json",
    "null",
    "[]",
    '{"width":50}',
    '{"height":99999}',
    '{"width":"700"}',
    '{"width":null}',
    '{"height":null}',
    '{"reset":false}',
    '{"reset":"yes"}',
    '{"reset":true,"width":600}',
    '{"reset":true,"width":null}',
    '{"width":600,"extra":1}',
  ]) {
    expect(parsePanelSizeCommand(bad).ok, bad).toBe(false);
  }
});

test("readPanelSize and writePanelSize round-trip, reset, ignore corrupt state, and refuse symlinks consistently", () => {
  const scratch = mkdtempSync(join(tmpdir(), "omastoic-panel-size-"));
  try {
    const file = join(scratch, "state", "panel-size.json");

    // Missing file returns null without creating directories.
    expect(readPanelSize(file)).toBeNull();
    expect(existsSync(join(scratch, "state"))).toBe(false);

    // Write creates parent dir and stores JSON.
    writePanelSize(file, { width: 700, height: 560 });
    expect(readPanelSize(file)).toEqual({ width: 700, height: 560 });
    expect(readFileSync(file, "utf8")).toBe('{"width":700,"height":560}\n');

    // Reset removes the file cleanly and is idempotent.
    writePanelSize(file, null);
    expect(existsSync(file)).toBe(false);
    writePanelSize(file, null);
    expect(readPanelSize(file)).toBeNull();

    // Corrupt, oversized, or directory entries fall back to null without throwing.
    writeFileSync(file, "{broken json");
    expect(readPanelSize(file)).toBeNull();
    writeFileSync(file, " ".repeat(PANEL_SIZE_MAX_BYTES + 16));
    expect(readPanelSize(file)).toBeNull();
    rmSync(file);

    // Directories are refused on read, write, and reset.
    const dirTarget = join(scratch, "dir-as-size");
    mkdirSync(dirTarget);
    expect(readPanelSize(dirTarget)).toBeNull();
    expect(() => writePanelSize(dirTarget, { width: 640 })).toThrow("refusing to replace non-file");
    expect(() => writePanelSize(dirTarget, null)).toThrow("refusing to remove non-file");

    // Symlinks are never followed on read, write, or reset, leaving target untouched.
    const realTarget = join(scratch, "real.json");
    const linkPath = join(scratch, "link.json");
    writeFileSync(realTarget, "do not overwrite\n");
    symlinkSync(realTarget, linkPath);
    expect(readPanelSize(linkPath)).toBeNull();
    expect(() => writePanelSize(linkPath, { width: 620 })).toThrow("refusing to replace non-file");
    expect(readFileSync(realTarget, "utf8")).toBe("do not overwrite\n");
    expect(() => writePanelSize(linkPath, null)).toThrow("refusing to remove non-file");
    expect(readFileSync(realTarget, "utf8")).toBe("do not overwrite\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
