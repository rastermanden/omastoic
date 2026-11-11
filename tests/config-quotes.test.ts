import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

import { pty, SHOWS } from "./pty.ts";

/** A config run on a pty with a gum stub that fails if anything still calls it. */
function configPty(s: ReturnType<typeof sandbox>, args: string[], steps: { marker: string; keys: string }[]) {
  s.stub("gum", "echo 'gum must not run any more' >&2\nexit 1");
  return pty(s, args, steps);
}

const gitEnv = {
  GIT_AUTHOR_NAME: "omastoic",
  GIT_AUTHOR_EMAIL: "omastoic@example.com",
  GIT_COMMITTER_NAME: "omastoic",
  GIT_COMMITTER_EMAIL: "omastoic@example.com",
};

test("config selects bundled quotes, lists them, and still adds custom lines", async () => {
  const s = sandbox();
  try {
    const listed = await s.cli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("* q01  marcus  Meditations II.5");
    expect(listed.stdout).toContain("custom:\n  (none)");

    const limited = await s.cli(["config", "--authors", "marcus", "--quotes", "marcus=q01"]);
    expect(limited.code).toBe(0);
    expect(limited.stdout).toContain("1 of 27 quotes");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved).toEqual({ authors: ["marcus"], quotes: { marcus: ["q01"] } });

    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("Meditations II.5");
    expect(shown.stdout).toContain("every act of thy life");
    expect(shown.stdout).not.toContain("ten thousand years");

    const added = await s.cli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(added.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8")).toContain("marcus\tDesk note\tA custom sentence for the saver.\n");
    const again = await s.cli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already in");

    const canvases = [shown.stdout];
    for (let i = 0; i < 24; i++) canvases.push((await s.cli(["show", "--cols", "92", "--rows", "25"])).stdout);
    expect(canvases.every((canvas) => canvas.length > 0)).toBe(true);
    expect(canvases.some((canvas) => canvas.includes("A custom sentence for the saver."))).toBe(true);
    expect(canvases.some((canvas) => canvas.includes("Meditations II.5"))).toBe(true);

    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("2 quotes:");
    expect(status.stdout).toContain("Marcus Aurelius");
    expect(status.stdout).not.toContain("Seneca");

    const one = await s.cli(["config", "--authors", "epictetus", "--quotes", "epictetus=q49"]);
    expect(one.code).toBe(0);
    const epictetus = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(epictetus.stdout).toContain("I must die");
    expect(epictetus.stdout).not.toContain("fetter my leg");

    const rejected = await s.cli(["config", "--quotes", "marcus=q99"]);
    expect(rejected.code).toBe(1);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).quotes.epictetus).toEqual(["q49"]);

    const cleared = await s.cli(["config", "--quotes", "all", "--authors", "all"]);
    expect(cleared.code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({});
    const book = await s.cli(["status"]);
    expect(book.stdout).toContain("85 quotes:");
  } finally { s.cleanup(); }
});

test("a bad quote field is ignored and an empty bundled list can fall back", async () => {
  const s = sandbox();
  try {
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 12, quotes: { marcus: ["nope"] } }));
    const kept = await s.cli(["status"]);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain("84 quotes:");
    expect(kept.stdout).toContain("every 12s");
    expect(kept.stderr).not.toContain("ignoring unreadable");

    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({
      quotes: { marcus: [], seneca: [], epictetus: [], zeno: [], cleanthes: [], chrysippus: [] },
    }));
    const fellBack = await s.cli(["status"]);
    expect(fellBack.code).toBe(0);
    expect(fellBack.stderr).toContain("config quotes matched no quotes");
    expect(fellBack.stdout).toContain("84 quotes:");
    expect(fellBack.stdout).toContain("0 of 84 quotes");
    const unmarked = await s.cli(["config", "--list"]);
    expect(unmarked.stdout).toContain("  q01  marcus  Meditations II.5");
    expect(unmarked.stdout).not.toContain("* q01");
    expect(unmarked.stderr).toContain("config quotes matched no quotes");
  } finally { s.cleanup(); }
});

