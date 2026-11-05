import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

const lockModule = JSON.stringify(join(root, "src/files.ts"));
const until = async (check: () => boolean, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  expect(check()).toBe(true);
};

for (const owner of ["2147483647", "", "not-a-pid"]) {
  test(`concurrent transactions exclude each other despite legacy owner ${JSON.stringify(owner)}`, async () => {
    const s = sandbox();
    const old = join(s.state, "transaction.lock");
    s.put(join(old, "pid"), owner);
    const past = new Date(Date.now() - 120000);
    utimesSync(old, past, past);
    const code = `import { locked } from ${lockModule};
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
await locked(${JSON.stringify(s.state)}, async () => {
  mkdirSync(${JSON.stringify(join(s.home, "critical"))});
  appendFileSync(${JSON.stringify(join(s.home, "events"))}, 'enter\\n');
  await Bun.sleep(50);
  appendFileSync(${JSON.stringify(join(s.home, "events"))}, 'leave\\n');
  rmSync(${JSON.stringify(join(s.home, "critical"))}, { recursive: true });
});`;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => s.exec([process.execPath, "--eval", code])));
      for (const result of results) expect(result.stderr).toBe("");
      for (const result of results) expect(result.code).toBe(0);
      expect(readFileSync(join(s.home, "events"), "utf8").trim().split("\n")).toEqual(Array.from({ length: 8 }, () => ["enter", "leave"]).flat());
      expect(existsSync(join(s.home, "critical"))).toBe(false);
    } finally { s.cleanup(); }
  });
}

test("Bash cleanup waits for a CLI transaction and recovers when its owner dies", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const ready = join(s.home, "ready");
  s.put(branding, "original art\n");
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  let cleanup: ReturnType<typeof s.prune> | undefined;
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const canvas = readFileSync(branding, "utf8");
    const code = `import { locked } from ${lockModule};
await locked(${JSON.stringify(s.state)}, async () => {
  await Bun.write(${JSON.stringify(ready)}, 'ready');
  await Bun.sleep(60000);
});`;
    holder = Bun.spawn([process.execPath, "--eval", code], { cwd: root, env: s.env, stdout: "ignore", stderr: "ignore" });
    await until(() => existsSync(ready));
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    s.put(join(s.home, "systemctl.log"), "");
    let completed = false;
    cleanup = s.prune().then((result) => { completed = true; return result; });
    await Bun.sleep(2600);
    expect(completed).toBe(false);
    expect(s.log()).toBe("");
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    holder.kill("SIGKILL");
    await holder.exited;
    expect((await cleanup).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original art\n");
    expect((await s.cli(["config", "--interval", "120"])).code).toBe(0);
    const inode = statSync(join(s.state, "transaction.flock")).ino;
    expect((await s.cli(["uninstall", "--purge"])).code).toBe(0);
    expect(statSync(join(s.state, "transaction.flock")).ino).toBe(inode);
  } finally {
    if (holder) { holder.kill(); await holder.exited; }
    await cleanup;
    s.cleanup();
  }
}, 10000);

test("CLI transactions recover after a Bash cleanup holder is killed", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    s.stub("systemctl", 'if [[ "$*" == *"disable --now omastoic.service"* ]]; then kill -KILL "$PPID"; fi');
    expect((await s.prune()).code).not.toBe(0);
    expect((await s.cli(["config", "--interval", "120"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).interval).toBe(120);
  } finally { s.cleanup(); }
});
