import { test, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";
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
  liveProbesFrom,
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
  expect(gridForPixels(pixels, cell!)).toEqual({ cols: 111, rows: 30 });
  expect(gridForPixels({ width: 1553.5, height: 899.5 }, { width: 14, height: 30 })).toEqual({ cols: 110, rows: 29 });
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

test("live sizing reserves both axes for pending, opening and replacement outputs", () => {
  const large = { grid: { cols: 111, rows: 30 }, pixels: { width: 1554, height: 900 } };
  const narrow = { grid: { cols: 60, rows: 30 }, pixels: { width: 840, height: 900 } };
  const short = { grid: { cols: 111, rows: 12 }, pixels: { width: 1554, height: 360 } };
  const monitors = [large, narrow, short].map((probe) => probe.pixels);
  for (const live of [[large], [large, narrow], [large, narrow, short], [narrow, short], [short]]) {
    expect(canvasSizeFrom(live, monitors, null)).toMatchObject({ cols: 60, rows: 12, source: "live" });
  }
  expect(canvasSizeFrom([large], [large.pixels, { width: 840, height: 360 }], null)).toMatchObject({ cols: 60, rows: 12 });
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

test("tiny probes are not inflated beyond the real terminal", () => {
  expect(clampGrid({ cols: 4, rows: 2 })).toEqual({ cols: 4, rows: 2 });
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

test("independent samples calibrate only a single unambiguous grid and window", () => {
  const large = { cols: 111, rows: 30 };
  const small = { cols: 60, rows: 12 };
  const placeholder = { cols: 80, rows: 24 };
  const windows = [{ width: 1554, height: 900 }, { width: 840, height: 360 }];
  expect(liveProbesFrom([large], [windows[0]])).toEqual([{ grid: large, pixels: windows[0] }]);
  for (const grids of [[large, placeholder], [large], [placeholder, large], [large, small]]) {
    const probes = liveProbesFrom(grids, windows);
    expect(probes.every((probe) => probe.pixels === undefined)).toBe(true);
    for (const cached of [null, { width: 14, height: 30 }]) {
      const size = canvasSizeFrom(probes, windows, cached);
      expect(size.cols).toBeLessThanOrEqual(60);
      expect(size.rows).toBeLessThanOrEqual(12);
    }
  }
  expect(liveProbesFrom([large, placeholder], [windows[0]])).toEqual([{ grid: large, pixels: undefined }]);
});

test("real staggered PTYs fit pending outputs without poisoning cell calibration", async () => {
  const s = sandbox();
  const fixture = Bun.spawn(["python3", "-u", "-c", `import fcntl, json, os, pty, struct, subprocess, sys, termios
pairs = [pty.openpty(), pty.openpty()]
children = []
def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
try:
    for (master, slave), (cols, rows) in zip(pairs, [(111, 30), (80, 24)]):
        resize(slave, cols, rows)
        children.append(subprocess.Popen(['sleep', '60'], stdin=slave, stdout=slave, stderr=slave))
    print(json.dumps([child.pid for child in children]), flush=True)
    for line in sys.stdin:
        resize(pairs[1][1], 60, 12)
        print('ready', flush=True)
finally:
    for child in children:
        child.terminate()
        child.wait()
    for master, slave in pairs:
        os.close(master)
        os.close(slave)
`], { env: s.env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = fixture.stdout.getReader();
  const record = async () => {
    let text = "";
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("PTY fixture exited before readiness");
      text += new TextDecoder().decode(value);
    }
    return text.trim();
  };
  const cell = join(s.state, "cell.json");
  const sample = async () => {
    const result = await s.exec([process.execPath, "--eval", `import { screensaverSize } from ${JSON.stringify(join(root, "src/hyprland.ts"))}; console.log(JSON.stringify(await screensaverSize()));`]);
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    const pids = JSON.parse(await record());
    const clients = pids.map((pid: number, i: number) => ({ pid, class: "org.omarchy.screensaver", size: i === 0 ? [1554, 900] : [840, 360] }));
    s.stub("hyprctl", 'if [[ $1 == clients ]]; then cat "$HOME/clients.json"; else echo \'[{"width":1554,"height":900},{"width":840,"height":360}]\'; fi');
    s.put(join(s.home, "clients.json"), JSON.stringify(clients.slice(0, 1)));
    expect(await sample()).toMatchObject({ cols: 60, rows: 12 });
    expect(JSON.parse(readFileSync(cell, "utf8"))).toEqual({ width: 14, height: 30 });
    s.put(join(s.home, "clients.json"), JSON.stringify(clients));
    expect(await sample()).toMatchObject({ cols: 60, rows: 12 });
    expect(JSON.parse(readFileSync(cell, "utf8"))).toEqual({ width: 14, height: 30 });
    rmSync(cell);
    const pending = await sample();
    expect(pending.cols).toBeLessThanOrEqual(60);
    expect(pending.rows).toBeLessThanOrEqual(12);
    expect(existsSync(cell)).toBe(false);
    fixture.stdin.write("resize\n");
    expect(await record()).toBe("ready");
    const settled = await sample();
    expect(settled.cols).toBeLessThanOrEqual(60);
    expect(settled.rows).toBeLessThanOrEqual(12);
    expect(existsSync(cell)).toBe(false);
  } finally {
    fixture.stdin.end();
    await fixture.exited;
    reader.releaseLock();
    s.cleanup();
  }
});
