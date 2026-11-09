#!/usr/bin/env bun
// Compile-check the plugin's QML against the host's kit, without starting a shell.
//
// Quickshell's `qs.*` import prefix resolves to the shell's own root directory,
// which only exists inside the shell process. `qmllint` has no such prefix, so
// this copies each checked file, rewrites `import qs.X` to `import X`, points
// the import path at the host shell (`/usr/share/omarchy/shell`, or
// `$OMARCHY_TEST_ROOT/shell`) and lints the copy. QtQuick and Quickshell
// themselves come from the system QML import path.
//
// Only problems that mean the file itself is wrong fail the check: a syntax
// error, an unresolved type, a bad import. The kit's `Style`/`Commons.Color`
// singletons are dynamic QtObjects that qmllint cannot see into, so
// `missing-property` and `unqualified` warnings are reported, not fatal.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const root = join(import.meta.dir, "..");

/** Every QML file the manifest declares, as absolute paths. */
export function entryPoints(): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  return Object.values(manifest.entryPoints ?? {}).map((entry) => join(root, String(entry))).sort();
}

/** Directory of the audited host shell, or null when this machine has none. */
export function hostShell(): string | null {
  const candidate = join(process.env.OMARCHY_TEST_ROOT ?? "/usr/share/omarchy", "shell");
  try {
    readdirSync(join(candidate, "Ui"));
    return candidate;
  } catch {
    return null;
  }
}

export function qmllint(): string | null {
  const onPath = Bun.which("qmllint");
  if (onPath) return onPath;
  return existsSync("/usr/lib/qt6/bin/qmllint") ? "/usr/lib/qt6/bin/qmllint" : null;
}

/** `import qs.Ui` / `import qs.Commons as Commons` → a plain directory import. */
export function lintableSource(text: string): string {
  return text
    .replace(/^import qs\.(\w+)\s+as\s+\w+$/gm, "import $1")
    .replace(/^import qs\.(\w+)$/gm, "import $1");
}

/** Warning categories that describe the kit, not the file being checked. */
const KIT_NOISE = new Set(["unqualified", "missing-property", "duplicate-import", "uncreatable-type", "unused-imports", "deprecated"]);

/** The warning categories a wrong file produces: unresolved types, syntax, imports. */
export function failuresIn(output: string): string[] {
  const failures: string[] = [];
  for (const line of output.split("\n")) {
    const category = /\[([a-z-]+)\]\s*$/.exec(line.trim());
    if (!category) continue;
    if (KIT_NOISE.has(category[1])) continue;
    failures.push(line.trim());
  }
  return failures;
}

export function copyForLint(source: string, target: string): void {
  writeFileSync(target, lintableSource(readFileSync(source, "utf8")));
}

/** Lint every QML entry point the manifest declares. Returns the output and any real failures. */
export function check(): { skipped?: string; code: number; output: string; failures: string[] } {
  const host = hostShell();
  if (!host) return { skipped: "no Omarchy shell to check against", code: 0, output: "", failures: [] };
  const lint = qmllint();
  if (!lint) return { skipped: "qmllint is not installed", code: 0, output: "", failures: [] };

  const files = entryPoints().filter((path) => existsSync(path));
  if (!files.length) return { skipped: "the manifest declares no QML entry points", code: 0, output: "", failures: [] };

  const scratch = mkdtempSync(join(tmpdir(), "omastoic-qml-"));
  try {
    const copies = files.map((path) => join(scratch, path.slice(root.length + 1).replaceAll("/", "_")));
    for (const [index, path] of files.entries()) copyForLint(path, copies[index]);
    const linted = Bun.spawnSync([lint, "-I", host, ...copies], { stdout: "pipe", stderr: "pipe" });
    const output = `${linted.stdout.toString()}${linted.stderr.toString()}`.trim();
    return { code: linted.exitCode ?? 1, output, failures: failuresIn(output) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = check();
  if (result.skipped) {
    console.log(`qml: skipped — ${result.skipped}`);
  } else {
    if (result.output) console.log(result.output);
    if (result.code !== 0 || result.failures.length) {
      console.error(`qml: ${result.failures.length || 1} problem(s) in the QML entry points`);
      process.exit(1);
    }
    console.log("qml: the manifest's QML entry points compile against the host kit");
  }
}
