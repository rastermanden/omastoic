import { test, expect } from "bun:test";
import { existsSync, readFileSync, symlinkSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { sandbox, root } from "./sandbox.ts";
import { PLUGIN_ID } from "../src/plugin-id.ts";

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
test("manifest describes a loadable third-party service with a matching release", () => {
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.id).toBe(PLUGIN_ID);
  expect(manifest.kinds).toEqual(["service"]);
  expect(manifest.entryPoints.service).toBe("Service.qml");
  expect(existsSync(join(root, manifest.entryPoints.service))).toBe(true);
  expect(manifest.version).toBe(pkg.version);
});

for (const failure of ["daemon-reload", "enable --now omastoic-prune.path", "enable --now omastoic.service"]) {
  test(`setup reports systemctl failure, never an install marker (${failure})`, async () => {
    const s = sandbox();
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    s.put(branding, "my art\n");
    try {
      const result = await s.cli(["setup", "--on-first", "--quiet"], { SYSTEMCTL_FAIL: failure });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("systemctl --user");
      expect(result.stderr).toContain("failed (exit 1)");
      expect(result.stdout).not.toContain("every 60s");
      expect(existsSync(join(s.state, "installed"))).toBe(false);
      expect(readFileSync(branding, "utf8")).toBe("my art\n");
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      expect(existsSync(join(s.state, "installed"))).toBe(true);
    } finally { s.cleanup(); }
  });
}

for (const failure of ["completion conflict", "enable --now omastoic-prune.path"]) {
  test(`failed refresh after off preserves installation history (${failure})`, async () => {
    const s = sandbox();
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    const completion = join(s.data, "bash-completion/completions/omastoic");
    s.put(branding, "my chosen art\n");
    try {
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      expect((await s.cli(["off"])).code).toBe(0);
      const marker = readFileSync(join(s.state, "installed"), "utf8");
      const originalCompletion = readFileSync(completion, "utf8");
      if (failure === "completion conflict") s.put(completion, "user completion\n");
      const failed = await s.cli(["setup", "--on-first", "--quiet"], failure === "completion conflict" ? {} : { SYSTEMCTL_FAIL: failure });
      expect(failed.code).toBe(1);
      expect(readFileSync(join(s.state, "installed"), "utf8")).toBe(marker);
      expect(readFileSync(branding, "utf8")).toBe("my chosen art\n");
      expect(existsSync(join(s.home, "toggle"))).toBe(false);
      if (failure === "completion conflict") s.put(completion, originalCompletion);
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      expect(existsSync(join(s.home, "toggle"))).toBe(false);
      expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(false);
      expect(readFileSync(branding, "utf8")).toBe("my chosen art\n");
    } finally { s.cleanup(); }
  });
}

test("a failed refresh keeps an already selected Stoics canvas", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "original art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const canvas = readFileSync(branding, "utf8");
    const written = readFileSync(join(s.state, "written.sha"), "utf8");
    const displaced = readFileSync(join(s.state, "displaced.kind"), "utf8");
    const backup = readFileSync(`${branding}.pre-omastoic`, "utf8");
    expect(existsSync(join(s.home, "toggle"))).toBe(true);
    expect(existsSync(join(s.home, "omastoic.service.enabled"))).toBe(true);
    const failed = await s.cli(["setup", "--on-first", "--quiet"], { SYSTEMCTL_FAIL: "enable --now omastoic-prune.path" });
    expect(failed.code).toBe(1);
    expect(existsSync(join(s.home, "toggle"))).toBe(true);
    expect(existsSync(join(s.home, "omastoic.service.enabled"))).toBe(true);
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(true);
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect(readFileSync(join(s.state, "written.sha"), "utf8")).toBe(written);
    expect(readFileSync(join(s.state, "displaced.kind"), "utf8")).toBe(displaced);
    expect(readFileSync(`${branding}.pre-omastoic`, "utf8")).toBe(backup);
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(existsSync(join(s.home, "toggle"))).toBe(true);
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect((await s.cli(["off"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original art\n");
  } finally { s.cleanup(); }
});

test("a failed upgrade does not restore the host logo over a legacy selection", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const host = process.env.OMARCHY_TEST_ROOT ?? "/usr/share/omarchy";
  const logo = readFileSync(join(host, "logo.txt"), "utf8");
  s.put(join(s.env.OMARCHY_PATH, "logo.txt"), logo);
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const canvas = readFileSync(branding, "utf8");
    const written = readFileSync(join(s.state, "written.sha"), "utf8");
    expect(existsSync(`${branding}.pre-omastoic`)).toBe(false);
    rmSync(join(s.state, "displaced.kind"));
    const failed = await s.cli(["setup", "--on-first", "--quiet"], { SYSTEMCTL_FAIL: "enable --now omastoic-prune.path" });
    expect(failed.code).toBe(1);
    expect(existsSync(join(s.home, "toggle"))).toBe(true);
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect(readFileSync(join(s.state, "written.sha"), "utf8")).toBe(written);
    expect(readFileSync(`${branding}.pre-omastoic`, "utf8")).toBe(logo);
    expect(readFileSync(join(s.state, "displaced.kind"), "utf8")).toBe("file");
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect(existsSync(join(s.home, "toggle"))).toBe(true);
    expect((await s.cli(["off"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe(logo);
  } finally { s.cleanup(); }
});

test("install activation failure is not marked installed; uninstall failure is retryable", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["install"], { SYSTEMCTL_FAIL: "enable --now omastoic.service" })).code).toBe(1);
    expect(existsSync(join(s.state, "installed"))).toBe(false);
    expect((await s.cli(["install"])).code).toBe(0);
    const failed = await s.cli(["uninstall"], { SYSTEMCTL_FAIL: "disable --now omastoic.service" });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("failed (exit 1)");
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(true);
    expect((await s.cli(["uninstall"])).code).toBe(0);
  } finally { s.cleanup(); }
});