test("config warns when an empty selection is ignored at rotation", async () => {
  const s = sandbox();
  try {
    const narrowed = await s.cli(["config", "--authors", "marcus", "--quotes", "marcus=none"]);
    expect(narrowed.code).toBe(0);
    expect(narrowed.stdout).toContain("0 of 27 quotes");
    expect(narrowed.stderr).toContain("config authors matched no quotes; using the whole book");
    const whole = await s.cli(["status"]);
    expect(whole.stdout).toContain("84 quotes:");
    expect(whole.stderr).toContain("config authors matched no quotes; using the whole book");

    const stoics = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];
    const selected = await s.cli(["config", "--authors", "marcus", ...stoics.flatMap((slug) => ["--quotes", `${slug}=none`])]);
    expect(selected.code).toBe(0);
    expect(selected.stdout).toContain("0 of 27 quotes");
    expect(selected.stderr).toContain("quote selection was ignored; using the selected Stoics' lines");
    expect(selected.stderr).not.toContain("using the whole book");
    const kept = await s.cli(["status"]);
    expect(kept.stdout).toContain("27 quotes:");
    expect(kept.stdout).toContain("Marcus Aurelius");
    expect(kept.stdout).not.toContain("Seneca");
    expect(kept.stderr).toContain("quote selection was ignored; using the selected Stoics' lines");
    expect(kept.stderr).not.toContain("using the whole book");
  } finally { s.cleanup(); }
});

test("quote flags keep canonical ids and reject extra spellings", async () => {
  const s = sandbox();
  try {
    const kept = await s.cli(["config", "--quotes", "marcus=q01"]);
    expect(kept.code).toBe(0);
    for (const flag of ["*", "marcus=*", "marcus=-", "marcus=q1", "marcus=q001"]) {
      const rejected = await s.cli(["config", "--quotes", flag]);
      expect(rejected.code).toBe(1);
      expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).quotes.marcus).toEqual(["q01"]);
    }
    const none = await s.cli(["config", "--quotes", "marcus=none"]);
    expect(none.code).toBe(0);
    const all = await s.cli(["config", "--quotes", "marcus=all"]);
    expect(all.code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({});
    const reset = await s.cli(["config", "--quotes", "marcus=q01", "--quotes", "all"]);
    expect(reset.code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({});
  } finally { s.cleanup(); }
});

test("config --add without a value is a usage error when it cannot prompt", async () => {
  const s = sandbox();
  try {
    const missing = await s.cli(["config", "--add"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--add expects one author, citation and text");
    expect(missing.stderr).toContain("omastoic config --add");
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);

    // On a terminal the same command asks instead, with no gum anywhere.
    const terminal = await configPty(s, ["config", "--add"], [
      { marker: SHOWS.author, keys: "\x03" },
    ]);
    expect(terminal.code).toBe(0);
    expect(terminal.stdout).toContain("Author slug: marcus");
    expect(terminal.stdout + terminal.stderr).not.toContain("gum must not run any more");
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);
  } finally { s.cleanup(); }
});

test("config --add prompts for author, citation and text", async () => {
  const s = sandbox();
  try {
    const added = await configPty(s, ["config", "--add"], [
      { marker: SHOWS.author, keys: "\x15marcus\r" },
      { marker: SHOWS.citation, keys: "\x15Desk note\r" },
      { marker: SHOWS.text, keys: "\x15A custom sentence\rfor the saver.\x04" },
    ]);
    expect(added.code).toBe(0);
    const saved = readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8");
    expect(saved).toBe("# author-slug <TAB> citation <TAB> text\nmarcus\tDesk note\tA custom sentence for the saver.\n");
    expect(saved).not.toContain("\t\t");
    const again = await configPty(s, ["config", "--add"], [
      { marker: SHOWS.author, keys: "\x15marcus\r" },
      { marker: SHOWS.citation, keys: "\x15Desk note\r" },
      { marker: SHOWS.text, keys: "\x15A custom sentence\rfor the saver.\x04" },
    ]);
    expect(again.code).toBe(1);
    expect(again.stdout + again.stderr).toContain("already in");
  } finally { s.cleanup(); }
});

test("accepting the prefilled quote suggestion writes that line", async () => {
  const s = sandbox();
  try {
    const added = await configPty(s, ["config", "--add"], [
      { marker: SHOWS.author, keys: "\r" },
      { marker: SHOWS.citation, keys: "\r" },
      { marker: SHOWS.text, keys: "\x04" },
    ]);
    expect(added.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8")).toBe(
      "# author-slug <TAB> citation <TAB> text\nmarcus\tMeditations IX.1\tYour line.\n",
    );
  } finally { s.cleanup(); }
});

