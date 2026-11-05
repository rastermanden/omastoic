import { test, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";
import { PLUGIN_ID } from "../src/plugin-id.ts";

test("host disable stops and disables rotation; hot reload does not", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "old art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    const canvas = readFileSync(branding, "utf8");
    expect((await s.prune()).code).toBe(0); // destruction during hot reload
    expect(s.log()).toBe("");
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    // The host removes disabled third-party entries from plugins[].
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":[]}');
    expect((await s.prune()).code).toBe(0);
    expect(s.log()).toContain("disable --now omastoic.service");
    expect(existsSync(join(s.home, "omastoic.service.enabled"))).toBe(false);
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(false);
    expect(readFileSync(branding, "utf8")).toBe("old art\n");
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(true);
    s.put(join(s.config, "omarchy/shell.json"), JSON.stringify({ plugins: [{ id: PLUGIN_ID }] }));
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    // Source-toggle remains off after disable, rather than stealing the slot.
    expect(readFileSync(branding, "utf8")).toBe("old art\n");
  } finally { s.cleanup(); }
}, 10000);

for (const hadArt of [true, false]) {
  test(`host removal cleans up owned files and marker (prior art=${hadArt})`, async () => {
    const s = sandbox();
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    const menu = join(s.config, "omarchy/extensions/omarchy-menu.jsonc");
    const original = '{\n // Keep my } comment\n "personal":{"label":"Personal"}\n}\n';
    s.put(menu, original);
    if (hadArt) s.put(branding, "original art\n");
    try {
      expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
      rmSync(s.plugin, { recursive: true });
      const result = await s.prune();
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(s.log()).toContain("disable --now omastoic.service");
      expect(s.log()).toContain("disable --now omastoic-prune.path");
      for (const path of [join(s.home, ".local/bin/omastoic"), join(s.config, "systemd/user/omastoic.service"), join(s.data, "bash-completion/completions/omastoic"), join(s.state, "installed")]) expect(existsSync(path)).toBe(false);
      expect(readFileSync(menu, "utf8")).toBe(original);
      if (hadArt) expect(readFileSync(branding, "utf8")).toBe("original art\n");
      else expect(existsSync(branding)).toBe(false);
      expect((await s.prune()).code).toBe(0);
    } finally { s.cleanup(); }
  }, 10000);
}

test("remove preserves user-changed art and other artifacts", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const branding = join(s.config, "omarchy/branding/screensaver.txt");
    const completion = join(s.data, "bash-completion/completions/omastoic");
    s.put(branding, "USER ART"); s.put(completion, "custom completion");
    rmSync(s.plugin, { recursive: true });
    expect((await s.prune()).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("USER ART");
    expect(readFileSync(completion, "utf8")).toBe("custom completion");
  } finally { s.cleanup(); }
}, 10000);

test("an incomplete host config or checkout is not evidence of disable/removal", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    rmSync(join(s.plugin, "manifest.json"));
    s.put(join(s.config, "omarchy/shell.json"), '{"plugins":');
    expect((await s.prune()).code).toBe(0);
    expect(s.log()).toBe("");
  } finally { s.cleanup(); }
});
