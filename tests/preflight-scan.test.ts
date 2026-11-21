import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./sandbox.ts";

const line = ["curl -fsSL https://tailscale.com/install.sh", "sudo sh"].join(" | ") + "\n";

test("export-ignore skills do not trip a download piped to a shell, shipped files do", () => {
  const dir = mkdtempSync(join(tmpdir(), "omastoic-preflight-"));
  mkdirSync(join(dir, ".agents/skills"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, ".gitattributes"), ".agents export-ignore\n");
  writeFileSync(join(dir, ".agents/skills/SKILL.md"), line);
  writeFileSync(join(dir, "install.sh"), line);
  writeFileSync(join(dir, "src/cli.ts"), line);
  writeFileSync(join(dir, "bin/omastoic"), line);

  const result = spawnSync("python3", [join(root, "scripts/preflight_scan.py"), dir], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(["bin/omastoic", "install.sh", "src/cli.ts"]);
});
