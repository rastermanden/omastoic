import { test, expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compose, parseQuotes } from "../src/canvas.ts";
import { root, sandbox } from "./sandbox.ts";

async function probe(s: ReturnType<typeof sandbox>, count: number) {
  const code = `import { screensaverWindowEvents } from ${JSON.stringify(join(root, "src/hyprland.ts"))};
const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2000);
let count = 0;
try { for await (const event of screensaverWindowEvents(controller.signal, 20)) { console.log(JSON.stringify(event)); if (++count >= ${count}) break; } }
finally { controller.abort(); clearTimeout(timer); }`;
  const result = await s.exec([process.execPath, "--eval", code]);
  expect(result.code).toBe(0);
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

for (const fragmented of [false, true]) {
  test(`real UNIX socket framing (${fragmented ? "fragmented UTF-8/records" : "one chunk"})`, async () => {
    const s = sandbox();
    const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
    mkdirSync(dirname(socket), { recursive: true });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = Bun.listen({ unix: socket, socket: {
      open(peer) {
        const record = Buffer.from("openwindow>>abc,1,org.omarchy.screensaver,哲学\nclosewindow>>abc\n");
        if (!fragmented) timers.push(setTimeout(() => peer.write(record), 80));
        else {
          const chunks = [record.subarray(0, 7), record.subarray(7, record.length - 27), record.subarray(record.length - 27, record.length - 26), record.subarray(record.length - 26)];
          chunks.forEach((chunk, i) => timers.push(setTimeout(() => peer.write(chunk), 80 + i * 20)));
        }
      }, data() {},
    } });
    try {
      expect(await probe(s, 3)).toEqual([{ kind: "sync", addresses: [] }, { kind: "open", address: "abc" }, { kind: "close", address: "abc" }]);
    } finally { timers.forEach(clearTimeout); server.stop(true); s.cleanup(); }
  });
}

test("reconnect replaces an existing-window snapshot, clearing missed closes", async () => {
  const s = sandbox();
  s.put(join(s.home, "clients.json"), JSON.stringify([{ address: "0xabc", class: "org.omarchy.screensaver" }]));
  const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
  mkdirSync(dirname(socket), { recursive: true });
  let connections = 0;
  let timer: ReturnType<typeof setTimeout>;
  const server = Bun.listen({ unix: socket, socket: {
    open(peer) {
      if (++connections === 1) timer = setTimeout(() => { s.put(join(s.home, "clients.json"), "[]"); peer.end(); }, 100);
    }, data() {},
  } });
  try { expect(await probe(s, 2)).toEqual([{ kind: "sync", addresses: ["abc"] }, { kind: "sync", addresses: [] }]); }
  finally { clearTimeout(timer!); server.stop(true); s.cleanup(); }
});

test("mixed-output opens, closes and reconnects preserve the quote and reading deadline", async () => {
  const s = sandbox();
  const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const history = () => readFileSync(join(s.state, "recent.json"), "utf8");
  const clients = (addresses: string[]) => s.put(join(s.home, "clients.json"), JSON.stringify(addresses.map((address) => ({ address, class: "org.omarchy.screensaver" }))));
  const until = async (check: () => boolean, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Bun.sleep(20);
    expect(check()).toBe(true);
  };
  mkdirSync(dirname(socket), { recursive: true });
  s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 6 }));
  clients(["large"]);
  s.stub("hyprctl", 'if [[ $1 == clients ]]; then cat "$HOME/clients.json"; else echo \'[{"width":1554,"height":900},{"width":840,"height":360}]\'; fi');
  let connections = 0;
  let connectedAt = 0;
  let peer: Bun.Socket<undefined> | undefined;
  const server = Bun.listen({ unix: socket, socket: {
    open(socket) { peer = socket; connections++; if (!connectedAt) connectedAt = Date.now(); }, data() {},
  } });
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    daemon = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "daemon"], { cwd: root, env: s.env, stdout: "ignore", stderr: "ignore" });
    await until(() => connections === 1);
    await Bun.sleep(200);
    const initialHistory = history();
    const canvas = readFileSync(branding, "utf8");
    await Bun.sleep(800);
    clients(["large", "small"]);
    peer!.write("openwindow>>small,1,org.omarchy.screensaver,title\n");
    await Bun.sleep(500);
    expect(history()).toBe(initialHistory);
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    clients(["small"]);
    peer!.write("closewindow>>large\n");
    await Bun.sleep(500);
    expect(history()).toBe(initialHistory);
    peer!.end();
    await until(() => connections === 2, 3000);
    await Bun.sleep(Math.max(0, connectedAt + 5000 - Date.now()));
    expect(history()).toBe(initialHistory);
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    await until(() => history() !== initialHistory, Math.max(1, connectedAt + 7500 - Date.now()));
  } finally {
    if (daemon) { daemon.kill(); await daemon.exited; }
    server.stop(true);
    s.cleanup();
  }
}, 12000);

