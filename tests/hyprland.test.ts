import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";
import {
  canvasSizeFrom,
  clampGrid,
  isPlaceholderGrid,
  isScreensaverArgv,
  isTtfxArgv,
  minGrid,
  parseStatTty,
  parseSttySize,
  ptsFromTtyNr,
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

test("the canvas is the smallest real screensaver grid, never an estimate", () => {
  expect(canvasSizeFrom([
    { cols: 80, rows: 24 },
    { cols: 111, rows: 30 },
    { cols: 60, rows: 12 },
  ])).toEqual({ cols: 60, rows: 12, source: "live" });
  expect(canvasSizeFrom([{ cols: 111, rows: 30 }, { cols: 80, rows: 24 }])).toEqual({ cols: 111, rows: 30, source: "live" });
  expect(canvasSizeFrom([{ cols: 80, rows: 24 }])).toEqual({ cols: 92, rows: 24, source: "fallback" });
  expect(canvasSizeFrom([])).toEqual({ cols: 92, rows: 24, source: "fallback" });
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

test("staggered PTYs report the real grid, not a monitor estimate or a cached cell", async () => {
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
        parts = line.split()
        if len(parts) != 3: continue
        index, cols, rows = map(int, parts)
        resize(pairs[index][1], cols, rows)
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
  const stale = `${JSON.stringify({ width: 40, height: 50 })}\n`;
  const sample = async () => {
    const result = await s.exec([process.execPath, "--eval", `import { screensaverSize } from ${JSON.stringify(join(root, "src/hyprland.ts"))}; console.log(JSON.stringify(await screensaverSize()));`]);
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout);
  };
  // 18×40 cells on 1998×1200 and 1080×480. A 14.4×33.3 estimate of the small
  // monitor is 75×14, which is larger than the real 60×12 grid. The planted
  // 40×50 cell would shrink that estimate further if it were still consulted.
  const monitors = '[{"width":1998,"height":1200},{"width":1080,"height":480}]';
  try {
    const pids = JSON.parse(await record()) as number[];
    const client = (pid: number, width: number, height: number) => ({ pid, class: "org.omarchy.screensaver", size: [width, height] });
    s.stub("hyprctl", `if [[ $1 == clients ]]; then cat "$HOME/clients.json"; else echo '${monitors}'; fi`);
    s.put(cell, stale);
    s.put(join(s.home, "clients.json"), JSON.stringify([client(pids[0], 1998, 1200)]));
    expect(await sample()).toEqual({ cols: 111, rows: 30, source: "live" });
    expect(readFileSync(cell, "utf8")).toBe(stale);
    s.put(join(s.home, "clients.json"), JSON.stringify([client(pids[0], 1998, 1200), client(pids[1], 1080, 480)]));
    expect(await sample()).toEqual({ cols: 111, rows: 30, source: "live" });
    expect(readFileSync(cell, "utf8")).toBe(stale);
    fixture.stdin.write("1 60 12\n");
    expect(await record()).toBe("ready");
    expect(await sample()).toEqual({ cols: 60, rows: 12, source: "live" });
    expect(readFileSync(cell, "utf8")).toBe(stale);
  } finally {
    fixture.stdin.end();
    await fixture.exited;
    reader.releaseLock();
    s.cleanup();
  }
});