test("cancelling the add prompt writes nothing, and a bad slug is rejected", async () => {
  const s = sandbox();
  try {
    const cancelled = await configPty(s, ["config", "--add"], [
      { marker: SHOWS.author, keys: "\x03" },
    ]);
    expect(cancelled.code).toBe(0);
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);

    const rejected = await configPty(s, ["config", "--add"], [
      { marker: SHOWS.author, keys: "Marcus Aurelius\r" },
      { marker: SHOWS.citation, keys: "Desk note\r" },
      { marker: SHOWS.text, keys: "A custom sentence for the saver.\x04" },
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("invalid quote author slug");
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);
  } finally { s.cleanup(); }
});

test("omastoic config offers a custom quote after the Stoic and quote prompts", async () => {
  const s = sandbox();
  try {
    const configured = await configPty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: "\r" },
      { marker: SHOWS.interval, keys: "\x1530\r" },
      { marker: SHOWS.confirm, keys: "y" },
      { marker: SHOWS.author, keys: "\x15marcus\r" },
      { marker: SHOWS.citation, keys: "\x15Desk note\r" },
      { marker: SHOWS.text, keys: "\x15A custom sentence for the saver.\x04" },
    ]);
    expect(configured.code).toBe(0);
    expect(configured.stdout).toContain("Add a custom quote? [y/N]");
    // The picker kept every line, so the settings stay compact; the custom line
    // itself is what the quote book gained.
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
    });
    expect(readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8")).toContain("marcus\tDesk note\tA custom sentence for the saver.\n");
  } finally { s.cleanup(); }
});

test("accepted settings survive a cancelled or invalid optional quote", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  // Every screen answers the same way; only the quote step differs per case.
  const screens = [
    { marker: SHOWS.authors, keys: "n1\r" },
    { marker: SHOWS.quotes, keys: "n\r" },
    { marker: SHOWS.interval, keys: "\x1530\r" },
  ];
  try {
    const escaped = await configPty(s, ["config"], [
      ...screens,
      { marker: SHOWS.confirm, keys: "y" },
      { marker: SHOWS.author, keys: "\x03" },
    ]);
    expect(escaped.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: [] },
    });
    expect(existsSync(quotesPath)).toBe(false);

    rmSync(settingsPath);
    const rejected = await configPty(s, ["config"], [
      ...screens,
      { marker: SHOWS.confirm, keys: "y" },
      { marker: SHOWS.author, keys: "Marcus Aurelius\r" },
      { marker: SHOWS.citation, keys: "Desk note\r" },
      { marker: SHOWS.text, keys: "A custom sentence for the saver.\x04" },
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("invalid quote author slug");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: [] },
    });
    expect(existsSync(quotesPath)).toBe(false);

    rmSync(settingsPath);
    const aborted = await configPty(s, ["config"], [
      ...screens,
      { marker: SHOWS.confirm, keys: "\x1b" },
    ]);
    expect(aborted.code).toBe(0);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(quotesPath)).toBe(false);

    const flagged = await configPty(s, ["config", "--authors", "seneca", "--interval", "30", "--add"], [
      { marker: SHOWS.author, keys: "\x03" },
    ]);
    expect(flagged.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ authors: ["seneca"], interval: 30 });
    expect(existsSync(quotesPath)).toBe(false);

    const flaggedBad = await configPty(s, ["config", "--interval", "45", "--add"], [
      { marker: SHOWS.author, keys: "Marcus Aurelius\r" },
      { marker: SHOWS.citation, keys: "Desk note\r" },
      { marker: SHOWS.text, keys: "A custom sentence for the saver.\x04" },
    ]);
    expect(flaggedBad.code).toBe(1);
    expect(flaggedBad.stdout + flaggedBad.stderr).toContain("invalid quote author slug");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ authors: ["seneca"], interval: 45 });
    expect(existsSync(quotesPath)).toBe(false);

    const added = await s.cli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(added.code).toBe(0);
    const before = readFileSync(quotesPath, "utf8");
    const duplicate = await s.cli(["config", "--interval", "12", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already in");
    expect(readFileSync(quotesPath, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ authors: ["seneca"], interval: 12 });

    const broken = "Marcus Aurelius\tDesk\tLine\n";
    s.put(quotesPath, broken);
    const unreadable = await s.cli(["config", "--interval", "15", "--add", "marcus\tMeditations IX.1\tYour line."]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain("invalid quote author slug");
    expect(readFileSync(quotesPath, "utf8")).toBe(broken);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ authors: ["seneca"], interval: 15 });
  } finally { s.cleanup(); }
});

