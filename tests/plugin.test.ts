import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the plugin manifest is what Omarchy will validate", () => {
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.id).toBe("omastoic");
  expect(manifest.name).toBeTruthy();
  expect(manifest.author).toBeTruthy();
  expect(manifest.description).toBeTruthy();
  expect(manifest.kinds).toEqual(["service"]);
  expect(manifest.entryPoints.service).toBe("Service.qml");
  expect(existsSync(join(root, manifest.entryPoints.service))).toBe(true);
  expect(manifest.id).not.toMatch(/^omarchy\./);
  expect(manifest.omarchy?.clonedFrom).toBeUndefined();
});

test("manifest and package.json carry the same version", () => {
  expect(manifest.version).toBe(pkg.version);
});

test("bash completion registers omastoic", () => {
  const bash = readFileSync(join(root, "completions/omastoic.bash"), "utf8");
  expect(bash).toContain("complete -F _omastoic omastoic");
  expect(bash).toContain("toggle");
  expect(bash).toContain("--authors");
});

test("the service points at the bundled launcher, not PATH", () => {
  const qml = readFileSync(join(root, "Service.qml"), "utf8");
  expect(qml).toContain('Qt.resolvedUrl("bin/omastoic")');
  expect(qml).toContain("setup");
  expect(qml).toContain("--on-first");
});