test("setup/off/re-enable/uninstall/re-add is idempotent and restores displaced art", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "original art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const first = readFileSync(branding, "utf8");
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe(first);
    expect((await s.cli(["off"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original art\n");
    expect(s.log()).toContain("disable --now omastoic.service");
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original art\n");
    expect((await s.cli(["on"])).code).toBe(0);
    for (let i = 0; i < 2; i++) expect((await s.cli(["uninstall"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original art\n");
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(false);
    expect(existsSync(join(s.state, "installed"))).toBe(false);
    expect(existsSync(join(s.home, ".local/bin/omastoic"))).toBe(false);
    s.put(join(s.plugin, "manifest.json"), JSON.stringify({ id: PLUGIN_ID }));
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
  } finally { s.cleanup(); }
});

test("null/type-wrong config normalizes; show is a read-only export", async () => {
  const s = sandbox();
  try {
    for (const raw of [null, [], { interval: 0, authors: "marcus" }, { interval: -1 }, { authors: [null] }]) {
      s.put(join(s.config, "omastoic/config.json"), JSON.stringify(raw));
      const result = await s.cli(["show", "--cols", "40", "--rows", "24"]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeGreaterThan(50);
      expect(existsSync(s.state)).toBe(false);
    }
    expect((await s.cli(["config"])).stdout).toContain("every 60s");
    expect((await s.cli(["config", "--interval", "120"])).code).toBe(0);
    expect((await s.cli(["config"])).stdout).toContain("every 120s");
  } finally { s.cleanup(); }
});

for (const command of ["next", "preview"]) {
  test(`${command} never overwrites user-changed art`, async () => {
    const s = sandbox();
    try {
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      const branding = join(s.config, "omarchy/branding/screensaver.txt");
      s.put(branding, "USER CHANGED ART\n");
      const result = await s.cli([command]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("standing aside");
      expect(readFileSync(branding, "utf8")).toBe("USER CHANGED ART\n");
      expect((await s.cli(["uninstall"])).code).toBe(0);
      expect(readFileSync(branding, "utf8")).toBe("USER CHANGED ART\n");
    } finally { s.cleanup(); }
  });
}

for (const [name, path] of [
  ["launcher", ".local/bin/omastoic"], ["unit", ".config/systemd/user/omastoic.service"],
  ["completion", ".data/bash-completion/completions/omastoic"],
  ["menu", ".config/omarchy/extensions/omarchy-menu.jsonc"],
]) {
  test(`setup refuses an unrelated ${name} without destroying it`, async () => {
    const s = sandbox();
    const file = join(s.home, path);
    s.put(file, "private data\n");
    try {
      expect((await s.cli(["setup", "--quiet"])).code).toBe(1);
      expect(readFileSync(file, "utf8")).toBe("private data\n");
      expect(existsSync(join(s.state, "installed"))).toBe(false);
      await s.cli(["uninstall"]);
      expect(readFileSync(file, "utf8")).toBe("private data\n");
    } finally { s.cleanup(); }
  });
}

test("uninstall preserves replaced completions, units, backups and foreign symlinks", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--quiet"])).code).toBe(0);
    const completion = join(s.data, "bash-completion/completions/omastoic");
    s.put(completion, "custom completion");
    const backup = join(s.config, "omarchy/branding/screensaver.txt.pre-omastoic");
    s.put(backup, "unrelated backup");
    const launcher = join(s.home, ".local/bin/omastoic");
    rmSync(launcher); symlinkSync("/unrelated/program", launcher);
    expect((await s.cli(["uninstall"])).code).toBe(0);
    expect(readFileSync(completion, "utf8")).toBe("custom completion");
    expect(readFileSync(backup, "utf8")).toBe("unrelated backup");
    expect((await s.exec(["readlink", launcher])).stdout.trim()).toBe("/unrelated/program");
  } finally { s.cleanup(); }
});

test("concurrent setup and quote writers serialize and leave valid owned state", async () => {
  const s = sandbox();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => s.cli(["setup", "--on-first", "--quiet"])));
    for (const result of results) expect(result.code).toBe(0);
    const writes = await Promise.all(Array.from({ length: 5 }, () => s.cli(["next"])));
    for (const result of writes) expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.state, "recent.json"), "utf8")).length).toBeGreaterThan(0);
    expect((await s.cli(["off"])).code).toBe(0);
    expect(existsSync(join(s.config, "omarchy/branding/screensaver.txt"))).toBe(false);
  } finally { s.cleanup(); }
});

