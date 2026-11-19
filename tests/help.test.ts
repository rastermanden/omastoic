import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";

const commands = [
  "show", "on", "off", "toggle", "next", "preview", "daemon", "setup", "install",
  "uninstall", "status", "config", "configure", "panel", "ui", "render-png",
];

test("--help and -h print usage for every command and do not run it", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "keep this art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const canvas = readFileSync(branding, "utf8");
    for (const command of commands) {
      for (const flag of ["--help", "-h"]) {
        const args = command === "panel" ? [command, "apply", flag] : [command, flag];
        const result = await s.cli(args);
        expect(result.code, args.join(" ")).toBe(0);
        expect(result.stdout).toContain("omastoic uninstall");
        expect(result.stdout).toContain("do nothing");
        expect(result.stderr).toBe("");
      }
    }
    for (const args of [["--help"], ["-h"], ["help"], ["uninstall", "--purge", "--help"], []]) {
      const result = await s.cli(args);
      expect(result.code, JSON.stringify(args)).toBe(0);
      expect(result.stdout).toContain("Install:");
      expect(result.stderr).toBe("");
    }
    const unknown = await s.cli(["no-such-command"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain("omastoic uninstall");
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect(existsSync(join(s.state, "installed"))).toBe(true);
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(true);
  } finally { s.cleanup(); }
});
