import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

function nativeLauncher(s: ReturnType<typeof sandbox>, body: string) {
  // The comment is how setup recognises the dev-channel launcher: the script
  // execs the native binary. The body is what actually runs in the sandbox.
  s.stub("omarchy-launch-screensaver", `# /usr/lib/omarchy-screensaver/omarchy-screensaver\n${body}`);
}

test("native backend installs and does not require ttfx", async () => {
  const s = sandbox();
  nativeLauncher(s, "exit 0");
  try {
    const result = await s.cli(["setup"], { PATH: `${s.bin}:/usr/bin:/bin` });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("not supported");
    expect(result.stdout).toContain("each time the screensaver starts");
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(true);
    expect(existsSync(join(s.state, "installed"))).toBe(true);
    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("native");
    expect(status.stdout).toContain("when the screensaver starts");
  } finally { s.cleanup(); }
});

test("native preview writes a fresh canvas and launches with --input and calm --include-effects", async () => {
  const s = sandbox();
  nativeLauncher(s, `printf '%s\\n' "$*" >> "$HOME/launch.log"`);
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const first = readFileSync(branding, "utf8");
    expect(first.length).toBeGreaterThan(40);
    const preview = await s.cli(["preview"]);
    expect(preview.code).toBe(0);
    expect(preview.stderr).not.toContain("No such file or directory");
    expect(preview.stderr).not.toContain("not found");
    expect(preview.stdout).toContain("→ screensaver");
    const launched = readFileSync(join(s.home, "launch.log"), "utf8");
    expect(launched).toContain("force");
    expect(launched).toContain("--input");
    expect(launched).toContain(branding);
    expect(launched).toContain("--include-effects");
    expect(launched).toContain("colorshift,highlight,sweep");
    expect(launched).not.toContain("print");
    expect(launched).not.toContain("waves");
    expect(launched).not.toContain("decrypt");
    expect(launched).not.toContain("rain");
    expect(launched).not.toContain("matrix");
    const second = readFileSync(branding, "utf8");
    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(40);
  } finally { s.cleanup(); }
});

test("native preview passes only colorshift, highlight, and sweep for short and long quotes, including from off state", async () => {
  const s = sandbox();
  nativeLauncher(s, `printf '%s\\n' "$*" >> "$HOME/launch.log"`);
  const longText =
    "All mankind being all equal and independent, no one ought to harm another in his life, health, liberty, " +
    "or possessions; for men being all the workmanship of one omnipotent and infinitely wise Maker, they are " +
    "his property, sent into the world by his order and about his business, made to last during his, not one " +
    "another's pleasure, and furnished with like faculties.";
  try {
    expect((await s.cli(["setup", "--quiet"])).code).toBe(0);
    expect((await s.cli(["config", "--add", `marcus\tSecond Treatise II.6\t${longText}`])).code).toBe(0);

    // Launching from off state with a long custom quote omits print and waves.
    const longFromOff = await s.cli(["preview", "--quote", "c01"]);
    expect(longFromOff.code).toBe(0);

    // Launching with a bundled long quote (q17, Meditations II.1, 215 chars) omits print and waves.
    const longBundled = await s.cli(["preview", "--quote", "q17"]);
    expect(longBundled.code).toBe(0);

    // Launching with a short bundled quote (q01, 95 chars) also omits print and waves.
    const shortBundled = await s.cli(["preview", "--quote", "q01"]);
    expect(shortBundled.code).toBe(0);

    // Launching with the shortest bundled quote (q30, 39 chars) also omits print and waves.
    const shortestBundled = await s.cli(["preview", "--quote", "q30"]);
    expect(shortestBundled.code).toBe(0);

    const lines = readFileSync(join(s.home, "launch.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toContain("--include-effects colorshift,highlight,sweep");
      expect(line).not.toContain("print");
      expect(line).not.toContain("waves");
      expect(line).not.toContain("decrypt");
      expect(line).not.toContain("rain");
      expect(line).not.toContain("matrix");
    }
  } finally { s.cleanup(); }
});

test("README documents calm preview effects and idle-start behaviour", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  expect(readme).toContain("### Screensaver effects");
  expect(readme).toContain("--include-effects");
  expect(readme).toContain("`colorshift`, `highlight`, and\n`sweep`");
  expect(readme).toContain("Both `print` and `waves` stay out");
  expect(readme).toContain("3 seconds");
  expect(readme).toContain("Idle starts");
});

