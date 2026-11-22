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
// error, an unresolved type, a bad import, or an unqualified access outside
// the host kit. The kit's `Style`/`Commons.Color` singletons are dynamic
// QtObjects that qmllint cannot see into, so `missing-property` warnings and
// `unqualified` warnings on `Style` or `Commons.Color` are reported, not fatal.

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
const KIT_NOISE = new Set(["missing-property", "duplicate-import", "uncreatable-type", "unused-imports", "deprecated"]);

/** True only when an [unqualified] warning points at the host kit's Style or Commons.Color singleton. */
function isKitUnqualified(sourceLine: string | undefined, start: number, length: number): boolean {
  if (!sourceLine || /^(?:Warning|Error|Info):/.test(sourceLine)) return false;
  if (start < 0 || length <= 0 || start + length > sourceLine.length) return false;
  if (start > 0 && /[\w$.]/.test(sourceLine[start - 1])) return false;
  const token = sourceLine.slice(start, start + length);
  const tail = sourceLine.slice(start);
  if (token === "Style") return /^Style(?![\w$])/.test(tail);
  if (token === "Commons" || token === "Commons.Color") return /^Commons\.Color(?![\w$])/.test(tail);
  return false;
}

/** The warning categories a wrong file produces: unresolved types, syntax, imports, and non-kit unqualified access. */
export function failuresIn(output: string): string[] {
  const failures: string[] = [];
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const category = /^(?:Warning|Error):.*\[([A-Za-z0-9_.-]+)\]\s*$/.exec(trimmed);
    if (!category) {
      if (trimmed.startsWith("Error:")) failures.push(trimmed);
      continue;
    }
    if (KIT_NOISE.has(category[1])) continue;
    if (category[1] === "unqualified") {
      const caretLine = lines[i + 2];
      const caret = caretLine ? /^([ \t]*)(\^+)\s*$/.exec(caretLine) : null;
      if (caret && isKitUnqualified(lines[i + 1], caret[1].length, caret[2].length)) continue;
    }
    failures.push(trimmed);
  }
  return failures;
}

export function copyForLint(source: string, target: string): void {
  writeFileSync(target, lintableSource(readFileSync(source, "utf8")));
}

interface QmlLintWarning {
  line?: number;
  column?: number;
  length?: number;
  id?: string;
  message?: string;
  type?: string;
}

interface QmlLintReport {
  files?: { filename?: string; warnings?: QmlLintWarning[] }[];
}

function formatJsonReport(report: QmlLintReport, sources: Map<string, string[]>): string {
  const linesOut: string[] = [];
  for (const file of report.files ?? []) {
    const filename = file.filename ?? "";
    const sourceLines = sources.get(filename) ?? sources.get(basename(filename)) ?? [];
    for (const warning of file.warnings ?? []) {
      const level = warning.type === "error" || warning.type === "critical"
        ? "Error"
        : warning.type === "info"
          ? "Info"
          : "Warning";
      const line = warning.line ?? 0;
      const column = warning.column ?? 0;
      const length = warning.length ?? 0;
      const message = String(warning.message ?? "").replace(/\s*\n\s*/g, " ").trim();
      const id = warning.id ? ` [${warning.id}]` : "";
      linesOut.push(`${level}: ${filename}:${line}:${column}: ${message}${id}`);
      const sourceLine = line > 0 ? sourceLines[line - 1] : undefined;
      if (sourceLine !== undefined && column > 0 && length > 0 && column - 1 + length <= sourceLine.length) {
        const prefix = sourceLine.slice(0, column - 1).replace(/[^\t]/g, " ");
        linesOut.push(sourceLine);
        linesOut.push(`${prefix}${"^".repeat(length)}`);
      }
    }
  }
  return linesOut.join("\n");
}

/** Lint the given QML files (or every QML entry point the manifest declares). Returns the output and any real failures. */
export function check(paths?: string[]): { skipped?: string; code: number; output: string; failures: string[] } {
  const host = hostShell();
  if (!host) return { skipped: "no Omarchy shell to check against", code: 0, output: "", failures: [] };
  const lint = qmllint();
  if (!lint) return { skipped: "qmllint is not installed", code: 0, output: "", failures: [] };

  const files = (paths ?? entryPoints()).filter((path) => existsSync(path));
  if (!files.length) return { skipped: "the manifest declares no QML entry points", code: 0, output: "", failures: [] };

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omastoic-qml-")));
  try {
    const copies = files.map((path, index) => {
      const name = path.startsWith(`${root}/`)
        ? path.slice(root.length + 1).replaceAll("/", "_")
        : `${index}_${basename(path)}`;
      return join(scratch, name);
    });
    const sources = new Map<string, string[]>();
    for (const [index, path] of files.entries()) {
      copyForLint(path, copies[index]);
      const lines = readFileSync(copies[index], "utf8").replace(/\r\n/g, "\n").split("\n");
      sources.set(copies[index], lines);
      sources.set(basename(copies[index]), lines);
    }
    // Use `--json -` so Qt 6.12's text printer cannot silently drop earlier
    // warnings in long QML files, then format into standard qmllint lines.
    const linted = Bun.spawnSync([lint, "-I", host, "--json", "-", ...copies], { stdout: "pipe", stderr: "pipe" });
    const stdout = linted.stdout.toString().trim();
    const stderr = linted.stderr.toString().trim();
    let output = [stdout, stderr].filter(Boolean).join("\n");
    if (stdout.startsWith("{")) {
      try {
        const formatted = formatJsonReport(JSON.parse(stdout) as QmlLintReport, sources);
        output = [formatted, stderr].filter(Boolean).join("\n");
      } catch {
        // Keep raw output when qmllint did not emit valid JSON.
      }
    }
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
