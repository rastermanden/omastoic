import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellWidth } from "../src/canvas.ts";
import { root, sandbox } from "./sandbox.ts";

import { pty as runPty, ptySignal, SHOWS } from "./pty.ts";

/** `config` on a pty with a loud gum stub: every prompt must be the CLI's own. */
function pty(s: ReturnType<typeof sandbox>, args: string[], steps: { marker: string; keys: string }[] = [], extra: Record<string, string> = {}) {
  s.stub("gum", "echo 'gum must not run any more' >&2\nexit 1");
  return runPty(s, args, steps, extra);
}

test("every config prompt runs in the terminal, so gum is not needed", async () => {
  const s = sandbox();
  try {
    const configured = await pty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: " \r" },
      { marker: SHOWS.interval, keys: "\x1545\r" },
      { marker: SHOWS.confirm, keys: "n" },
    ]);
    expect(configured.code).toBe(0);
    expect(configured.stdout).toContain("Authors on the screensaver");
    expect(configured.stdout).toContain("Quotes from Marcus Aurelius");
    expect(configured.stdout).toContain("Add a custom quote? [y/N]");
    expect(configured.stdout + configured.stderr).not.toContain("gum must not run any more");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.authors).toEqual(["marcus"]);
    expect(saved.interval).toBe(45);
    // One line toggled off, so Marcus keeps an explicit allow-list.
    expect(saved.quotes.marcus).toHaveLength(26);
    expect(saved.quotes.marcus).not.toContain("q01");
  } finally { s.cleanup(); }
});

test("SIGTERM and SIGHUP hand the terminal back, then kill the process as themselves", async () => {
  for (const [name, number] of [["SIGTERM", 15], ["SIGHUP", 1]] as const) {
    const s = sandbox();
    try {
      const killed = await ptySignal(s, ["config"], SHOWS.authors, name);
      // The driver saw the prompt, the child died by that signal, and the tty is cooked again.
      expect(killed.stderr).toContain(`SIGNAL signaled=1 number=${number} code=-1 marker=1 cooked=1`);
      expect(killed.code).toBe(0);
      expect(killed.stdout).toContain(SHOWS.authors);
      expect(killed.stdout.trimEnd().endsWith("\x1b[?25h")).toBe(true);
      // A fatal signal is not a cancelled config: nothing is written.
      expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
    } finally { s.cleanup(); }
  }
}, 30000);

test("cancelling the author picker writes nothing", async () => {
  const s = sandbox();
  try {
    const cancelled = await pty(s, ["config"], [{ marker: SHOWS.authors, keys: "q" }]);
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("Authors on the screensaver");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
});

test("config --plain reads a numbered answer from a pipeline", async () => {
  const s = sandbox();
  try {
    const piped = await s.exec(["/bin/bash", "-c",
      `printf '%b' ${JSON.stringify("2\\n\\n45\\nn\\n")} | '${process.execPath}' '${join(root, "src/cli.ts")}' config --plain`]);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toContain("Select authors");
    expect(piped.stdout).toContain("2 [x] Seneca");
    expect(piped.stdout).toContain("Select quotes");
    expect(piped.stdout).toContain("Seconds between quotes while the screensaver is up: ");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.authors).toEqual(["seneca"]);
    expect(saved.interval).toBe(45);
  } finally { s.cleanup(); }
}, 15000);

test("config --plain stops at end of input instead of hanging", async () => {
  const s = sandbox();
  try {
    const empty = await s.exec(["/bin/bash", "-c",
      `printf '%b' '' | '${process.execPath}' '${join(root, "src/cli.ts")}' config --plain`]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("Select authors");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
}, 15000);

test("config without a tty and without --plain still prints the settings", async () => {
  const s = sandbox();
  try {
    const printed = await s.cli(["config"]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).not.toContain("Select authors");
    expect(printed.stdout).toContain("omastoic config --authors marcus,seneca --interval 15");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
});

test("config picker stays within 40/60/80/120 columns in a real pty and redraws in place on toggle", async () => {
  const s = sandbox();
  try {
    s.put(
      join(s.config, "omastoic/authors.tsv"),
      "seneca-long\tLucius Annaeus Seneca the Younger of Corduba in Hispania\tc. 4 BC – AD 65\n",
    );
    s.put(
      join(s.config, "omastoic/quotes.tsv"),
      "seneca-long\tLetters I.1\tWe suffer more often in imagination than in reality.\n",
    );

    for (const cols of [40, 60, 80, 120]) {
      const ran = await pty(s, ["config"], [
        { marker: SHOWS.authors, keys: " q" },
      ], { PTY_COLS: String(cols), PTY_ROWS: "24" });
      expect(ran.code, `${cols} cols`).toBe(0);

      const parts = ran.stdout.split("\x1b[J");
      // parts[1] is initial draw; parts[2] is the redraw after toggling row 1 with space.
      expect(parts.length, `${cols} cols`).toBeGreaterThanOrEqual(4);
      const parseLines = (chunk: string) =>
        chunk
          .replace(/\r\n/g, "\n")
          .replace(/\x1b\[\d*A/g, "")
          .replace(/\r/g, "")
          .split("\n");

      const first = parseLines(parts[1]!);
      const second = parseLines(parts[2]!);
      expect(first.length, `${cols} cols`).toBe(second.length);
      for (const line of [...first, ...second]) {
        expect(cellWidth(line), `${cols} cols: ${line}`).toBeLessThanOrEqual(cols);
      }
      expect(first.some((line) => line.startsWith("> 1 [x]"))).toBe(true);
      expect(second.some((line) => line.startsWith("> 1 [ ]"))).toBe(true);

      const upOnToggle = /\x1b\[(\d+)A\r$/.exec(parts[1]!);
      const upOnExit = /\x1b\[(\d+)A\r$/.exec(parts[2]!);
      expect(Number(upOnToggle?.[1]), `${cols} cols`).toBe(first.length - 1);
      expect(Number(upOnExit?.[1]), `${cols} cols`).toBe(second.length - 1);

      if (cols === 40) {
        const longRow = first.find((line) => line.includes("7 [x]"))!;
        expect(longRow.endsWith("…")).toBe(true);
      }
    }
  } finally { s.cleanup(); }
}, 30000);
