// The little bit of Hyprland omastoic needs: how big the screensaver terminal
// will be, and when one opens or closes.

import { mkdirSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCREENSAVER_CLASS = "org.omarchy.screensaver";

export type Size = { cols: number; rows: number };
export type Cell = { width: number; height: number };
export type CanvasSize = Size & { source: "live" | "cache" | "fallback"; cell: Cell };
export type Monitor = { width: number; height: number; scale?: number; transform?: number };
export type LiveProbe = { grid: Size; pixels?: { width: number; height: number } };

// Last-resort cell if no screensaver has been measured yet. Omarchy runs the
// screensaver at 18pt with no padding; this is 18pt JetBrains Mono at 96 DPI.
export const FALLBACK_CELL: Cell = { width: 14.4, height: 33.3 };

const STATE = join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local/state"), "omastoic");
const CELL_FILE = join(STATE, "cell.json");
const DEFAULT_SIZE: Size = { cols: 92, rows: 24 };

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

/**
 * Pick a canvas grid. A live tty wins; otherwise the smallest monitor using a
 * previously measured cell (or the 18pt fallback).
 */
export function canvasSizeFrom(live: LiveProbe[], monitors: Monitor[], cached: Cell | null): CanvasSize {
  const real = live.filter((probe) => !isPlaceholderGrid(probe.grid));
  if (real.length) {
    const size = minGrid(real.map((probe) => probe.grid)) ?? DEFAULT_SIZE;
    const sample = real.find((probe) => probe.grid.cols === size.cols && probe.grid.rows === size.rows) ?? real[0];
    const cell = (sample.pixels && cellFromPixels(sample.pixels, sample.grid)) || cached || FALLBACK_CELL;
    return { ...size, source: "live", cell };
  }

  const cell = cached ?? FALLBACK_CELL;
  if (!monitors.length) return { ...DEFAULT_SIZE, source: cached ? "cache" : "fallback", cell };

  const size = minGrid(monitors.map((monitor) => gridForPixels(logicalMonitorSize(monitor), cell))) ?? DEFAULT_SIZE;
  return { ...size, source: cached ? "cache" : "fallback", cell };
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

function childrenOf(pid: number): number[] {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (text) return text.split(/\s+/).map(Number).filter((n) => n > 0);
  } catch {
    // some kernels omit this file
  }
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
  try {
    const target = readlinkSync(`/proc/${pid}/fd/0`);
    if (target.startsWith("/dev/pts/") || /^\/dev\/tty\d*$/.test(target)) return target;
  } catch {
    // process gone, or stdin is not a tty
  }
  return null;
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

async function liveProbes(): Promise<LiveProbe[]> {
  const clients = await hyprctlJson(["clients", "-j"]);
  if (!Array.isArray(clients)) return [];
  const probes: LiveProbe[] = [];
  for (const client of clients) {
    if (!client || typeof client !== "object") continue;
    const rec = client as { class?: unknown; pid?: unknown; size?: unknown; mapped?: unknown };
    if (rec.class !== SCREENSAVER_CLASS || rec.mapped === false) continue;
    const pid = rec.pid;
    if (typeof pid !== "number" || pid <= 0) continue;
    const grid = await gridForProcessTree(pid);
    if (!grid) continue;
    const size = rec.size;
    const pixels =
      Array.isArray(size) && typeof size[0] === "number" && typeof size[1] === "number"
        ? { width: size[0], height: size[1] }
        : undefined;
    probes.push({ grid, pixels });
  }
  return probes;
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

  const size = canvasSizeFrom(live, monitors, cached);
  if (size.source === "live") await rememberCell(size.cell);
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
