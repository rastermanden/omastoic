import { test, expect } from "bun:test";
import {
  FALLBACK_CELL,
  canvasSizeFrom,
  cellFromPixels,
  clampGrid,
  gridForPixels,
  innerPixels,
  isPlaceholderGrid,
  isScreensaverArgv,
  isTtfxArgv,
  logicalMonitorSize,
  minGrid,
  parseCell,
  parseGhosttyMetrics,
  parseStatTty,
  parseSttySize,
  ptsFromTtyNr,
  scaleCell,
  zipLiveProbes,
} from "../src/hyprland.ts";

test("stty size is rows then cols", () => {
  expect(parseSttySize("30 111")).toEqual({ cols: 111, rows: 30 });
  expect(parseSttySize(" 24 80 \n")).toEqual({ cols: 80, rows: 24 });
  expect(parseSttySize("nope")).toBeNull();
  expect(parseSttySize("0 100")).toBeNull();
});

test("the 80x24 mapping placeholder is recognised", () => {
  expect(isPlaceholderGrid({ cols: 80, rows: 24 })).toBe(true);
  expect(isPlaceholderGrid({ cols: 111, rows: 30 })).toBe(false);
});

test("a live 1600x1000 screensaver at the fallback cell is 111x30", () => {
  const pixels = { width: 1600, height: 1000 };
  const grid = gridForPixels(pixels, FALLBACK_CELL);
  expect(grid).toEqual({ cols: 111, rows: 30 });
  const cell = cellFromPixels(pixels, grid);
  expect(cell?.width).toBeCloseTo(14.414, 2);
  expect(cell?.height).toBeCloseTo(33.333, 2);
});

test("logical size divides by scale and swaps on 90° transform", () => {
  expect(logicalMonitorSize({ width: 2560, height: 1600, scale: 1.6 })).toEqual({
    width: 1600,
    height: 1000,
  });
  expect(logicalMonitorSize({ width: 1920, height: 1080, scale: 1, transform: 1 })).toEqual({
    width: 1080,
    height: 1920,
  });
});

test("the canvas is the smallest real screensaver tty, not 80x24", () => {
  const size = canvasSizeFrom(
    [
      { grid: { cols: 80, rows: 24 } },
      { grid: { cols: 111, rows: 30 }, pixels: { width: 1600, height: 1000 } },
      { grid: { cols: 140, rows: 40 }, pixels: { width: 1920, height: 1080 } },
    ],
    [{ width: 2560, height: 1600, scale: 1.6 }],
    null,
  );
  expect(size).toMatchObject({ cols: 111, rows: 30, source: "live" });
  expect(size.cell.width).toBeCloseTo(14.414, 2);
});

test("without a live tty the smallest monitor uses the cached cell", () => {
  const size = canvasSizeFrom(
    [],
    [
      { width: 2560, height: 1600, scale: 1.6 },
      { width: 3840, height: 2160, scale: 2 },
    ],
    { width: 16, height: 32 },
  );
  expect(size.source).toBe("cache");
  expect(size.cols).toBe(Math.min(Math.floor(1600 / 16), Math.floor(1920 / 16)));
  expect(size.rows).toBe(Math.min(Math.floor(1000 / 32), Math.floor(1080 / 32)));
});

test("with neither live nor cache, the 18pt fallback still fills this laptop", () => {
  const size = canvasSizeFrom([], [{ width: 2560, height: 1600, scale: 1.6 }], null);
  expect(size).toMatchObject({ cols: 111, rows: 30, source: "fallback", cell: FALLBACK_CELL });
});

test("cell cache rejects nonsense", () => {
  expect(parseCell({ width: 14.4, height: 33.3 })).toEqual({ width: 14.4, height: 33.3 });
  expect(parseCell({ width: 0, height: 33 })).toBeNull();
  expect(parseCell({ width: 14, height: Number.NaN })).toBeNull();
  expect(parseCell(null)).toBeNull();
});

test("grids are clamped so a tiny probe still lays out", () => {
  expect(clampGrid({ cols: 4, rows: 2 })).toEqual({ cols: 20, rows: 8 });
  expect(minGrid([])).toBeNull();
});

test("UNIX98 pty tty_nr decodes to /dev/pts/N", () => {
  expect(ptsFromTtyNr(34818)).toBe("/dev/pts/2");
  expect(ptsFromTtyNr(0)).toBeNull();
  expect(parseStatTty("2714111 (bash) S 2713868 2714111 2714111 34818 2714111 4194304 1")).toBe("/dev/pts/2");
});

test("screensaver processes are matched by argv, not a substring in a wrapper", () => {
  expect(isScreensaverArgv(["/usr/share/omarchy/bin/omarchy-screensaver"])).toBe(true);
  expect(isScreensaverArgv(["bash", "/usr/share/omarchy/bin/omarchy-screensaver"])).toBe(true);
  expect(isScreensaverArgv(["ghostty", "-e", "omarchy-screensaver"])).toBe(true);
  expect(isScreensaverArgv(["omarchy-launch-screensaver", "force"])).toBe(false);
  expect(isScreensaverArgv(["bash", "-c", "grep omarchy-screensaver"])).toBe(false);
  expect(isTtfxArgv(["/usr/bin/ttfx", "-i", "screensaver.txt"])).toBe(true);
  expect(isTtfxArgv(["bash", "-c", "ttfx"])).toBe(false);
});

test("a Ghostty window at 9pt scales to the screensaver's 18pt cell", () => {
  expect(parseGhosttyMetrics("font-size = 9\nwindow-padding-x = 14\n")).toEqual({
    fontSize: 9,
    padX: 14,
    padY: 14,
  });
  const inner = innerPixels({ width: 433, height: 950 }, { x: 14, y: 14 });
  const cell9 = cellFromPixels(inner, { cols: 56, rows: 57 });
  expect(cell9).toBeTruthy();
  const cell18 = scaleCell(cell9!, 9, 18);
  expect(cell18?.width).toBeCloseTo(14.46, 1);
  expect(cell18?.height).toBeCloseTo(32.4, 1);
  const size = canvasSizeFrom([], [{ width: 2560, height: 1600, scale: 1.6 }], null, cell18);
  expect(size.source).toBe("probe");
  expect(size.cols).toBeGreaterThanOrEqual(100);
  expect(size.rows).toBe(30);
});

test("live probes pair the smallest tty with the smallest window", () => {
  const probes = zipLiveProbes(
    [
      { cols: 140, rows: 40 },
      { cols: 80, rows: 24 },
      { cols: 111, rows: 30 },
    ],
    [
      { width: 1920, height: 1080 },
      { width: 1600, height: 1000 },
    ],
  );
  expect(probes).toEqual([
    { grid: { cols: 111, rows: 30 }, pixels: { width: 1600, height: 1000 } },
    { grid: { cols: 140, rows: 40 }, pixels: { width: 1920, height: 1080 } },
  ]);
});
