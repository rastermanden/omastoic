// The little bit of Hyprland omastoic needs: how big the screensaver terminal
// will be, and when one opens or closes.

import { mkdirSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCREENSAVER_CLASS = "org.omarchy.screensaver";

export type Size = { cols: number; rows: number };
export type Cell = { width: number; height: number };
export type CanvasSize = Size & { source: "live" | "cache" | "probe" | "fallback"; cell: Cell };
export type Monitor = { width: number; height: number; scale?: number; transform?: number };
export type LiveProbe = { grid: Size; pixels?: { width: number; height: number } };

// Last-resort cell if no screensaver has been measured yet. Omarchy runs the
// screensaver at 18pt with no padding; this is 18pt JetBrains Mono at 96 DPI.
export const FALLBACK_CELL: Cell = { width: 14.4, height: 33.3 };

const STATE = join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local/state"), "omastoic");
const CELL_FILE = join(STATE, "cell.json");
const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
const DEFAULT_SIZE: Size = { cols: 92, rows: 24 };
const SCREENSAVER_FONT_SIZE = 18;

let memoryCell: Cell | null = null;

export function socketPath(): string | null {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) return null;
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (signature) return join(runtime, "hypr", signature, ".socket2.sock");

  // Started without the compositor's environment: take the most recent instance.
  const dir = join(runtime, "hypr");
  try {
    const instances = readdirSync(dir)
      .map((name) => ({ name, path: join(dir, name, ".socket2.sock") }))
      .filter((i) => {
        try {
          return statSync(i.path).isSocket();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
    return instances[0]?.path ?? null;
  } catch {
    return null;
  }
}

/** Terminals map at 80x24 and only then resize; ttfx waits until this is gone. */
export function isPlaceholderGrid(size: Size): boolean {
  return size.cols === 80 && size.rows === 24;
}

export function parseSttySize(text: string): Size | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const rows = Number(parts[0]);
  const cols = Number(parts[1]);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return null;
  return { cols, rows };
}

export function parseCell(raw: unknown): Cell | null {
  if (!raw || typeof raw !== "object") return null;
  const width = (raw as { width?: unknown }).width;
  const height = (raw as { height?: unknown }).height;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 4 || width > 40 || height < 8 || height > 80) return null;
  return { width, height };
}

export function clampGrid(size: Size): Size {
  return { cols: Math.max(20, size.cols), rows: Math.max(8, size.rows) };
}

export function minGrid(sizes: Size[]): Size | null {
  if (!sizes.length) return null;
  return clampGrid({
    cols: Math.min(...sizes.map((s) => s.cols)),
    rows: Math.min(...sizes.map((s) => s.rows)),
  });
}

export function logicalMonitorSize(monitor: Monitor): { width: number; height: number } {
  const scale = monitor.scale && monitor.scale > 0 ? monitor.scale : 1;
  const vertical = monitor.transform === 1 || monitor.transform === 3 || monitor.transform === 5 || monitor.transform === 7;
  const width = (vertical ? monitor.height : monitor.width) / scale;
  const height = (vertical ? monitor.width : monitor.height) / scale;
  return { width, height };
}

export function gridForPixels(pixels: { width: number; height: number }, cell: Cell): Size {
  return clampGrid({
    cols: Math.floor(pixels.width / cell.width),
    rows: Math.floor(pixels.height / cell.height),
  });
}

export function cellFromPixels(pixels: { width: number; height: number }, grid: Size): Cell | null {
  if (grid.cols < 1 || grid.rows < 1) return null;
  const width = pixels.width / grid.cols;
  const height = pixels.height / grid.rows;
  return parseCell({ width, height });
}

export function innerPixels(
  window: { width: number; height: number },
  pad: { x: number; y: number },
): { width: number; height: number } {
  return {
    width: Math.max(1, window.width - 2 * Math.max(0, pad.x)),
    height: Math.max(1, window.height - 2 * Math.max(0, pad.y)),
  };
}

export function scaleCell(cell: Cell, fromPt: number, toPt: number): Cell | null {
  if (!(fromPt > 0) || !(toPt > 0)) return null;
  return parseCell({ width: cell.width * (toPt / fromPt), height: cell.height * (toPt / fromPt) });
}

export function parseGhosttyMetrics(text: string): { fontSize: number; padX: number; padY: number } {
  const fontSize = Number(/^\s*font-size\s*=\s*([\d.]+)/m.exec(text)?.[1]) || 0;
  const padX = Number(/^\s*window-padding-x\s*=\s*([\d.]+)/m.exec(text)?.[1]) || 0;
  const padYMatch = /^\s*window-padding-y\s*=\s*([\d.]+)/m.exec(text);
  const padY = padYMatch ? Number(padYMatch[1]) : padX;
  return { fontSize, padX, padY };
}

export function parseFootMetrics(text: string): { fontSize: number; padX: number; padY: number } {
  const fontSize = Number(/size=([\d.]+)/.exec(text)?.[1]) || 0;
  const pad = /pad=([\d.]+)x([\d.]+)/.exec(text);
  return { fontSize, padX: pad ? Number(pad[1]) : 0, padY: pad ? Number(pad[2]) : 0 };
}

export function parseKittyMetrics(text: string): { fontSize: number; padX: number; padY: number } {
  const fontSize = Number(/^\s*font_size\s+([\d.]+)/m.exec(text)?.[1]) || 0;
  const pad = Number(/^\s*window_padding_width\s+([\d.]+)/m.exec(text)?.[1]) || 0;
  return { fontSize, padX: pad, padY: pad };
}

export function parseAlacrittyMetrics(text: string): { fontSize: number; padX: number; padY: number } {
  const fontSize = Number(/^\s*size\s*=\s*([\d.]+)/m.exec(text)?.[1]) || 0;
  const padX = Number(/padding\.x\s*=\s*([\d.]+)/.exec(text)?.[1]) || 0;
  const padY = Number(/padding\.y\s*=\s*([\d.]+)/.exec(text)?.[1]) || padX;
  return { fontSize, padX, padY };
}

/**
 * Pick a canvas grid. A live tty wins; otherwise the smallest monitor using a
 * previously measured cell, a cell scaled from an open terminal, or the 18pt fallback.
 */
export function canvasSizeFrom(
  live: LiveProbe[],
  monitors: Monitor[],
  cached: Cell | null,
  probed: Cell | null = null,
): CanvasSize {
  const real = live.filter((probe) => !isPlaceholderGrid(probe.grid));
  if (real.length) {
    const size = minGrid(real.map((probe) => probe.grid)) ?? DEFAULT_SIZE;
    const sample = real.find((probe) => probe.grid.cols === size.cols && probe.grid.rows === size.rows) ?? real[0];
    const cell = (sample.pixels && cellFromPixels(sample.pixels, sample.grid)) || cached || probed || FALLBACK_CELL;
    return { ...size, source: "live", cell };
  }

  const cell = cached ?? probed ?? FALLBACK_CELL;
  const source = cached ? "cache" : probed ? "probe" : "fallback";
  if (!monitors.length) return { ...DEFAULT_SIZE, source, cell };

  const size = minGrid(monitors.map((monitor) => gridForPixels(logicalMonitorSize(monitor), cell))) ?? DEFAULT_SIZE;
  return { ...size, source, cell };
}

async function hyprctlJson(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(["hyprctl", ...args], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** UNIX98 PTY slaves are major 136; `/proc/pid/stat` encodes that as tty_nr. */
export function ptsFromTtyNr(ttyNr: number): string | null {
  if (!Number.isInteger(ttyNr) || ttyNr <= 0) return null;
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  if (major !== 136) return null;
  return `/dev/pts/${minor}`;
}

export function parseStatTty(stat: string): string | null {
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) return null;
  const ttyNr = Number(stat.slice(rparen + 2).split(" ")[4]);
  return ptsFromTtyNr(ttyNr);
}

export function isScreensaverArgv(argv: string[]): boolean {
  return argv.some((arg) => arg === "omarchy-screensaver" || arg.endsWith("/omarchy-screensaver"));
}

export function isTtfxArgv(argv: string[]): boolean {
  return (argv[0]?.split("/").pop() ?? "") === "ttfx";
}

function procArgv(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function pidsWhere(pred: (argv: string[]) => boolean): number[] {
  const pids: number[] = [];
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const argv = procArgv(Number(name));
      if (argv && pred(argv)) pids.push(Number(name));
    }
  } catch {
    // /proc not readable
  }
  return pids;
}

function childrenOf(pid: number): number[] {
  const found = new Set<number>();
  try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      try {
        const text = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
        for (const n of text.split(/\s+/).map(Number)) if (n > 0) found.add(n);
      } catch {
        // task gone
      }
    }
  } catch {
    // process gone
  }
  if (found.size) return [...found];
  const proc = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
  if (proc.exitCode !== 0) return [];
  return proc.stdout
    .toString()
    .trim()
    .split("\n")
    .map(Number)
    .filter((n) => n > 0);
}

