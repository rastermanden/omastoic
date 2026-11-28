import { expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { transcodePortrait } from "../src/portrait.ts";
import {
  isSystemBinaryPath,
  isTruthyEnv,
  parsePasswdHomedir,
  readPasswdHomedir,
  shouldSkipSystemctl,
} from "../src/systemctl.ts";
import { root, sandbox } from "./sandbox.ts";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

type TestPortraitShape = "box" | "cross";

function writeTestPng(path: string, shade: number, shape: TestPortraitShape = "box"): void {
  const w = 16;
  const h = 16;
  const raw = new Uint8Array((1 + w * 3) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const inside =
        shape === "cross"
          ? (x >= 6 && x < 10 && y >= 2 && y < 14) || (x >= 2 && x < 14 && y >= 6 && y < 10)
          : x >= 4 && x < 12 && y >= 3 && y < 13;
      const bright = inside ? shade : 10;
      raw[row + 1 + x * 3] = bright;
      raw[row + 1 + x * 3 + 1] = bright;
      raw[row + 1 + x * 3 + 2] = bright;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w, false);
  view.setUint32(4, h, false);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  writeFileSync(path, png);
}

test("unselected author and quote changes and no-ops do not restart omastoic.service", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  const pngB = join(s.home, "b.png");
  writeTestPng(pngA, 220, "box");
  writeTestPng(pngB, 220, "cross");
  try {
    expect(await transcodePortrait(pngA)).not.toBe(await transcodePortrait(pngB));
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["config", "--authors", "marcus"])).code).toBe(0);
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(true);

    // Panel: add, edit, and remove an unselected custom author.
    s.put(join(s.home, "systemctl.log"), "");
    expect(
      (
        await s.cli([
          "panel",
          "apply",
          JSON.stringify({
            addAuthor: {
              slug: "musonius",
              name: "Musonius Rufus",
              dates: "c. AD 30 – 100",
              image: pngA,
              citation: "Lectures VI",
              text: "Unselected author line.",
            },
          }),
        ])
      ).code,
    ).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    s.put(join(s.home, "systemctl.log"), "");
    expect(
      (
        await s.cli([
          "panel",
          "apply",
          JSON.stringify({
            replaceAuthor: {
              slug: "musonius",
              name: "C. Musonius Rufus",
              image: pngB,
              citation: "Lectures VII",
              text: "Edited unselected author line.",
            },
          }),
        ])
      ).code,
    ).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ removeAuthor: "musonius" })])).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    // Panel: add and remove a quote for an unselected author.
    s.put(join(s.home, "systemctl.log"), "");
    expect(
      (
        await s.cli([
          "panel",
          "apply",
          JSON.stringify({
            addQuote: { author: "seneca", citation: "Letters 1.1", text: "Unselected quote line." },
          }),
        ])
      ).code,
    ).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "c01" })])).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    // CLI config: add/edit/remove unselected author, unselected quote, unselected quote filter, and no-op writes.
    s.put(join(s.home, "systemctl.log"), "");
    expect(
      (
        await s.cli([
          "config",
          "--add-author",
          "musonius",
          "--name",
          "Musonius Rufus",
          "--image",
          pngA,
          "--citation",
          "Lectures VI",
          "--text",
          "CLI unselected author line.",
        ])
      ).code,
    ).toBe(0);
    expect((await s.cli(["config", "--replace-author", "musonius", "--name", "Gaius Musonius Rufus"])).code).toBe(0);
    expect((await s.cli(["config", "--remove-author", "musonius"])).code).toBe(0);
    expect((await s.cli(["config", "--add", "seneca\tLetters 2.1\tCLI unselected quote."])).code).toBe(0);
    expect((await s.cli(["config", "--quotes", "seneca=q19"])).code).toBe(0);
    expect((await s.cli(["config", "--authors", "marcus"])).code).toBe(0);
    expect((await s.cli(["config", "--interval", "60"])).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");
  } finally {
    s.cleanup();
  }
});

