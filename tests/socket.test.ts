import { test, expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  s.put(join(s.state, "cell.json"), JSON.stringify({ width: 14, height: 30 }));
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
    const lines = canvas.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(60);
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