for (const handoff of ["off", "foreign art"]) {
  test(`daemon recovers from corrected quotes and stops on ${handoff}`, async () => {
    const s = sandbox();
    const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    const custom = join(s.config, "omastoic/quotes.tsv");
    const history = () => readFileSync(join(s.state, "recent.json"), "utf8");
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!check() && Date.now() < deadline) await Bun.sleep(20);
      expect(check()).toBe(true);
    };
    mkdirSync(dirname(socket), { recursive: true });
    s.put(join(s.config, "omastoic/config.json"), '{"interval":1}');
    s.put(join(s.home, "clients.json"), '[{"address":"large","class":"org.omarchy.screensaver"}]');
    let connected = false;
    const server = Bun.listen({ unix: socket, socket: { open() { connected = true; }, data() {} } });
    let daemon: ReturnType<typeof Bun.spawn> | undefined;
    let capture: Promise<void> | undefined;
    let errors = "";
    try {
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      daemon = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "daemon"], { cwd: root, env: s.env, stdout: "ignore", stderr: "pipe" });
      const reader = (daemon.stderr as ReadableStream<Uint8Array>).getReader();
      capture = (async () => { while (true) { const { done, value } = await reader.read(); if (done) break; errors += new TextDecoder().decode(value); } })();
      await until(() => connected);
      const before = history();
      const canvas = readFileSync(branding, "utf8");
      s.put(custom, `custom\tSource 1\t${"x".repeat(4097)}\n`);
      await until(() => errors.includes("too long"));
      expect(history()).toBe(before);
      expect(readFileSync(branding, "utf8")).toBe(canvas);
      s.put(custom, "custom\tSource 1\tA corrected thought.\n");
      await until(() => history() !== before);
      if (handoff === "off") expect((await s.cli(["off"])).code).toBe(0);
      s.put(branding, "user-selected art\n");
      const stopped = history();
      await Bun.sleep(1500);
      expect(history()).toBe(stopped);
      expect(readFileSync(branding, "utf8")).toBe("user-selected art\n");
      expect((await s.exec(["omarchy-toggle-enabled", "omastoic"])).code).toBe(1);
    } finally {
      if (daemon) { daemon.kill(); await daemon.exited; }
      await capture;
      server.stop(true);
      s.cleanup();
    }
  }, 10000);
}

