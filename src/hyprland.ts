// The little bit of Hyprland omastoic needs: how big the screensaver terminal
// will be, and when one opens or closes.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCREENSAVER_CLASS = "org.omarchy.screensaver";

// Omarchy runs the screensaver terminal at font size 18 with no padding, and a
// terminal scales the font with the monitor, so one cell is this many *logical*
// pixels whichever display it lands on. Measured on foot; alacritty, ghostty and
// kitty land within a column of the same numbers.
const CELL_WIDTH = 14.4;
const CELL_HEIGHT = 33.3;

export type Size = { cols: number; rows: number };

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

/**
 * The grid the screensaver will get, in cells. Taken from the smallest attached
 * monitor so one canvas fits every screen it is thrown onto at once.
 */
export async function screensaverSize(fallback: Size = { cols: 92, rows: 24 }): Promise<Size> {
  try {
    const proc = Bun.spawn(["hyprctl", "monitors", "-j"], { stdout: "pipe", stderr: "ignore" });
    const monitors = JSON.parse(await new Response(proc.stdout).text());
    if (!Array.isArray(monitors) || !monitors.length) return fallback;

    const sizes = monitors.map((m: any) => {
      const scale = m.scale && m.scale > 0 ? m.scale : 1;
      const vertical = m.transform === 1 || m.transform === 3 || m.transform === 5 || m.transform === 7;
      const width = (vertical ? m.height : m.width) / scale;
      const height = (vertical ? m.width : m.height) / scale;
      return {
        cols: Math.floor(width / CELL_WIDTH),
        rows: Math.floor(height / CELL_HEIGHT),
      };
    });

    return {
      cols: Math.max(20, Math.min(...sizes.map((s) => s.cols))),
      rows: Math.max(8, Math.min(...sizes.map((s) => s.rows))),
    };
  } catch {
    return fallback;
  }
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