test("code-only updates restart an enabled daemon, an unchanged setup does not", async () => {
  const s = sandbox();
  const copy = join(s.home, "copy");
  // An ordinary source export, not another Git checkout or worktree.
  for (const path of ["src", "data", "art", "bin", "scripts", "completions", "manifest.json"]) cpSync(join(root, path), join(copy, path), { recursive: true });
  const cli = () => s.exec([process.execPath, join(copy, "src/cli.ts"), "setup", "--on-first", "--quiet"]);
  try {
    expect((await cli()).code).toBe(0);
    expect((await cli()).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    s.put(join(copy, "data/quotes.tsv"), readFileSync(join(copy, "data/quotes.tsv"), "utf8") + "\n# data-only update\n");
    expect((await cli()).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
    s.put(join(s.home, "systemctl.log"), "");
    expect((await cli()).code).toBe(0);
    expect(s.log()).not.toContain("restart omastoic.service");
  } finally { s.cleanup(); }
});

test("2.1 untracked plumbing and displaced art migrate without backing up our own canvas", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "original pre-2.1 art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    // Recreate 2.1's public on-disk installation contract (no ownership ledger,
    // plain ROOT marker, old watcher/marked menu block). The fixture is the
    // exact Bash artifact distributed in 2.1, not a source-string assertion.
    rmSync(join(s.state, "owned"), { recursive: true });
    rmSync(join(s.state, "displaced.kind"));
    rmSync(join(s.state, "launcher.target"));
    s.put(join(s.state, "installed"), root);
    s.put(join(s.home, ".local/lib/omastoic/prune.sh"), readFileSync(join(root, "tests/fixtures/prune-2.1.sh"), "utf8"));
    const path = join(s.config, "systemd/user/omastoic-prune.path");
    s.put(path, `[Unit]\nDescription=Watch for omastoic plugin removal\n\n[Path]\nPathChanged=${join(s.config, "omarchy/plugins")}\nUnit=omastoic-prune.service\n\n[Install]\nWantedBy=default.target\n`);
    s.put(join(s.config, "omarchy/extensions/omarchy-menu.jsonc"), '{\n // >>> omastoic:begin — old\n "style.screensaver.stoics":{"label":"Old"},\n "style.screensaver.configure":{"label":"Configure"},\n // <<< omastoic:end\n}\n');
    const result = await s.cli(["setup", "--on-first", "--quiet"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect((await s.cli(["on"])).code).toBe(0);
    expect((await s.cli(["off"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original pre-2.1 art\n");
    expect((await s.cli(["uninstall"])).code).toBe(0);
  } finally { s.cleanup(); }
});

for (const transition of ["on/off", "disable", "remove"]) {
  test(`legacy activation without a backup restores the host logo through ${transition}`, async () => {
    const s = sandbox();
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    const host = process.env.OMARCHY_TEST_ROOT ?? "/usr/share/omarchy";
    const logo = readFileSync(join(host, "logo.txt"), "utf8");
    s.put(join(s.env.OMARCHY_PATH, "logo.txt"), logo);
    try {
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      expect(existsSync(`${branding}.pre-omastoic`)).toBe(false);
      rmSync(join(s.state, "displaced.kind"));
      s.put(join(s.state, "installed"), root);
      const canvas = readFileSync(branding, "utf8");
      for (let i = 0; i < 2; i++) {
        expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
        expect(readFileSync(branding, "utf8")).toBe(canvas);
        expect(readFileSync(`${branding}.pre-omastoic`, "utf8")).toBe(logo);
        expect(readFileSync(join(s.state, "displaced.kind"), "utf8")).toBe("file");
      }
      if (transition === "on/off") {
        expect((await s.cli(["on"])).code).toBe(0);
        expect((await s.cli(["on"])).code).toBe(0);
        expect((await s.cli(["off"])).code).toBe(0);
      } else {
        if (transition === "disable") s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
        else rmSync(s.plugin, { recursive: true });
        expect((await s.prune()).code).toBe(0);
      }
      expect(readFileSync(branding, "utf8")).toBe(logo);
      expect(existsSync(join(s.state, "written.sha"))).toBe(false);
      expect((await s.cli(["off"])).code).toBe(0);
      expect((await s.cli(["uninstall"])).code).toBe(0);
      expect(readFileSync(branding, "utf8")).toBe(logo);
    } finally { s.cleanup(); }
  });
}

test("native backend is rejected before installing external artifacts", async () => {
  const s = sandbox();
  s.stub("omarchy-launch-screensaver", "exec /usr/lib/omarchy-screensaver/omarchy-screensaver");
  try {
    const result = await s.cli(["setup", "--on-first", "--quiet"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("native Omarchy screensaver is not supported");
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(false);
    expect(existsSync(join(s.state, "installed"))).toBe(false);
  } finally { s.cleanup(); }
});
