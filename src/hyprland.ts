// The little bit of Hyprland omastoic needs: how big the screensaver terminal
// will be, and when one opens or closes.

import { readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCREENSAVER_CLASS = "org.omarchy.screensaver";

export type Size = { cols: number; rows: number };
export type CanvasSize = Size & { source: "live" | "fallback" };

export const DEFAULT_SIZE: Size = { cols: 92, rows: 24 };

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

export function clampGrid(size: Size): Size {
  return { cols: Math.max(1, Math.floor(size.cols)), rows: Math.max(1, Math.floor(size.rows)) };
}

export function minGrid(sizes: Size[]): Size | null {
  if (!sizes.length) return null;
  return clampGrid({
    cols: Math.min(...sizes.map((s) => s.cols)),
    rows: Math.min(...sizes.map((s) => s.rows)),
  });
}

/** Smallest real screensaver grid. An 80×24 mapping placeholder is not one. */
export function canvasSizeFrom(live: Size[]): CanvasSize {
  const size = minGrid(live.filter((grid) => !isPlaceholderGrid(grid)));
  if (size) return { ...size, source: "live" };
  return { ...DEFAULT_SIZE, source: "fallback" };
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

async function gridsFromPids(pids: number[]): Promise<Size[]> {
  const grids: Size[] = [];
  for (const pid of pids) {
    const tty = ttyOf(pid);
    const size = tty ? await sttySize(tty) : await gridForProcessTree(pid);
    if (size) grids.push(size);
  }
  return grids;
}

function screensaverPids(clients: unknown): number[] {
  if (!Array.isArray(clients)) return [];
  const pids: number[] = [];
  for (const client of clients) {
    if (!client || typeof client !== "object") continue;
    const rec = client as { class?: unknown; pid?: unknown; mapped?: unknown };
    if (rec.class !== SCREENSAVER_CLASS || rec.mapped === false) continue;
    const pid = rec.pid;
    if (typeof pid !== "number" || pid <= 0) continue;
    pids.push(pid);
  }
  return pids;
}

async function readScreensaverGrids(): Promise<Size[]> {
  // Ghostty (GTK single-instance) reports the same pid for every window, and
  // `/proc/<pid>/task/<pid>/children` often omits the shell. Walk from the
  // window pid would hit the user's ordinary tty. Find omarchy-screensaver /
  // ttfx by cmdline instead; those own the screensaver pts.
  let grids = await gridsFromPids(pidsWhere(isScreensaverArgv));
  if (!grids.length) grids = await gridsFromPids(pidsWhere(isTtfxArgv));
  if (grids.length) return grids;

  const seen = new Set<number>();
  for (const pid of screensaverPids(await hyprctlJson(["clients", "-j"]))) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const grid = await gridForProcessTree(pid);
    if (grid) grids.push(grid);
  }
  return grids;
}

/** The grid a canvas should use: the smallest live screensaver tty, or 92×24. */
export async function screensaverSize(): Promise<CanvasSize> {
  try {
    return canvasSizeFrom(await readScreensaverGrids());
  } catch {
    return { ...DEFAULT_SIZE, source: "fallback" };
  }
}

/** Poll until a screensaver tty has resized off the 80x24 placeholder. */
export async function waitForLiveGrid(timeoutMs = 2000): Promise<CanvasSize | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = await screensaverSize();
    if (size.source === "live") return size;
    await Bun.sleep(20);
  }
  const size = await screensaverSize();
  return size.source === "live" ? size : null;
}

export type WindowEvent = { kind: "open" | "close"; address: string } | { kind: "sync"; addresses: string[] };

async function snapshotWindows(): Promise<string[]> {
  const clients = await hyprctlJson(["clients", "-j"]);
  if (!Array.isArray(clients)) throw new Error("cannot reconcile Hyprland clients");
  return clients.flatMap((c) => c?.class === SCREENSAVER_CLASS && c.mapped !== false && typeof c.address === "string" ? [c.address.replace(/^0x/, "")] : []);
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  if (signal?.aborted) done();
});

/** Subscribe before snapshotting, then replay buffered records. Every reconnect
 * replaces stale state, including closes that occurred during disconnection. */
export async function* screensaverWindowEvents(signal?: AbortSignal, reconnectMs = 2000): AsyncGenerator<WindowEvent> {
  while (!signal?.aborted) {
    const path = socketPath();
    if (!path) {
      await sleep(reconnectMs, signal);
      continue;
    }

    let queue: WindowEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let pending = "";
    const decoder = new TextDecoder();

    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, chunk) {
          pending += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (line.length > 65536) { closed = true; break; }
            if (line.startsWith("openwindow>>")) {
              const [address, , windowClass] = line.slice("openwindow>>".length).split(",");
              if (address && windowClass === SCREENSAVER_CLASS) queue.push({ kind: "open", address: address.replace(/^0x/, "") });
            } else if (line.startsWith("closewindow>>")) {
              const address = line.slice("closewindow>>".length).trim().replace(/^0x/, "");
              if (address) queue.push({ kind: "close", address });
            }
            if (queue.length > 4096) { closed = true; break; }
          }
          if (pending.length > 65536) closed = true;
          if (closed) _socket.end();
          if (queue.length || closed) wake?.();
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
      await sleep(reconnectMs, signal);
      continue;
    }

    const onAbort = () => {
      closed = true;
      wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      const addresses = await snapshotWindows();
      if (!closed) yield { kind: "sync", addresses };
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
    } catch (error) {
      if (!signal?.aborted) console.error(`omastoic: ${String(error)}; reconnecting`);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      socket.end();
    }

    if (!signal?.aborted) await sleep(reconnectMs, signal); // compositor restarting
  }
}
