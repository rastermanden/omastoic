import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
