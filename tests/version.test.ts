import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, root } from "./sandbox.ts";

test("version is the manifest version and matches package.json", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { version: string };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  expect(manifest.version).toBe(pkg.version);
  const s = sandbox();
  try {
    const flag = await s.cli(["--version"]);
    const command = await s.cli(["version"]);
    const status = await s.cli(["status"]);
    expect(flag.code).toBe(0);
    expect(flag.stderr).toBe("");
    expect(flag.stdout).toBe(`${manifest.version}\n`);
    expect(command.code).toBe(0);
    expect(command.stdout).toBe(flag.stdout);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`version:          ${manifest.version}\n`);
  } finally {
    s.cleanup();
  }
});
