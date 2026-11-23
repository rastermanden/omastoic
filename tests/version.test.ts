import { test, expect } from "bun:test";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, root } from "./sandbox.ts";

test("version prints the manifest version, matches package.json, and appears in status", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { version: string };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  expect(manifest.version.length).toBeGreaterThan(0);
  expect(manifest.version).toBe(pkg.version);

  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "keep this art\n");
  try {
    const flag = await s.cli(["--version"]);
    const command = await s.cli(["version"]);
    const launcher = await s.exec([join(root, "bin/omastoic"), "--version"]);
    expect(flag.code).toBe(0);
    expect(flag.stderr).toBe("");
    expect(flag.stdout).toBe(`${manifest.version}\n`);
    expect(command.code).toBe(0);
    expect(command.stderr).toBe("");
    expect(command.stdout).toBe(flag.stdout);
    expect(launcher.code).toBe(0);
    expect(launcher.stderr).toBe("");
    expect(launcher.stdout).toBe(flag.stdout);
    expect(existsSync(s.state)).toBe(false);
    expect(readFileSync(branding, "utf8")).toBe("keep this art\n");

    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout.split("\n")[0]).toMatch(/^Stoics: /);
    expect(status.stdout).toContain(`version:  ${manifest.version}\n`);
    expect(existsSync(s.state)).toBe(false);
    expect(readFileSync(branding, "utf8")).toBe("keep this art\n");

    const verboseStatus = await s.cli(["status", "--verbose"]);
    expect(verboseStatus.code).toBe(0);
    expect(verboseStatus.stderr).toBe("");
    expect(verboseStatus.stdout).toContain(`version:      ${manifest.version}\n`);
    expect(existsSync(s.state)).toBe(false);
    expect(readFileSync(branding, "utf8")).toBe("keep this art\n");
  } finally {
    s.cleanup();
  }
});

test("version reads only manifest.json from the plugin tree and fails when missing or empty", async () => {
  const s = sandbox();
  const copy = join(s.home, "plugin-copy");
  cpSync(join(root, "src"), join(copy, "src"), { recursive: true });
  const cli = (args: string[]) => s.exec([process.execPath, join(copy, "src/cli.ts"), ...args]);
  try {
    s.put(join(copy, "manifest.json"), JSON.stringify({ version: "9.9.9-test" }));
    const customFlag = await cli(["--version"]);
    const customCmd = await cli(["version"]);
    expect(customFlag.code).toBe(0);
    expect(customFlag.stderr).toBe("");
    expect(customFlag.stdout).toBe("9.9.9-test\n");
    expect(customCmd.code).toBe(0);
    expect(customCmd.stderr).toBe("");
    expect(customCmd.stdout).toBe("9.9.9-test\n");

    for (const bad of ["{}", '{"version":""}', '{"version":"   "}', "null"]) {
      s.put(join(copy, "manifest.json"), bad);
      const failed = await cli(["--version"]);
      expect(failed.code, bad).toBe(1);
      expect(failed.stdout, bad).toBe("");
      expect(failed.stderr, bad).toContain("manifest.json has no version");
    }
  } finally {
    s.cleanup();
  }
});