function ttyOf(pid: number): string | null {
  for (const fd of ["0", "1", "2"]) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (target.startsWith("/dev/pts/") || /^\/dev\/tty\d*$/.test(target)) return target;
    } catch {
      // fd gone, or not a tty
    }
  }
  try {
    return parseStatTty(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function sttySize(tty: string): Promise<Size | null> {
  const proc = Bun.spawn(["stty", "-F", tty, "size"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) return null;
  return parseSttySize(out);
}

async function gridForProcessTree(pid: number): Promise<Size | null> {
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const tty = ttyOf(current);
    if (tty) {
      const size = await sttySize(tty);
      if (size) return size;
    }
    queue.push(...childrenOf(current));
  }
  return null;
}

export function zipLiveProbes(grids: Size[], windows: { width: number; height: number }[]): LiveProbe[] {
  const real = grids.filter((grid) => !isPlaceholderGrid(grid));
  const sortedGrids = [...real].sort((a, b) => a.cols - b.cols || a.rows - b.rows);
  const sortedWindows = [...windows].sort((a, b) => a.width - b.width || a.height - b.height);
  return sortedGrids.map((grid, i) => ({ grid, pixels: sortedWindows[i] }));
}

async function gridsFromPids(pids: number[]): Promise<Size[]> {
  const grids: Size[] = [];
  for (const pid of pids) {
    const tty = ttyOf(pid);
    const size = tty ? await sttySize(tty) : await gridForProcessTree(pid);
    if (size) grids.push(size);
  }
  return grids;
}

function screensaverWindows(clients: unknown): { width: number; height: number; pid: number }[] {
  if (!Array.isArray(clients)) return [];
  const windows: { width: number; height: number; pid: number }[] = [];
  for (const client of clients) {
    if (!client || typeof client !== "object") continue;
    const rec = client as { class?: unknown; pid?: unknown; size?: unknown; mapped?: unknown };
    if (rec.class !== SCREENSAVER_CLASS || rec.mapped === false) continue;
    const pid = rec.pid;
    const size = rec.size;
    if (typeof pid !== "number" || pid <= 0) continue;
    if (!Array.isArray(size) || typeof size[0] !== "number" || typeof size[1] !== "number") continue;
    windows.push({ width: size[0], height: size[1], pid });
  }
  return windows;
}

async function liveProbes(): Promise<LiveProbe[]> {
  // Ghostty (GTK single-instance) reports the same pid for every window, and
  // `/proc/<pid>/task/<pid>/children` often omits the shell. Walk from the
  // window pid would hit the user's ordinary tty. Find omarchy-screensaver /
  // ttfx by cmdline instead; those own the screensaver pts.
  let grids = await gridsFromPids(pidsWhere(isScreensaverArgv));
  if (!grids.length) grids = await gridsFromPids(pidsWhere(isTtfxArgv));

  const windows = screensaverWindows(await hyprctlJson(["clients", "-j"]));
  if (!grids.length) {
    const seen = new Set<number>();
    for (const win of windows) {
      if (seen.has(win.pid)) continue;
      seen.add(win.pid);
      const grid = await gridForProcessTree(win.pid);
      if (grid) grids.push(grid);
    }
  }
  return zipLiveProbes(
    grids,
    windows.map(({ width, height }) => ({ width, height })),
  );
}

async function loadCachedCell(): Promise<Cell | null> {
  if (memoryCell) return memoryCell;
  try {
    memoryCell = parseCell(JSON.parse(readFileSync(CELL_FILE, "utf8")));
  } catch {
    memoryCell = null;
  }
  return memoryCell;
}

async function rememberCell(cell: Cell): Promise<void> {
  const same = memoryCell && memoryCell.width === cell.width && memoryCell.height === cell.height;
  memoryCell = cell;
  if (same) return;
  try {
    mkdirSync(STATE, { recursive: true });
    await Bun.write(CELL_FILE, `${JSON.stringify(cell)}\n`);
  } catch {
    // state dir not writable; in-memory cache still helps this process
  }
}

type TerminalKind = "ghostty" | "foot" | "kitty" | "alacritty";

function defaultTerminalKind(): TerminalKind | null {
  const proc = Bun.spawnSync(["xdg-terminal-exec", "--print-id"], { stdout: "pipe", stderr: "ignore" });
  const id = proc.stdout.toString().toLowerCase();
  if (id.includes("ghostty")) return "ghostty";
  if (id.includes("foot")) return "foot";
  if (id.includes("kitty")) return "kitty";
  if (id.includes("alacritty")) return "alacritty";
  return null;
}

function classMatchesTerminal(kind: TerminalKind, className: string): boolean {
  const name = className.toLowerCase();
  if (kind === "ghostty") return name.includes("ghostty");
  if (kind === "foot") return name.includes("foot");
  if (kind === "kitty") return name.includes("kitty");
  return name.includes("alacritty");
}

function userMetrics(kind: TerminalKind): { fontSize: number; padX: number; padY: number } {
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  if (kind === "ghostty") return parseGhosttyMetrics(read(join(CONFIG_HOME, "ghostty/config")));
  if (kind === "foot") return parseFootMetrics(read(join(CONFIG_HOME, "foot/foot.ini")));
  if (kind === "kitty") return parseKittyMetrics(read(join(CONFIG_HOME, "kitty/kitty.conf")));
  return parseAlacrittyMetrics(read(join(CONFIG_HOME, "alacritty/alacritty.toml")));
}

async function probeCellFromOpenTerminal(): Promise<Cell | null> {
  const kind = defaultTerminalKind();
  if (!kind) return null;
  const metrics = userMetrics(kind);
  if (!(metrics.fontSize > 0)) return null;

  const clients = await hyprctlJson(["clients", "-j"]);
  if (!Array.isArray(clients)) return null;
  const windows: { width: number; height: number; pid: number }[] = [];
  for (const client of clients) {
    if (!client || typeof client !== "object") continue;
    const rec = client as { class?: unknown; pid?: unknown; size?: unknown; mapped?: unknown };
    if (rec.class === SCREENSAVER_CLASS || rec.mapped === false) continue;
    if (!classMatchesTerminal(kind, String(rec.class ?? ""))) continue;
    const pid = rec.pid;
    const size = rec.size;
    if (typeof pid !== "number" || pid <= 0) continue;
    if (!Array.isArray(size) || typeof size[0] !== "number" || typeof size[1] !== "number") continue;
    windows.push({ width: size[0], height: size[1], pid });
  }
  if (!windows.length) return null;
  windows.sort((a, b) => b.width * b.height - a.width * a.height);
  const win = windows[0];
  const grid = await gridForProcessTree(win.pid);
  if (!grid || isPlaceholderGrid(grid)) return null;
  const cell = cellFromPixels(innerPixels(win, { x: metrics.padX, y: metrics.padY }), grid);
  if (!cell) return null;
  return scaleCell(cell, metrics.fontSize, SCREENSAVER_FONT_SIZE);
}

/**
 * The grid the screensaver will get, in cells. Prefers a live tty readout from
 * an open screensaver; otherwise the smallest monitor using a measured cell.
 */
export async function screensaverSize(): Promise<CanvasSize> {
  const cached = await loadCachedCell();
  let live: LiveProbe[] = [];
  let monitors: Monitor[] = [];
  try {
    live = await liveProbes();
    const raw = await hyprctlJson(["monitors", "-j"]);
    if (Array.isArray(raw)) monitors = raw as Monitor[];
  } catch {
    // compositor not up
  }

  let probed: Cell | null = null;
  if (!live.some((probe) => !isPlaceholderGrid(probe.grid)) && !cached) {
    probed = await probeCellFromOpenTerminal().catch(() => null);
  }

  const size = canvasSizeFrom(live, monitors, cached, probed);
  if (size.source === "live" || size.source === "probe") await rememberCell(size.cell);
  return size;
}

/** Poll until a screensaver tty has resized off the 80x24 placeholder. */
export async function waitForLiveGrid(timeoutMs = 2000): Promise<CanvasSize | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = (await liveProbes()).filter((probe) => !isPlaceholderGrid(probe.grid));
    if (live.length) {
      const size = await screensaverSize();
      if (size.source === "live") return size;
    }
    await Bun.sleep(20);
  }
  const size = await screensaverSize();
  return size.source === "live" ? size : null;
}

