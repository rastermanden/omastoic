import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./sandbox.ts";

const line = ["curl -fsSL https://tailscale.com/install.sh", "sudo sh"].join(" | ") + "\n";

test("export-ignore skills do not trip a download piped to a shell, shipped files do", () => {
  const dir = mkdtempSync(join(tmpdir(), "omastoic-preflight-"));
  try {
    mkdirSync(join(dir, ".agents/skills"), { recursive: true });
    mkdirSync(join(dir, ".claude/skills"), { recursive: true });
    mkdirSync(join(dir, ".cursor/skills"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(
      join(dir, ".gitattributes"),
      ".agents export-ignore\n.claude export-ignore\n.cursor export-ignore\n",
    );
    writeFileSync(join(dir, ".agents/skills/SKILL.md"), line);
    writeFileSync(join(dir, ".claude/skills/SKILL.md"), line);
    writeFileSync(join(dir, ".cursor/skills/SKILL.md"), line);
    writeFileSync(join(dir, "install.sh"), line);
    writeFileSync(join(dir, "src/cli.ts"), line);
    writeFileSync(join(dir, "bin/omastoic"), line);

    const result = spawnSync("python3", [join(root, "scripts/preflight_scan.py"), dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["bin/omastoic", "install.sh", "src/cli.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release preflight on this checkout reports no download piped to a shell", () => {
  const result = spawnSync("python3", [join(root, "scripts/preflight_scan.py"), root], { encoding: "utf8" });
  expect(result.status).toBe(0);
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const hits = (JSON.parse(result.stdout) as string[]).filter((path) => tracked.has(path));
  expect(hits).toEqual([]);
});