test("a bundled allow-list still shows a custom quote in the list, checkbox, and rotation", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  try {
    s.put(settingsPath, JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01"] } }));
    s.put(join(s.config, "omastoic/quotes.tsv"), "marcus\tDesk note\tA custom sentence for the saver.\n");

    const listed = await s.cli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("2 of 28 quotes");
    expect(listed.stdout).toContain("* c01  marcus  Desk note  A custom sentence for the saver.");
    expect(listed.stdout).toContain("* q01  marcus");

    const status = await s.cli(["status"]);
    expect(status.stdout).toContain("2 quotes:");
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
      expect(shown.code).toBe(0);
      if (shown.stdout.includes("A custom sentence for the saver.")) seen.add("custom");
      if (shown.stdout.includes("Meditations II.5")) seen.add("bundled");
    }
    expect([...seen].sort()).toEqual(["bundled", "custom"]);

    const configured = await configPty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: "\r" },
      { marker: SHOWS.interval, keys: "\x1530\r" },
      { marker: SHOWS.confirm, keys: "n" },
    ]);
    expect(configured.code).toBe(0);
    // A bundled-only allow-list still keeps the custom line, so it stays checked.
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).quotes.marcus).toEqual(["q01", "c01"]);
  } finally { s.cleanup(); }
});

test("a plugin update leaves added quotes and settings in the user config", async () => {
  const s = sandbox();
  const origin = join(s.home, "origin");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  const settingsPath = join(s.config, "omastoic/config.json");
  const pluginCli = (args: string[]) => s.exec([process.execPath, join(s.plugin, "src/cli.ts"), ...args]);
  const git = (args: string[]) => s.exec(["git", ...args], gitEnv);
  try {
    rmSync(origin, { recursive: true, force: true });
    mkdirSync(origin, { recursive: true });
    for (const path of ["src", "data", "art", "bin", "scripts", "completions", "manifest.json"]) {
      cpSync(join(root, path), join(origin, path), { recursive: true });
    }
    expect((await git(["init", "-b", "main", origin])).code).toBe(0);
    expect((await git(["-C", origin, "add", "."])).code).toBe(0);
    expect((await git(["-C", origin, "commit", "-m", "base"])).code).toBe(0);
    rmSync(s.plugin, { recursive: true, force: true });
    expect((await git(["clone", origin, s.plugin])).code).toBe(0);

    expect((await pluginCli(["setup", "--quiet"])).code).toBe(0);
    const added = await pluginCli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver.", "--interval", "45"]);
    expect(added.code).toBe(0);
    const quotesBefore = readFileSync(quotesPath, "utf8");
    const settingsBefore = readFileSync(settingsPath, "utf8");
    expect(quotesBefore).toContain("marcus\tDesk note\tA custom sentence for the saver.\n");
    expect(existsSync(join(s.plugin, "quotes.tsv"))).toBe(false);
    expect(existsSync(join(s.plugin, "config.json"))).toBe(false);
    expect(readFileSync(join(s.plugin, "data/quotes.tsv"), "utf8")).not.toContain("Desk note");

    const bundled = join(origin, "data/quotes.tsv");
    writeFileSync(bundled, `${readFileSync(bundled, "utf8")}# plugin update\n`);
    expect((await git(["-C", origin, "add", "data/quotes.tsv"])).code).toBe(0);
    expect((await git(["-C", origin, "commit", "-m", "update"])).code).toBe(0);
    expect((await git(["-C", s.plugin, "fetch", "origin"])).code).toBe(0);
    expect((await git(["-C", s.plugin, "merge", "--ff-only", "FETCH_HEAD"])).code).toBe(0);
    expect(readFileSync(join(s.plugin, "data/quotes.tsv"), "utf8")).toContain("# plugin update");

    expect((await pluginCli(["setup", "--quiet"])).code).toBe(0);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesBefore);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(join(s.plugin, "data/quotes.tsv"), "utf8")).not.toContain("Desk note");
    const listed = await pluginCli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("A custom sentence for the saver.");
    expect(listed.stdout).toContain("every 45s");

    expect((await pluginCli(["uninstall"])).code).toBe(0);
    expect(readFileSync(quotesPath, "utf8")).toBe(quotesBefore);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
    // Removal deletes the plugin tree. Purge still runs from any checkout and drops user data.
    expect((await s.cli(["uninstall", "--purge"])).code).toBe(0);
    expect(existsSync(quotesPath)).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  } finally { s.cleanup(); }
}, 20000);

