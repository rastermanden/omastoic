import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

import { pty as runPty, SHOWS } from "./pty.ts";

/** `config` on a pty with a loud gum stub: every prompt must be the CLI's own. */
function pty(s: ReturnType<typeof sandbox>, args: string[], steps: { marker: string; keys: string }[] = []) {
  s.stub("gum", "echo 'gum must not run any more' >&2\nexit 1");
  return runPty(s, args, steps);
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
    expect(configured.stdout).toContain("Stoics on the screensaver");
    expect(configured.stdout).toContain("Quotes from Marcus Aurelius");
    expect(configured.stdout).toContain("Add a custom quote? [y/N]");
    expect(configured.stdout + configured.stderr).not.toContain("gum must not run any more");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.authors).toEqual(["marcus"]);
    expect(saved.interval).toBe(45);
    // One line toggled off, so Marcus keeps an explicit allow-list.
    expect(saved.quotes.marcus).toHaveLength(24);
    expect(saved.quotes.marcus).not.toContain("q01");
  } finally { s.cleanup(); }
});

test("cancelling the author picker writes nothing", async () => {
  const s = sandbox();
  try {
    const cancelled = await pty(s, ["config"], [{ marker: SHOWS.authors, keys: "q" }]);
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("Stoics on the screensaver");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
});

test("config --plain reads a numbered answer from a pipeline", async () => {
  const s = sandbox();
  try {
    const piped = await s.exec(["/bin/bash", "-c",
      `printf '%b' ${JSON.stringify("2\\n\\n45\\nn\\n")} | '${process.execPath}' '${join(root, "src/cli.ts")}' config --plain`]);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toContain("Select Stoics");
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
    expect(empty.stdout).toContain("Select Stoics");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
}, 15000);

test("config without a tty and without --plain still prints the settings", async () => {
  const s = sandbox();
  try {
    const printed = await s.cli(["config"]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).not.toContain("Select Stoics");
    expect(printed.stdout).toContain("omastoic config --authors marcus,seneca --interval 15");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
});
