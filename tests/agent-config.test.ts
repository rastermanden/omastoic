import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./sandbox.ts";

// The agent workflow lives in one place: `.agents/skills/`. Claude Code reads
// `.claude/skills`, which is a real mirror of it (a symlink would fail the
// Omarchy validator). The pointer files are thin. This test fails when the
// canonical directory and its mirror drift, any symlink appears in the agent
// trees, or a pointer file goes missing.

const canonical = join(root, ".agents/skills");
const mirror = join(root, ".claude/skills");

function findSymlinks(target: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      found.push(path);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) {
      walk(join(path, entry));
    }
  };
  walk(target);
  return found;
}

test("the canonical skills directory holds the workflow skills", () => {
  for (const skill of [
    "projekt-workflow",
    "issue-fra-observation",
    "poteto-mode",
    "blast-radius",
    "interrogate",
    "correct",
    "unslop",
    "typesafe-ai",
  ]) {
    expect(existsSync(join(canonical, skill, "SKILL.md"))).toBe(true);
  }
});

test(".claude/skills is a real directory mirroring the canonical skills without symlinks", () => {
  // Real directories with no symlinks at any depth: omarchy plugin validate
  // refuses symlinks anywhere inside the plugin folder.
  expect(lstatSync(canonical).isDirectory()).toBe(true);
  expect(lstatSync(mirror).isDirectory()).toBe(true);
  for (const dir of [".agents", ".claude", ".cursor", ".gemini"]) {
    expect(findSymlinks(join(root, dir))).toEqual([]);
  }
  const result = spawnSync("diff", ["-r", "--no-dereference", canonical, mirror], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});

test("AGENTS.md names the workflow and VISION.md", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  expect(agents).toContain(".agents/skills/projekt-workflow/SKILL.md");
  expect(agents).toContain("VISION.md");
});

for (const pointer of [
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".agents/rules/omastoic.md",
  ".cursor/rules/vision.mdc",
]) {
  test(`${pointer} is a thin pointer to AGENTS.md`, () => {
    expect(readFileSync(join(root, pointer), "utf8")).toContain("AGENTS.md");
  });
}

test(".gemini/settings.json names AGENTS.md and GEMINI.md", () => {
  const settings = JSON.parse(readFileSync(join(root, ".gemini/settings.json"), "utf8"));
  expect(settings.context.fileName).toEqual(["AGENTS.md", "GEMINI.md"]);
});

test("agent files stay out of git archive and install.sh", () => {
  const gitattributes = readFileSync(join(root, ".gitattributes"), "utf8");
  const install = readFileSync(join(root, "install.sh"), "utf8");
  for (const path of [
    ".agents",
    ".claude",
    ".cursor",
    ".gemini",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
  ]) {
    expect(gitattributes).toContain(`${path} export-ignore`);
    expect(install).toContain(`--exclude ${path}`);
  }
});