test("native preview explains a missing screensaver binary", async () => {
  const s = sandbox();
  // The installed package lives at /usr/lib/omarchy-screensaver/omarchy-screensaver.
  // Execing that path runs the real binary, which then fails with a Wayland
  // error when no compositor is up. A basename of omarchy-screensaver that is
  // not that file still produces bash's missing-exec message, and never the
  // package.
  const missing = join(s.home, "missing/omarchy-screensaver");
  nativeLauncher(s, `exec ${missing} "$@"`);
  try {
    const result = await s.cli(["preview"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("omarchy pkg add omarchy-screensaver");
    expect(result.stderr).not.toContain("No such file or directory");
    expect(result.stderr).not.toContain("not found");
    expect(result.stderr).not.toContain("wayland");
  } finally { s.cleanup(); }
});

test("native daemon keeps the showing quote and writes the next one after the screensaver exits", async () => {
  const s = sandbox();
  nativeLauncher(s, "exit 0");
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 1 }));
  let saver: ReturnType<typeof Bun.spawn> | undefined;
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  const until = async (check: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Bun.sleep(40);
    expect(check()).toBe(true);
  };
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const prepared = readFileSync(branding, "utf8");
    daemon = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "daemon"], { cwd: root, env: s.env, stdout: "ignore", stderr: "pipe" });
    await until(() => readFileSync(branding, "utf8") !== prepared);
    const showing = readFileSync(branding, "utf8");
    saver = Bun.spawn(["bash", "-c", "exec -a /usr/lib/omarchy-screensaver/omarchy-screensaver sleep 30"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await Bun.sleep(900);
    expect(readFileSync(branding, "utf8")).toBe(showing);
    saver.kill();
    await saver.exited;
    saver = undefined;
    await until(() => readFileSync(branding, "utf8") !== showing);
  } finally {
    saver?.kill();
    daemon?.kill();
    s.cleanup();
  }
});

test("native preview leaves an already-running screensaver on the quote it started with", async () => {
  const s = sandbox();
  nativeLauncher(s, `printf '%s\\n' "$*" >> "$HOME/launch.log"`);
  let saver: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    saver = Bun.spawn(["bash", "-c", "exec -a /usr/lib/omarchy-screensaver/omarchy-screensaver sleep 30"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await Bun.sleep(100);
    const preview = await s.cli(["preview"]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("already up");
    expect(preview.stdout).toContain("next start");
    expect(existsSync(join(s.home, "launch.log"))).toBe(false);
  } finally {
    saver?.kill();
    s.cleanup();
  }
});

test("headless omarchy-screensaver renders an omastoic canvas when the package is installed", async () => {
  const bin = "/usr/lib/omarchy-screensaver/omarchy-screensaver";
  if (!existsSync(bin)) {
    console.log("skipping headless screensaver render: omarchy-screensaver is not installed");
    return;
  }
  const s = sandbox();
  try {
    const shown = await s.cli(["show", "--cols", "80", "--rows", "24"]);
    expect(shown.code).toBe(0);
    const input = join(s.home, "canvas.txt");
    s.put(input, shown.stdout.endsWith("\n") ? shown.stdout : `${shown.stdout}\n`);
    const result = await s.exec([bin, "--headless", "--frames", "2", "--cols", "80", "--rows", "24", "--input", input, "--effect", "print", "--seed", "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("frames=2");
    expect(result.stdout).toContain("80x24");
  } finally { s.cleanup(); }
});