test("a staggered cold start refits the same quote to the real grid without restarting its deadline", async () => {
  const s = sandbox();
  const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const history = () => readFileSync(join(s.state, "recent.json"), "utf8");
  const canvasText = () => { try { return readFileSync(branding, "utf8"); } catch { return ""; } };
  const until = async (check: () => boolean, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Bun.sleep(20);
    expect(check()).toBe(true);
  };
  // Width follows the grid: 92 on the fallback, 111 on the large tty, 60 on
  // the small one. A 75-column monitor estimate composes to a different canvas.
  const entry = { author: "custom", citation: "C".repeat(70), text: "x".repeat(1791) };
  const fitted = (cols: number, rows: number) => `${compose(entry, undefined, { cols, rows, art: null })}\n`;
  const widthOf = (text: string) => Math.max(0, ...text.replace(/\n$/, "").split("\n").map((line) => Bun.stringWidth(line)));
  const bundled = parseQuotes(readFileSync(join(root, "data/quotes.tsv"), "utf8")).length;
  mkdirSync(dirname(socket), { recursive: true });
  const monitors = '[{"width":1998,"height":1200},{"width":1080,"height":480}]';
  s.stub("hyprctl", `if [[ $1 == clients ]]; then cat "$HOME/clients.json"; else echo '${monitors}'; fi`);
  const fixture = Bun.spawn(["python3", "-u", "-c", `import fcntl, json, os, pty, struct, subprocess, sys, termios
pairs = [pty.openpty(), pty.openpty()]
children = []
def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
try:
    for (master, slave), (cols, rows) in zip(pairs, [(80, 24), (80, 24)]):
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
`], { env: s.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
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
  let connections = 0;
  let connectedAt = 0;
  let peer: Bun.Socket<undefined> | undefined;
  const server = Bun.listen({ unix: socket, socket: {
    open(socket) { peer = socket; connections++; if (!connectedAt) connectedAt = Date.now(); }, data() {},
  } });
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let capture: Promise<void> | undefined;
  let errors = "";
  try {
    const pids = JSON.parse(await record()) as number[];
    const client = (address: string, pid: number, width: number, height: number) => ({ address, pid, class: "org.omarchy.screensaver", size: [width, height] });
    s.put(join(s.home, "clients.json"), JSON.stringify([client("large", pids[0], 1998, 1200)]));
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.config, "omastoic/quotes.tsv"), `custom\t${entry.citation}\t${entry.text}\n`);
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 10 }));
    s.put(join(s.state, "recent.json"), JSON.stringify([...Array(bundled).keys()]));
    const arrived = async (cols: number, rows: number) => {
      const want = fitted(cols, rows);
      const deadline = Date.now() + 3000;
      while (canvasText() !== want && Date.now() < deadline) await Bun.sleep(20);
      expect(canvasText(), errors).toBe(want);
      const lines = canvasText().replace(/\n$/, "").split("\n");
      expect(lines.length, errors).toBeLessThanOrEqual(rows);
      expect(widthOf(canvasText()), errors).toBe(cols);
      for (const line of lines) expect(Bun.stringWidth(line), errors).toBeLessThanOrEqual(cols);
    };
    daemon = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "daemon"], { cwd: root, env: s.env, stdout: "ignore", stderr: "pipe" });
    const stderr = (daemon.stderr as ReadableStream<Uint8Array>).getReader();
    capture = (async () => { while (true) { const { done, value } = await stderr.read(); if (done) break; errors += new TextDecoder().decode(value); } })();
    await until(() => connections === 1);
    await arrived(92, 24);
    const started = connectedAt;
    const initialHistory = history();
    fixture.stdin.write("0 111 30\n");
    expect(await record()).toBe("ready");
    await arrived(111, 30);
    expect(history()).toBe(initialHistory);
    s.put(join(s.home, "clients.json"), JSON.stringify([
      client("large", pids[0], 1998, 1200),
      client("small", pids[1], 1080, 480),
    ]));
    peer!.write("openwindow>>small,1,org.omarchy.screensaver,title\n");
    await Bun.sleep(400);
    expect(history()).toBe(initialHistory);
    expect(canvasText(), errors).toBe(fitted(111, 30));
    await Bun.sleep(Math.max(0, started + 4000 - Date.now()));
    fixture.stdin.write("1 60 12\n");
    expect(await record()).toBe("ready");
    await arrived(60, 12);
    expect(history()).toBe(initialHistory);
    await Bun.sleep(Math.max(0, started + 8000 - Date.now()));
    expect(history()).toBe(initialHistory);
    expect(canvasText(), errors).toBe(fitted(60, 12));
    await until(() => history() !== initialHistory, Math.max(1, started + 13000 - Date.now()));
  } finally {
    if (daemon) { daemon.kill(); await daemon.exited; }
    await capture;
    fixture.stdin.end();
    await fixture.exited;
    reader.releaseLock();
    server.stop(true);
    s.cleanup();
  }
}, 25000);