test("changing interval or active rotation restarts an active omastoic.service", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  const pngSameBraille = join(s.home, "same-braille.png");
  const pngB = join(s.home, "b.png");
  writeTestPng(pngA, 220, "box");
  writeTestPng(pngSameBraille, 140, "box");
  writeTestPng(pngB, 220, "cross");
  try {
    const portraitA = await transcodePortrait(pngA);
    const portraitSame = await transcodePortrait(pngSameBraille);
    const portraitB = await transcodePortrait(pngB);
    expect(portraitSame).toBe(portraitA);
    expect(portraitB).not.toBe(portraitA);
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["config", "--authors", "marcus"])).code).toBe(0);

    // Changing interval via CLI restarts active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--interval", "90"])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");

    // Changing interval via panel restarts active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120 })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");

    // Adding a quote for the selected author restarts active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--add", "marcus\tMeditations X.1\tActive quote line."])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");

    // Changing selected authors restarts active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ authors: ["marcus", "seneca"] })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");

    // Updating portrait of a custom author who is in active rotation restarts active service.
    expect(
      (
        await s.cli([
          "panel",
          "apply",
          JSON.stringify({
            authors: ["marcus", "musonius"],
            addAuthor: {
              slug: "musonius",
              name: "Musonius Rufus",
              image: pngA,
              citation: "Lectures VI",
              text: "Selected custom author line.",
            },
          }),
        ])
      ).code,
    ).toBe(0);
    // Replacing a selected author's image with one that converts to identical braille is a no-op.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ replaceAuthor: { slug: "musonius", image: pngSameBraille } })])).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    // Replacing it with an image that produces different braille restarts active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ replaceAuthor: { slug: "musonius", image: pngB } })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");

    // Filtering quotes for a selected author restarts active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--quotes", "marcus=q01"])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
  } finally {
    s.cleanup();
  }
});

test("config and panel apply never restart omastoic.service when it is inactive", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    // Simulate toggle on + unit installed, but omastoic.service is stopped/inactive.
    rmSync(join(s.home, "omastoic.service.active"), { force: true });
    s.put(join(s.home, "systemctl.log"), "");

    expect((await s.cli(["config", "--interval", "90", "--authors", "seneca"])).code).toBe(0);
    expect(
      (
        await s.cli([
          "panel",
          "apply",
          JSON.stringify({
            interval: 120,
            authors: ["epictetus"],
            addQuote: { author: "epictetus", citation: "Enchiridion 1", text: "Inactive daemon quote." },
          }),
        ])
      ).code,
    ).toBe(0);

    expect(s.log()).not.toContain("restart omastoic.service");
    expect(s.log()).not.toContain("start omastoic.service");
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(false);
  } finally {
    s.cleanup();
  }
});

