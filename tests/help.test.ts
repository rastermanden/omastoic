import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellWidth } from "../src/canvas.ts";
import { sandbox } from "./sandbox.ts";
import { pty } from "./pty.ts";

const commands = [
  "show", "on", "off", "toggle", "next", "preview", "daemon", "setup", "install",
  "uninstall", "status", "version", "config", "configure", "panel", "ui", "render-png",
];

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/;

test("--help and -h print per-command usage for every command and do not run it", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "keep this art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const canvas = readFileSync(branding, "utf8");
    for (const command of commands) {
      const canonical = command === "configure" ? "config" : command;
      for (const flag of ["--help", "-h"]) {
        const args = command === "panel" ? [command, "apply", flag] : [command, flag];
        const result = await s.cli(args);
        expect(result.code, args.join(" ")).toBe(0);
        expect(result.stdout, args.join(" ")).toContain(`omastoic ${canonical}`);
        expect(result.stdout, args.join(" ")).not.toContain("Install:");
        expect(result.stdout, args.join(" ")).not.toMatch(ANSI_ESCAPE);
        expect(result.stderr).toBe("");
      }
    }
    // `config --help` documents config-specific options.
    const configHelp = await s.cli(["config", "--help"]);
    expect(configHelp.code).toBe(0);
    for (const flag of ["--authors", "--interval", "--quotes", "--add", "--add-author", "--replace-author", "--remove-author", "--list", "--plain"]) {
      expect(configHelp.stdout).toContain(flag);
    }

    // `help <command>` and `uninstall --purge --help` also print subcommand usage without running.
    const helpConfig = await s.cli(["help", "config"]);
    expect(helpConfig.code).toBe(0);
    expect(helpConfig.stdout).toBe(configHelp.stdout);
    const uninstallHelp = await s.cli(["uninstall", "--purge", "--help"]);
    expect(uninstallHelp.code).toBe(0);
    expect(uninstallHelp.stdout).toContain("omastoic uninstall");
    expect(uninstallHelp.stdout).toContain("--purge");

    for (const args of [["--help"], ["-h"], ["help"], ["--version", "--help"], ["--version", "-h"], []]) {
      const result = await s.cli(args);
      expect(result.code, JSON.stringify(args)).toBe(0);
      expect(result.stdout).toContain("Install:");
      expect(result.stdout).not.toMatch(ANSI_ESCAPE);
      expect(result.stderr).toBe("");

      // Command descriptions all start in one column and `show` does not overflow it.
      const commandLines = result.stdout.split("\n").filter((line) => line.startsWith("  omastoic "));
      expect(commandLines.length).toBeGreaterThanOrEqual(8);
      const descriptionColumns = new Set(commandLines.map((line) => {
        const match = /^(  omastoic \S+(?: -h)?\s+)/.exec(line);
        return match ? match[1]!.length : -1;
      }));
      expect([...descriptionColumns]).toEqual([22]);
      expect(result.stdout).not.toContain("omastoic show --cols 92 --rows 25");

      // Closing prose wraps consistently at <= 72 columns.
      const proseLines = result.stdout
        .split("\n")
        .filter((line) => /^(Appearance|Edit Text|write the slot|The native|quote is written|changes quotes|starts the native)/.test(line));
      expect(proseLines.length).toBeGreaterThanOrEqual(6);
      for (const line of proseLines) {
        expect(line.length, line).toBeLessThanOrEqual(72);
      }
    }

    const unknown = await s.cli(["no-such-command"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain("omastoic uninstall");
    expect(readFileSync(branding, "utf8")).toBe(canvas);
    expect(existsSync(join(s.state, "installed"))).toBe(true);
    expect(existsSync(join(s.config, "systemd/user/omastoic.service"))).toBe(true);
  } finally { s.cleanup(); }
});