export type WindowEvent = { kind: "open" | "close"; address: string };

/**
 * Yield screensaver window open/close events from Hyprland's event socket, and
 * keep yielding across compositor restarts. `openwindow` carries the class;
 * `closewindow` carries only an address, so callers match it against what they
 * saw open.
 */
export async function* screensaverWindowEvents(signal?: AbortSignal): AsyncGenerator<WindowEvent> {
  while (!signal?.aborted) {
    const path = socketPath();
    if (!path) {
      await Bun.sleep(5000);
      continue;
    }

    let queue: WindowEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;

    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, chunk) {
          for (const line of chunk.toString().split("\n")) {
            if (line.startsWith("openwindow>>")) {
              const [address, , windowClass] = line.slice("openwindow>>".length).split(",");
              if (windowClass === SCREENSAVER_CLASS) queue.push({ kind: "open", address });
            } else if (line.startsWith("closewindow>>")) {
              queue.push({ kind: "close", address: line.slice("closewindow>>".length).trim() });
            }
          }
          wake?.();
        },
        close() {
          closed = true;
          wake?.();
        },
        error() {
          closed = true;
          wake?.();
        },
      },
    }).catch(() => null);

    if (!socket) {
      await Bun.sleep(5000);
      continue;
    }

    const onAbort = () => {
      closed = true;
      wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!closed) {
        if (!queue.length) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        const batch = queue;
        queue = [];
        yield* batch;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      socket.end();
    }

    if (!signal?.aborted) await Bun.sleep(2000); // compositor restarting
  }
}