test("setup on shell load avoids redundant enable/start/restart when already active and unchanged", async () => {
  const s = sandbox();
  const copy = join(s.home, "plugin-copy");
  for (const path of ["src", "data", "art", "bin", "scripts", "completions", "manifest.json"]) {
    cpSync(join(root, path), join(copy, path), { recursive: true });
  }
  const setup = (args: string[]) => s.exec([process.execPath, join(copy, "src/cli.ts"), ...args]);
  try {
    // Initial setup activates and starts the service.
    expect((await setup(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(true);
    expect(existsSync(join(s.home, "omastoic.service.enabled"))).toBe(true);

    // Unchanged shell reloads (both --on-first and plain setup) must not enable, start, restart, or daemon-reload any unit.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await setup(["setup", "--quiet"])).code).toBe(0);
    expect(s.log()).not.toContain("enable ");
    expect(s.log()).not.toContain("start ");
    expect(s.log()).not.toContain("restart ");
    expect(s.log()).not.toContain("daemon-reload");

    // Updating a non-unit owned artifact (shell completion) does not trigger daemon-reload.
    const bashCompletion = join(s.data, "bash-completion/completions/omastoic");
    const prevCompletion = readFileSync(bashCompletion, "utf8");
    s.put(join(copy, "completions/omastoic.bash"), `${readFileSync(join(copy, "completions/omastoic.bash"), "utf8")}\n# completion tweak\n`);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--quiet"])).code).toBe(0);
    expect(readFileSync(bashCompletion, "utf8")).not.toBe(prevCompletion);
    expect(s.log()).not.toContain("daemon-reload");
    expect(s.log()).not.toContain("enable ");
    expect(s.log()).not.toContain("restart ");

    // Upgrading omastoic-prune.path while active runs daemon-reload and restarts the path unit.
    const prunePath = join(s.config, "systemd/user/omastoic-prune.path");
    const legacyPrunePath = `[Unit]\nDescription=Watch for omastoic plugin removal\n\n[Path]\nPathChanged=${join(s.config, "omarchy/plugins")}\nUnit=omastoic-prune.service\n\n[Install]\nWantedBy=default.target\n`;
    s.put(prunePath, legacyPrunePath);
    rmSync(join(s.state, "owned/prune-path"), { force: true });
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--quiet"])).code).toBe(0);
    expect(s.log()).toContain("daemon-reload");
    expect(s.log()).toContain("restart omastoic-prune.path");
    expect(s.log()).not.toContain("enable --now omastoic-prune.path");

    // When enabled but currently inactive, setup starts it without redundant enable or restart.
    rmSync(join(s.home, "omastoic.service.active"), { force: true });
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(s.log()).toContain("start omastoic.service");
    expect(s.log()).not.toContain("restart omastoic.service");
    expect(s.log()).not.toContain("enable omastoic.service");
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(true);

    // When plugin code/data changes while active, setup restarts omastoic.service without redundant enable.
    s.put(join(copy, "data/quotes.tsv"), `${readFileSync(join(copy, "data/quotes.tsv"), "utf8")}\n# reload test\n`);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
    expect(s.log()).not.toContain("enable omastoic.service");

    // When plugin code/data changes while inactive, setup starts (not restarts) omastoic.service.
    rmSync(join(s.home, "omastoic.service.active"), { force: true });
    s.put(join(copy, "data/quotes.tsv"), `${readFileSync(join(copy, "data/quotes.tsv"), "utf8")}\n# reload test 2\n`);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(s.log()).toContain("start omastoic.service");
    expect(s.log()).not.toContain("restart omastoic.service");

    // When disabled/off and already inactive+disabled, setup does not call disable/start/restart on omastoic.service.
    expect((await setup(["off"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await setup(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(s.log()).not.toContain("disable --now omastoic.service");
    expect(s.log()).not.toContain("start omastoic.service");
    expect(s.log()).not.toContain("restart omastoic.service");
  } finally {
    s.cleanup();
  }
});

test("shouldSkipSystemctl unit rules cover real binaries, stubs, test envs, isolated HOME, and opt-out", () => {
  expect(isTruthyEnv(undefined)).toBe(false);
  expect(isTruthyEnv("")).toBe(false);
  expect(isTruthyEnv("0")).toBe(false);
  expect(isTruthyEnv("false")).toBe(false);
  expect(isTruthyEnv("no")).toBe(false);
  expect(isTruthyEnv("1")).toBe(true);
  expect(isTruthyEnv("true")).toBe(true);

  expect(isSystemBinaryPath("/usr/bin/systemctl")).toBe(true);
  expect(isSystemBinaryPath("/bin/systemctl")).toBe(true);
  expect(isSystemBinaryPath("/run/current-system/sw/bin/systemctl")).toBe(true);
  expect(isSystemBinaryPath("/tmp/omastoic-test-123/bin/systemctl")).toBe(false);

  expect(parsePasswdHomedir("root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:User:/home/user:/bin/bash\n", 1000)).toBe("/home/user");
  expect(parsePasswdHomedir("root:x:0:0:root:/root:/bin/bash\n", 1000)).toBeNull();
  expect(readPasswdHomedir()).toBeTruthy();

  // Normal user session with real systemctl: allowed.
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/home/user" },
      systemctlPath: "/usr/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(false);
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/home/user/" },
      systemctlPath: "/usr/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(false);

  // Real systemctl under isolated HOME: skipped even without NODE_ENV/BUN_ENV.
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/tmp/isolated-home" },
      systemctlPath: "/usr/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(true);

  // Real systemctl under NODE_ENV=test or BUN_ENV=test: skipped even with matching HOME.
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/home/user", NODE_ENV: "test" },
      systemctlPath: "/usr/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(true);
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/home/user", BUN_ENV: "test" },
      systemctlPath: "/usr/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(true);

  // Sandbox stub under isolated HOME + NODE_ENV=test: allowed so sandbox tests keep logging.
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/tmp/omastoic-test-abc", NODE_ENV: "test", BUN_ENV: "test" },
      systemctlPath: "/tmp/omastoic-test-abc/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(false);

  // Explicit OMASTOIC_NO_SYSTEMCTL=1 skips even a stub.
  expect(
    shouldSkipSystemctl({
      env: { HOME: "/tmp/omastoic-test-abc", OMASTOIC_NO_SYSTEMCTL: "1" },
      systemctlPath: "/tmp/omastoic-test-abc/bin/systemctl",
      passwdHome: "/home/user",
    }),
  ).toBe(true);

  // Symlink in temp bin pointing at real /usr/bin/systemctl is still recognized as real and skipped.
  const s = sandbox();
  try {
    if (existsSync("/usr/bin/systemctl")) {
      const link = join(s.home, "real-systemctl-link");
      symlinkSync("/usr/bin/systemctl", link);
      expect(
        shouldSkipSystemctl({
          env: { HOME: s.home },
          systemctlPath: link,
          passwdHome: "/home/user",
        }),
      ).toBe(true);
    }
  } finally {
    s.cleanup();
  }
});

test("isolated HOME and OMASTOIC_NO_SYSTEMCTL never invoke real host systemctl in CLI or prune.sh", async () => {
  const s = sandbox();
  try {
    // 1. OMASTOIC_NO_SYSTEMCTL=1 skips even the stubbed systemctl in both CLI and prune.sh.
    expect((await s.cli(["setup", "--on-first", "--quiet"], { OMASTOIC_NO_SYSTEMCTL: "1" })).code).toBe(0);
    expect((await s.cli(["config", "--interval", "90"], { OMASTOIC_NO_SYSTEMCTL: "1" })).code).toBe(0);
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    expect((await s.prune({ OMASTOIC_NO_SYSTEMCTL: "1" })).code).toBe(0);
    expect(s.log()).toBe("");
  } finally {
    s.cleanup();
  }

  // 2. Remove the stubbed systemctl so PATH resolves to the real system binary (/usr/bin/systemctl).
  // Provide an unreachable DBUS_SESSION_BUS_ADDRESS and clear NODE_ENV/BUN_ENV:
  // if either cli.ts or prune.sh invoked real `systemctl --user`, it would fail with exit 1.
  if (existsSync("/usr/bin/systemctl") || existsSync("/bin/systemctl")) {
    const isolated = sandbox();
    const branding = join(isolated.config, "omarchy/branding/screensaver.txt");
    isolated.put(branding, "host art\n");
    rmSync(join(isolated.bin, "systemctl"), { force: true });
    const realEnv: Record<string, string> = {
      NODE_ENV: "",
      BUN_ENV: "",
      OMASTOIC_NO_SYSTEMCTL: "",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/omastoic-test-bus",
    };
    try {
      const setupResult = await isolated.cli(["setup", "--on-first", "--quiet"], realEnv);
      expect(setupResult.code).toBe(0);
      expect(setupResult.stderr).toBe("");

      const statusResult = await isolated.cli(["status"], realEnv);
      expect(statusResult.code).toBe(0);
      expect(statusResult.stderr).toBe("");

      const configResult = await isolated.cli(["config", "--interval", "90"], realEnv);
      expect(configResult.code).toBe(0);
      expect(configResult.stderr).toBe("");

      const panelResult = await isolated.cli(["panel", "apply", JSON.stringify({ authors: ["marcus"] })], realEnv);
      expect(panelResult.code).toBe(0);
      expect(panelResult.stderr).toBe("");

      // Disable via prune.sh with real systemctl on PATH and isolated HOME.
      isolated.put(join(isolated.config, "omarchy/shell.json"), '{"plugins":[]}');
      const pruneDisable = await isolated.prune(realEnv);
      expect(pruneDisable.code).toBe(0);
      expect(pruneDisable.stderr).toBe("");
      expect(readFileSync(branding, "utf8")).toBe("host art\n");

      // Full removal via prune.sh (exercises disable omastoic-prune.path and daemon-reload).
      rmSync(isolated.plugin, { recursive: true });
      const pruneRemove = await isolated.prune(realEnv);
      expect(pruneRemove.code).toBe(0);
      expect(pruneRemove.stderr).toBe("");
    } finally {
      isolated.cleanup();
    }
  }
}, 20000);

test("config --list skips daemonRotationDigest while mutating config still computes it", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  writeTestPng(pngA, 220, "box");
  try {
    expect(
      (
        await s.cli([
          "config",
          "--add-author",
          "musonius",
          "--name",
          "Musonius Rufus",
          "--image",
          pngA,
          "--citation",
          "Lectures VI",
          "--text",
          "List digest test line.",
        ])
      ).code,
    ).toBe(0);
    expect((await s.cli(["config", "--authors", "musonius"])).code).toBe(0);

    // Corrupt the custom portrait with a control character so loadPortrait() warns whenever daemonRotationDigest() runs.
    s.put(join(s.config, "omastoic/art/musonius.txt"), "\x07broken\n");

    const listed = await s.cli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("List digest test line.");
    expect(listed.stderr).toBe("");

    const listedPlain = await s.cli(["config", "--list", "--plain"]);
    expect(listedPlain.code).toBe(0);
    expect(listedPlain.stderr).toBe("");

    // Mutating config still runs daemonRotationDigest() and surfaces the unreadable portrait warning.
    const mutated = await s.cli(["config", "--interval", "60"]);
    expect(mutated.code).toBe(0);
    expect(mutated.stderr).toContain("ignoring unreadable portrait for musonius");
  } finally {
    s.cleanup();
  }
});

test("prune.sh trims whitespace in OMASTOIC_NO_SYSTEMCTL, NODE_ENV, BUN_ENV, and HOME", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');

    // Padded falsy OMASTOIC_NO_SYSTEMCTL must not skip the sandbox stubbed systemctl.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.prune({ OMASTOIC_NO_SYSTEMCTL: " false " })).code).toBe(0);
    expect(s.log()).toContain("disable --now omastoic.service");

    // Re-setup and verify padded truthy OMASTOIC_NO_SYSTEMCTL skips the stubbed systemctl.
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.prune({ OMASTOIC_NO_SYSTEMCTL: "\t1 " })).code).toBe(0);
    expect(s.log()).toBe("");

    // Exercise prune.sh's exact helper functions for padded NODE_ENV, BUN_ENV, HOME, and OMASTOIC_NO_SYSTEMCTL.
    const pruneText = readFileSync(join(root, "scripts/prune.sh"), "utf8");
    const start = pruneText.indexOf("trim_env()");
    const end = pruneText.indexOf("run_systemctl()");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const helpers = pruneText.slice(start, end);

    const checkScript = `set -euo pipefail
${helpers}
passwd_home() { printf '%s' "$TEST_PW_HOME"; }
command() {
  if [[ \${1:-} == "-v" && \${2:-} == "systemctl" ]]; then
    printf '%s\\n' "/usr/bin/systemctl"
    return 0
  fi
  builtin command "$@"
}
assert_true() { if ! "$@"; then echo "expected true: $*" >&2; exit 1; fi; }
assert_false() { if "$@"; then echo "expected false: $*" >&2; exit 1; fi; }

assert_false is_truthy_env "   "
assert_false is_truthy_env " false "
assert_false is_truthy_env $'\\t0\\t'
assert_false is_truthy_env " NO "
assert_true is_truthy_env " 1 "
assert_true is_truthy_env " true "
assert_true is_truthy_env " * "

TEST_PW_HOME="${s.home}"
HOME="${s.home}"
OMASTOIC_NO_SYSTEMCTL=" false "
NODE_ENV=""
BUN_ENV=""
assert_false should_skip_systemctl

NODE_ENV=" test "
assert_true should_skip_systemctl

NODE_ENV=""
BUN_ENV=$'\\tTEST '
assert_true should_skip_systemctl

BUN_ENV=""
HOME="   "
assert_true should_skip_systemctl

HOME=" ${s.home} "
assert_false should_skip_systemctl

OMASTOIC_NO_SYSTEMCTL=" true "
assert_true should_skip_systemctl
`;
    const check = await s.exec(["bash", "-c", checkScript]);
    expect(check.code, check.stderr).toBe(0);
  } finally {
    s.cleanup();
  }
});

test("native backend ignores interval changes for daemon restarts while still restarting on rotation changes", async () => {
  const s = sandbox();
  s.stub("omarchy-launch-screensaver", "# /usr/lib/omarchy-screensaver/omarchy-screensaver\nexit 0");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(true);

    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--interval", "90"])).code).toBe(0);
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120 })])).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    // Active rotation changes on native backend still restart the active daemon.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--authors", "marcus"])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
  } finally {
    s.cleanup();
  }
});

test("case-only display-name edits on a selected author do not restart omastoic.service", async () => {
  const s = sandbox();
  const pngA = join(s.home, "a.png");
  writeTestPng(pngA, 220, "box");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(
      (
        await s.cli([
          "config",
          "--add-author",
          "musonius",
          "--name",
          "Musonius Rufus",
          "--image",
          pngA,
          "--citation",
          "Lectures VI",
          "--text",
          "Case test line.",
        ])
      ).code,
    ).toBe(0);
    expect((await s.cli(["config", "--authors", "musonius"])).code).toBe(0);

    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--replace-author", "musonius", "--name", "MUSONIUS RUFUS"])).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");

    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["config", "--replace-author", "musonius", "--name", "C. Musonius Rufus"])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
  } finally {
    s.cleanup();
  }
});

test("repeated prune.sh runs while disabled skip redundant disable calls once omastoic.service is stopped", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');

    // First run after host disable stops and disables the active service.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.prune()).code).toBe(0);
    expect(s.log()).toContain("disable --now omastoic.service");

    // Second run while still disabled must not invoke disable again.
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.prune()).code).toBe(0);
    expect(s.log()).not.toContain("disable --now omastoic.service");
  } finally {
    s.cleanup();
  }
}, 15000);