test("status leads with a summary line, moves internals to --verbose, and styles only TTY without NO_COLOR", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["config", "--authors", "marcus,seneca", "--interval", "90"])).code).toBe(0);

    // Default piped status: summary first, no grid/canvas internals, no ANSI escapes.
    const plain = await s.cli(["status"]);
    expect(plain.code).toBe(0);
    expect(plain.stderr).toBe("");
    const firstLine = plain.stdout.split("\n")[0]!;
    expect(firstLine).toBe("Stoics: on · Marcus Aurelius, Seneca · every 90s");
    expect(plain.stdout).toContain("backend:");
    expect(plain.stdout).toContain("52 quotes:");
    expect(plain.stdout).not.toContain("grid:");
    expect(plain.stdout).not.toContain("canvas file:");
    expect(plain.stdout).not.toMatch(ANSI_ESCAPE);

    // Verbose status includes grid and canvas file.
    const verbose = await s.cli(["status", "--verbose"]);
    expect(verbose.code).toBe(0);
    expect(verbose.stdout.split("\n")[0]).toBe("Stoics: on · Marcus Aurelius, Seneca · every 90s");
    expect(verbose.stdout).toContain("grid:");
    expect(verbose.stdout).toContain("canvas file:");
    expect(verbose.stdout).not.toMatch(ANSI_ESCAPE);

    // TTY without NO_COLOR adds bold summary and dimmed labels.
    const ttyStyled = await pty(s, ["status"], [], { NO_COLOR: "", TERM: "xterm-256color" });
    expect(ttyStyled.code).toBe(0);
    expect(ttyStyled.stdout).toContain("\x1b[1mStoics: on · Marcus Aurelius, Seneca · every 90s\x1b[0m");
    expect(ttyStyled.stdout).toContain("\x1b[2mbackend:");

    // TTY with NO_COLOR=1 disables all ANSI styling.
    const ttyNoColor = await pty(s, ["status"], [], { NO_COLOR: "1", TERM: "xterm-256color" });
    expect(ttyNoColor.code).toBe(0);
    expect(ttyNoColor.stdout).toContain("Stoics: on · Marcus Aurelius, Seneca · every 90s");
    expect(ttyNoColor.stdout).not.toMatch(ANSI_ESCAPE);

    // Singular "1 quote:" when a single quote is in rotation.
    expect((await s.cli(["config", "--authors", "marcus", "--quotes", "marcus=q01"])).code).toBe(0);
    const single = await s.cli(["status"]);
    expect(single.code).toBe(0);
    expect(single.stdout).toContain("1 quote:");
    expect(single.stdout).not.toContain("1 quotes:");
  } finally { s.cleanup(); }
});