test("adding a quote leaves cleared custom lines unchecked", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  const cleared = "marcus\tOne\tCleared alpha line stays off.\nmarcus\tTwo\tCleared beta line stays off.\n";
  try {
    s.put(quotesPath, cleared);
    s.put(settingsPath, JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01", "c00"] } }));
    const added = await s.cli(["config", "--add", "marcus\tThree\tFresh gamma line joins rotation."]);
    expect(added.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      quotes: { marcus: ["q01", "c03"] },
    });
    const listed = await s.cli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("* q01  marcus");
    expect(listed.stdout).toContain("* c03  marcus  Three  Fresh gamma line joins rotation.");
    expect(listed.stdout).toContain("  c01  marcus  One  Cleared alpha line stays off.");
    expect(listed.stdout).toContain("  c02  marcus  Two  Cleared beta line stays off.");
    expect(listed.stdout).not.toContain("* c01");
    expect(listed.stdout).not.toContain("* c02");
    const pool = await s.cli(["status"]);
    expect(pool.code).toBe(0);
    expect(pool.stdout).toContain("2 quotes:");
    expect(pool.stdout).toMatch(/Marcus Aurelius\s+2\s+portrait/);
    // `show` does not record recent picks, so each canvas is an independent draw.
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).not.toContain("Cleared alpha line stays off.");
      expect(shown.stdout).not.toContain("Cleared beta line stays off.");
      if (shown.stdout.includes("Fresh gamma line joins rotation.")) seen.add("new");
      if (shown.stdout.includes("every act of thy life")) seen.add("q01");
    }
    expect([...seen].sort()).toEqual(["new", "q01"]);

    s.put(settingsPath, JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01", "c01"] } }));
    s.put(quotesPath, cleared);
    const explicit = await s.cli(["config", "--add", "marcus\tThree\tFresh gamma line joins rotation."]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).quotes.marcus).toEqual(["q01", "c01", "c03"]);
    const omitted = await s.cli(["config", "--list"]);
    expect(omitted.stdout).toContain("* c01  marcus");
    expect(omitted.stdout).toContain("* c03  marcus");
    expect(omitted.stdout).not.toContain("* c02");

    s.put(settingsPath, JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01"] } }));
    s.put(quotesPath, "marcus\tOne\tCleared alpha line stays off.\n");
    const bundledOnly = await s.cli(["config", "--add", "marcus\tTwo\tFresh gamma line joins rotation."]);
    expect(bundledOnly.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).quotes.marcus).toEqual(["q01", "c01", "c02"]);
  } finally { s.cleanup(); }
});

test("the quote wizard keeps a cleared custom selection when a line is added", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  try {
    s.put(join(s.config, "omastoic/quotes.tsv"), "marcus\tOne\tCleared alpha line stays off.\nmarcus\tTwo\tCleared beta line stays off.\n");
    s.put(settingsPath, JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01", "c00"] } }));
    const configured = await configPty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: "\r" },
      { marker: SHOWS.interval, keys: "\x1530\r" },
      { marker: SHOWS.confirm, keys: "y" },
      { marker: SHOWS.author, keys: "\x15marcus\r" },
      { marker: SHOWS.citation, keys: "\x15Three\r" },
      { marker: SHOWS.text, keys: "\x15Fresh gamma line joins rotation.\x04" },
    ]);
    expect(configured.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: ["q01", "c03"] },
    });
    const listed = await s.cli(["config", "--list"]);
    expect(listed.stdout).toContain("* c03  marcus  Three  Fresh gamma line joins rotation.");
    expect(listed.stdout).not.toContain("* c01");
    expect(listed.stdout).not.toContain("* c02");
  } finally { s.cleanup(); }
});

