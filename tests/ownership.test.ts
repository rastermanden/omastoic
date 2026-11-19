import { test, expect } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";

test("off, uninstall and cleanup leave a newer branding file and keep the backup", async () => {
  for (const stop of ["off", "uninstall", "cleanup"] as const) {
    const s = sandbox();
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    const backup = `${branding}.pre-omastoic`;
    s.put(branding, "art before the Stoics\n");
    try {
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      const kept = readFileSync(backup, "utf8");
      expect(kept).toBe("art before the Stoics\n");
      s.put(branding, "newer art from Omarchy\n");
      const result = stop === "cleanup"
        ? await s.prune()
        : await s.cli([stop]);
      expect(result.code).toBe(0);
      expect(readFileSync(branding, "utf8")).toBe("newer art from Omarchy\n");
      expect(readFileSync(backup, "utf8")).toBe(kept);
      if (stop !== "uninstall") expect(readFileSync(join(s.state, "written.sha"), "utf8").length).toBeGreaterThan(0);
    } finally { s.cleanup(); }
  }
});

test("a failed read does not replace config.json or quotes.tsv", async () => {
  const broken = "{ this is not json\n";
  const secret = "marcus\tPrivate\tDo not replace this line.\n";
  const settingsCase = sandbox();
  const settings = join(settingsCase.config, "omastoic/config.json");
  try {
    settingsCase.put(settings, broken);
    const interval = await settingsCase.cli(["config", "--interval", "30"]);
    expect(interval.code).toBe(1);
    expect(interval.stderr).toContain("refusing to replace");
    expect(readFileSync(settings, "utf8")).toBe(broken);
    const panel = await settingsCase.cli(["panel", "apply", JSON.stringify({ interval: 30 })]);
    expect(panel.code).toBe(1);
    expect(panel.stderr).toContain("refusing to replace");
    expect(readFileSync(settings, "utf8")).toBe(broken);
  } finally { settingsCase.cleanup(); }

  const quotesCase = sandbox();
  const quotes = join(quotesCase.config, "omastoic/quotes.tsv");
  try {
    quotesCase.put(quotes, secret);
    chmodSync(quotes, 0o000);
    const added = await quotesCase.cli(["config", "--add", "marcus\tCite\tA new line."]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain("could not read");
    chmodSync(quotes, 0o644);
    expect(readFileSync(quotes, "utf8")).toBe(secret);
  } finally {
    try { chmodSync(quotes, 0o644); } catch { /* already removed */ }
    quotesCase.cleanup();
  }
});

test("turning off does not restore over a screensaver change made while the backup is read", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const backup = `${branding}.pre-omastoic`;
  s.put(branding, "art before the Stoics\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const kept = readFileSync(backup, "utf8");
    const canvas = readFileSync(branding, "utf8");
    const result = await s.cli(["off"], {
      OMASTOIC_BEFORE_BRANDING_REPLACE: `printf '%s' 'newer art from Omarchy\n' > ${JSON.stringify(branding)}`,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("leaving it in place");
    expect(readFileSync(branding, "utf8")).toBe("newer art from Omarchy\n");
    expect(readFileSync(branding, "utf8")).not.toBe(canvas);
    expect(readFileSync(backup, "utf8")).toBe(kept);
    expect(readFileSync(join(s.state, "written.sha"), "utf8").length).toBeGreaterThan(0);
  } finally { s.cleanup(); }
});

test("cleanup does not restore over a screensaver change made while the backup is copied", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const backup = `${branding}.pre-omastoic`;
  s.put(branding, "art before the Stoics\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const kept = readFileSync(backup, "utf8");
    const canvas = readFileSync(branding, "utf8");
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    const result = await s.prune({
      OMASTOIC_BEFORE_BRANDING_REPLACE: `printf '%s' 'newer art from Omarchy\n' > ${JSON.stringify(branding)}`,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("leaving it in place");
    expect(readFileSync(branding, "utf8")).toBe("newer art from Omarchy\n");
    expect(readFileSync(branding, "utf8")).not.toBe(canvas);
    expect(readFileSync(backup, "utf8")).toBe(kept);
    expect(readFileSync(join(s.state, "written.sha"), "utf8").length).toBeGreaterThan(0);
  } finally { s.cleanup(); }
});

test("cleanup does not publish a partial backup copy or delete the backup when copy fails", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const backup = `${branding}.pre-omastoic`;
  s.put(branding, "art before the Stoics\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const kept = readFileSync(backup, "utf8");
    const canvas = readFileSync(branding, "utf8");
    s.stub("cp", "printf '%s' PARTIAL > \"${@: -1}\"; exit 1");
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    const result = await s.prune();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not copy the screensaver backup");
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect(readFileSync(branding, "utf8")).not.toContain("PARTIAL");
    expect(readFileSync(backup, "utf8")).toBe(kept);
  } finally { s.cleanup(); }
});

test("setup and cleanup keep branding and menu symlinks and write the target", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const menu = join(s.config, "omarchy/extensions/omarchy-menu.jsonc");
  const brandingTarget = join(s.home, "branding-target.txt");
  const menuTarget = join(s.home, "menu-target.jsonc");
  mkdirSync(join(s.config, "omarchy/branding"), { recursive: true });
  mkdirSync(join(s.config, "omarchy/extensions"), { recursive: true });
  s.put(brandingTarget, "art before the Stoics\n");
  s.put(menuTarget, "{\n}\n");
  symlinkSync(brandingTarget, branding);
  symlinkSync(menuTarget, menu);
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect(lstatSync(branding).isSymbolicLink()).toBe(true);
    expect(lstatSync(menu).isSymbolicLink()).toBe(true);
    expect(readFileSync(brandingTarget, "utf8")).not.toBe("art before the Stoics\n");
    expect(readFileSync(menuTarget, "utf8")).toContain("omastoic:begin");
    expect((await s.cli(["off"])).code).toBe(0);
    expect(lstatSync(branding).isSymbolicLink()).toBe(true);
    expect(readFileSync(brandingTarget, "utf8")).toBe("art before the Stoics\n");
    rmSync(s.plugin, { recursive: true });
    expect((await s.prune()).code).toBe(0);
    expect(lstatSync(menu).isSymbolicLink()).toBe(true);
    expect(readFileSync(menuTarget, "utf8")).not.toContain("omastoic:begin");
    expect(lstatSync(branding).isSymbolicLink()).toBe(true);
  } finally { s.cleanup(); }
});