test("config --help documents single-use and repeatable flags", async () => {
  const s = sandbox();
  try {
    const result = await s.cli(["config", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(ANSI_ESCAPE);

    const sections = result.stdout.trimEnd().split("\n\n");
    const note = sections[sections.length - 1]!;
    for (const line of note.split("\n")) {
      expect(line.length, line).toBeLessThanOrEqual(72);
    }

    const collapsed = note.replace(/\s+/g, " ");
    const [singleUseSentence = "", repeatSentence = ""] = collapsed.split(/\.\s+/);
    expect(singleUseSentence).toMatch(/only once/i);
    for (const flag of [
      "--authors",
      "--interval",
      "--name",
      "--dates",
      "--image",
      "--add-author",
      "--replace-author",
      "--remove-author",
    ]) {
      expect(singleUseSentence).toContain(flag);
    }
    expect(singleUseSentence).not.toContain("--citation");
    expect(singleUseSentence).not.toContain("--text");
    expect(repeatSentence).toMatch(/repeat.*--quotes.*--add/i);
    expect(repeatSentence).toMatch(/repeat.*--citation.*--text.*in pairs/i);
  } finally { s.cleanup(); }
});

test("status keeps count and portrait columns aligned with long and wide custom author names", async () => {
  const s = sandbox();
  const extractBookRows = (stdout: string) => {
    const lines = stdout.trimEnd().split("\n");
    const headerIdx = lines.findIndex((line) => /^\d+ quotes?:$/.test(line));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    return lines.slice(headerIdx + 1);
  };
  const assertAlignedColumns = (rows: string[]) => {
    const dataRows = rows.filter((line) => /\s+\d+\s+(?:no )?portrait$/.test(line));
    expect(dataRows.length).toBeGreaterThan(1);
    const countEnds = new Set<number>();
    const artStarts = new Set<number>();
    for (const line of dataRows) {
      const match = /^(.*?\s+\d+)(\s+)((?:no )?portrait)$/.exec(line);
      expect(match, line).not.toBeNull();
      countEnds.add(cellWidth(match![1]!));
      artStarts.add(cellWidth(match![1]! + match![2]!));
    }
    expect(countEnds.size).toBe(1);
    expect(artStarts.size).toBe(1);
  };

  try {
    // Bundled Stoics keep the exact existing 18-cell layout.
    const bundled = await s.cli(["status"]);
    expect(bundled.code).toBe(0);
    expect(bundled.stderr).toBe("");
    const bundledRows = extractBookRows(bundled.stdout);
    expect(bundledRows).toContain("  Marcus Aurelius     27  portrait");
    assertAlignedColumns(bundledRows);

    // Medium-long name (> 18 chars) and wide CJK name align count and portrait columns by display cells.
    const mediumName = "Lucius Annaeus Seneca the Younger";
    s.put(
      join(s.config, "omastoic/authors.tsv"),
      `seneca-younger\t${mediumName}\tc. 4 BC – AD 65\nkongzi\t孔子\t551 – 479 BC\n`,
    );
    s.put(
      join(s.config, "omastoic/quotes.tsv"),
      "seneca-younger\tLetters I.1\tWe suffer more often in imagination than in reality.\n" +
      "kongzi\tAnalects II.17\tReal knowledge is to know the extent of one's ignorance.\n",
    );
    const widened = await s.cli(["status"]);
    expect(widened.code).toBe(0);
    expect(widened.stderr).toBe("");
    const widenedRows = extractBookRows(widened.stdout);
    assertAlignedColumns(widenedRows);
    expect(widened.stdout).toContain(mediumName);
    expect(widened.stdout).toContain("孔子");

    // Very long names (> 40 chars, both multi-word and unbroken) indent-wrap while preserving full names and alignment.
    const longName = "Lucius Annaeus Seneca the Younger of Corduba in Hispania";
    const unbrokenName = "SupercalifragilisticexpialidociousPhilosopherOfStoa";
    s.put(
      join(s.config, "omastoic/authors.tsv"),
      `seneca-corduba\t${longName}\tc. 4 BC – AD 65\nunbroken\t${unbrokenName}\tAD 100 – 180\n`,
    );
    s.put(
      join(s.config, "omastoic/quotes.tsv"),
      "seneca-corduba\tLetters I.1\tWe suffer more often in imagination than in reality.\n" +
      "unbroken\tFragments I.1\tEndure and renounce.\n",
    );
    const wrapped = await s.cli(["status"]);
    expect(wrapped.code).toBe(0);
    expect(wrapped.stderr).toBe("");
    const wrappedRows = extractBookRows(wrapped.stdout);
    assertAlignedColumns(wrappedRows);
    for (const line of wrappedRows) {
      expect(cellWidth(line), line).toBeLessThanOrEqual(80);
    }
    // Continuation lines carry a hanging indent and preserve every character of the long names.
    expect(wrappedRows.some((line) => line.startsWith("    "))).toBe(true);
    const renderedNames: string[] = [];
    for (const line of wrappedRows) {
      if (line.startsWith("    ")) {
        expect(renderedNames.length).toBeGreaterThan(0);
        const cont = line.trim();
        renderedNames[renderedNames.length - 1] += ` ${cont}`;
      } else {
        const match = /^  (.*?)\s+\d+\s+(?:no )?portrait$/.exec(line);
        expect(match, line).not.toBeNull();
        renderedNames.push(match![1]!);
      }
    }
    expect(renderedNames).toContain(longName);
    expect(renderedNames.map((n) => n.replace(/\s+/g, ""))).toContain(unbrokenName);
  } finally { s.cleanup(); }
});