test("a missing or unreadable custom id keeps the other allow-list entries", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  try {
    s.put(quotesPath, "marcus\tKept\tThis cleared line stays off.\n");
    s.put(settingsPath, JSON.stringify({
      authors: ["marcus"],
      quotes: { marcus: ["q01", "c02"], seneca: ["q19"] },
    }));
    const dropped = await s.cli(["config", "--interval", "30"]);
    expect(dropped.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: ["q01", "c00"], seneca: ["q19"] },
    });
    const listed = await s.cli(["config", "--list"]);
    expect(listed.stdout).toContain("* q01  marcus");
    expect(listed.stdout).toContain("  c01  marcus  Kept  This cleared line stays off.");
    expect(listed.stdout).not.toContain("* c01");
    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("every act of thy life");
    expect(shown.stdout).not.toContain("This cleared line stays off.");

    s.put(quotesPath, "Marcus Aurelius\tDesk\tLine\n");
    s.put(settingsPath, JSON.stringify({
      quotes: { marcus: ["q01", "c01"], seneca: ["q19"] },
    }));
    const unreadable = await s.cli(["config", "--interval", "15", "--quotes", "seneca=q20"]);
    expect(unreadable.code).toBe(0);
    expect(readFileSync(quotesPath, "utf8")).toBe("Marcus Aurelius\tDesk\tLine\n");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      interval: 15,
      quotes: { marcus: ["q01", "c01"], seneca: ["q20"] },
    });

    const rebuilt = await s.cli(["config", "--quotes", "marcus=q02"]);
    expect(rebuilt.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      interval: 15,
      quotes: { marcus: ["q02", "c01"], seneca: ["q20"] },
    });
    const listedAgain = await s.cli(["config", "--list"]);
    expect(listedAgain.code).toBe(0);
    expect(listedAgain.stderr).toContain("invalid quote author slug");
    expect(listedAgain.stdout).toContain("* q02  marcus");
    expect(listedAgain.stdout).toContain("custom:\n  (none)");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).quotes).toEqual({ marcus: ["q02", "c01"], seneca: ["q20"] });
  } finally { s.cleanup(); }
});

test("a cleared custom line stays out of rotation when the Stoic pool is empty", async () => {
  const s = sandbox();
  const line = "Cleared marcus line stays off.";
  try {
    s.put(join(s.config, "omastoic/quotes.tsv"), `marcus\tMine\t${line}\n`);
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["c00"] } }));
    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).not.toContain(line);
    expect(shown.stderr).toContain("config authors matched no quotes; using the whole book");

    const stoics = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({
      quotes: Object.fromEntries(stoics.map((slug) => [slug, slug === "marcus" ? ["c00"] : []])),
    }));
    const empty = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).not.toContain(line);
    expect(empty.stderr).toContain("config quotes matched no quotes; using the whole book");
  } finally { s.cleanup(); }
});

test("confirming config keeps stored custom ids when quotes.tsv cannot be parsed", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  try {
    s.put(quotesPath, "Marcus Aurelius\tDesk\tLine\n");
    s.put(settingsPath, JSON.stringify({ quotes: { marcus: ["c00"], seneca: ["q19"] } }));
    const configured = await configPty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: "\r" },
      { marker: SHOWS.interval, keys: "\x1530\r" },
      { marker: SHOWS.confirm, keys: "n" },
    ]);
    expect(configured.code).toBe(0);
    expect(readFileSync(quotesPath, "utf8")).toBe("Marcus Aurelius\tDesk\tLine\n");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: ["c00"], seneca: ["q19"] },
    });
  } finally { s.cleanup(); }
});

test("adjusting a quote whose citation contains a comma keeps it in rotation", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  const line = "Hello, Captain.";
  try {
    s.put(quotesPath, `marcus\tDesk, note\t${line}\n`);
    s.put(settingsPath, JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01", "q02"] } }));
    const configured = await configPty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: "\r" },
      { marker: SHOWS.interval, keys: "\x1530\r" },
      { marker: SHOWS.confirm, keys: "n" },
    ]);
    expect(configured.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: ["q01", "q02", "c01"] },
    });
    expect(readFileSync(quotesPath, "utf8")).toBe(`marcus\tDesk, note\t${line}\n`);
    const listed = await s.cli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`* c01  marcus  Desk, note  ${line}`);
    expect(listed.stdout).toContain("* q01  marcus");
    expect(listed.stdout).toContain("* q02  marcus");
    const pool = await s.cli(["status"]);
    expect(pool.code).toBe(0);
    expect(pool.stdout).toContain("3 quotes:");
    expect(pool.stdout).toMatch(/Marcus Aurelius\s+3\s+portrait/);
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
      expect(shown.code).toBe(0);
      if (shown.stdout.includes(line)) seen.add("custom");
      if (shown.stdout.includes("Meditations II.5")) seen.add("q01");
      if (shown.stdout.includes("Meditations IV.17")) seen.add("q02");
    }
    expect([...seen].sort()).toEqual(["custom", "q01", "q02"]);
  } finally { s.cleanup(); }
});