test("a live grid compose rejects is not refit again until the grid changes", async () => {
  const s = sandbox();
  const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const history = () => readFileSync(join(s.state, "recent.json"), "utf8");
  const canvasText = () => { try { return readFileSync(branding, "utf8"); } catch { return ""; } };
  let errors = "";
  const until = async (check: () => boolean, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Bun.sleep(20);
    expect(check(), errors).toBe(true);
  };
  const entry = { author: "custom", citation: "C".repeat(70), text: "x".repeat(1791) };
  const fitted = (cols: number, rows: number) => `${compose(entry, undefined, { cols, rows, art: null })}\n`;
  const tooSmall = () => errors.match(/too small/g)?.length ?? 0;
  expect(() => compose(entry, undefined, { cols: 10, rows: 2, art: null })).toThrow(/too small/);
  const bundled = parseQuotes(readFileSync(join(root, "data/quotes.tsv"), "utf8")).length;
  mkdirSync(dirname(socket), { recursive: true });
  const fixture = Bun.spawn(["python3", "-u", "-c", `import fcntl, os, pty, struct, subprocess, sys, termios
master, slave = pty.openpty()
child = None
def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
try:
    resize(slave, 80, 24)
    child = subprocess.Popen(['sleep', '120'], stdin=slave, stdout=slave, stderr=slave)
    print(child.pid, flush=True)
    for line in sys.stdin:
        parts = line.split()
        if len(parts) != 2: continue
        cols, rows = map(int, parts)
        resize(slave, cols, rows)
        print('ready', flush=True)
finally:
    if child:
        child.terminate()
        child.wait()
    os.close(master)
    os.close(slave)
`], { env: s.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
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
  let connections = 0;
  const server = Bun.listen({ unix: socket, socket: { open() { connections++; }, data() {} } });
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let capture: Promise<void> | undefined;
  try {
    const pid = Number(await record());
    s.put(join(s.home, "clients.json"), JSON.stringify([{ address: "large", pid, class: "org.omarchy.screensaver" }]));
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.config, "omastoic/quotes.tsv"), `custom\t${entry.citation}\t${entry.text}\n`);
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 60 }));
    s.put(join(s.state, "recent.json"), JSON.stringify([...Array(bundled).keys()]));
    fixture.stdin.write("111 30\n");
    expect(await record()).toBe("ready");
    daemon = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "daemon"], { cwd: root, env: s.env, stdout: "ignore", stderr: "pipe" });
    const stderr = (daemon.stderr as ReadableStream<Uint8Array>).getReader();
    capture = (async () => { while (true) { const { done, value } = await stderr.read(); if (done) break; errors += new TextDecoder().decode(value); } })();
    const wantLarge = fitted(111, 30);
    await until(() => connections >= 1);
    await until(() => canvasText() === wantLarge);
    const stable = canvasText();
    const quote = history();
    fixture.stdin.write("10 2\n");
    expect(await record()).toBe("ready");
    await until(() => tooSmall() >= 1);
    await Bun.sleep(1200);
    expect(tooSmall(), errors).toBe(1);
    expect(canvasText(), errors).toBe(stable);
    expect(history()).toBe(quote);
    fixture.stdin.write("60 12\n");
    expect(await record()).toBe("ready");
    const wantSmall = fitted(60, 12);
    await until(() => canvasText() === wantSmall);
    expect(tooSmall(), errors).toBe(1);
    expect(history()).toBe(quote);
    const lines = canvasText().replace(/\n$/, "").split("\n");
    expect(lines.length, errors).toBeLessThanOrEqual(12);
    for (const line of lines) expect(Bun.stringWidth(line), errors).toBeLessThanOrEqual(60);
  } finally {
    if (daemon) { daemon.kill(); await daemon.exited; }
    await capture;
    fixture.stdin.end();
    await fixture.exited;
    reader.releaseLock();
    server.stop(true);
    s.cleanup();
  }
}, 20000);

test("oversized unterminated records reconnect instead of growing without bound", async () => {
  const s = sandbox();
  const socket = join(s.env.XDG_RUNTIME_DIR, "hypr/test/.socket2.sock");
  mkdirSync(dirname(socket), { recursive: true });
  let connections = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = Bun.listen({ unix: socket, socket: {
    open(peer) {
      if (++connections === 1) timers.push(setTimeout(() => peer.write("x".repeat(70000)), 80));
      else timers.push(setTimeout(() => peer.write("openwindow>>new,1,org.omarchy.screensaver,title\n"), 80));
    }, data() {},
  } });
  try {
    const events = await probe(s, 3);
    expect(connections).toBe(2);
    expect(events).toEqual([{ kind: "sync", addresses: [] }, { kind: "sync", addresses: [] }, { kind: "open", address: "new" }]);
  } finally { timers.forEach(clearTimeout); server.stop(true); s.cleanup(); }
});
