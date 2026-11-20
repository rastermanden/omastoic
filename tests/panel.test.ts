import { test, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";
import { headerPortraitLayout } from "../src/portrait.ts";

type Sandbox = ReturnType<typeof sandbox>;

const settingsPath = (s: Sandbox) => join(s.config, "omastoic/config.json");
const quotesPath = (s: Sandbox) => join(s.config, "omastoic/quotes.tsv");
const saved = (s: Sandbox) => JSON.parse(readFileSync(settingsPath(s), "utf8"));
const stateOf = (result: { stdout: string }) => JSON.parse(result.stdout);

test("panel state reads the roster and defaults without writing anything", async () => {
  const s = sandbox();
  try {
    const result = await s.cli(["panel", "state"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const state = stateOf(result);
    expect(state.authors.map((author: { slug: string }) => author.slug)).toEqual([
      "marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus",
    ]);
    expect(state.authors[0].name).toBe("Marcus Aurelius");
    expect(state.authors[0].selected).toBe(true);
    expect(state.allAuthors).toBe(true);
    expect(state.settings).toEqual({});
    expect(state.summary).toContain("every 60s");
    expect(state.customQuotes).toBe(0);
    // A read-only bridge: no config, no state directory, no unit.
    expect(existsSync(settingsPath(s))).toBe(false);
    expect(existsSync(s.state)).toBe(false);
  } finally { s.cleanup(); }
});

test("panel apply writes exactly what config --authors/--interval writes", async () => {
  const viaPanel = sandbox();
  const viaFlags = sandbox();
  try {
    const applied = await viaPanel.cli(["panel", "apply", JSON.stringify({ interval: 90, authors: ["marcus", "seneca"] })]);
    expect(applied.code).toBe(0);
    expect(applied.stderr).toBe("");
    const state = stateOf(applied);
    expect(state.settings).toEqual({ interval: 90, authors: ["marcus", "seneca"] });
    expect(state.allAuthors).toBe(false);
    expect(state.authors.filter((author: { selected: boolean }) => author.selected).map((author: { slug: string }) => author.slug))
      .toEqual(["marcus", "seneca"]);
    expect(state.summary).toContain("every 90s");

    expect((await viaFlags.cli(["config", "--authors", "marcus,seneca", "--interval", "90"])).code).toBe(0);
    expect(readFileSync(settingsPath(viaPanel), "utf8")).toBe(readFileSync(settingsPath(viaFlags), "utf8"));
  } finally { viaPanel.cleanup(); viaFlags.cleanup(); }
});

test("panel apply with every Stoic keeps the default and drops the key", async () => {
  const s = sandbox();
  try {
    const all = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 60, authors: all })])).code).toBe(0);
    expect(saved(s)).toEqual({ interval: 60 });
    expect(stateOf(await s.cli(["panel", "state"])).allAuthors).toBe(true);
  } finally { s.cleanup(); }
});

test("panel apply rejects a bad interval or an unknown Stoic and keeps the file", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 30 })])).code).toBe(0);
    const before = readFileSync(settingsPath(s), "utf8");
    for (const payload of [{ interval: 0 }, { interval: 3601 }, { interval: 1.5 }, { interval: "sixty" }]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify(payload)]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("whole number of seconds from 1 to 3600");
    }
    for (const payload of [{ authors: ["plato"] }, { authors: "marcus" }, { authors: [1] }]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify(payload)]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("omastoic:");
    }
    for (const raw of ["not json", "[]", "null"]) {
      expect((await s.cli(["panel", "apply", raw])).stdout).not.toContain("{");
      expect((await s.cli(["panel", "apply", raw])).code).toBe(1);
    }
    expect(readFileSync(settingsPath(s), "utf8")).toBe(before);
  } finally { s.cleanup(); }
});

test("panel apply adds a custom quote and keeps it in rotation", async () => {
  const s = sandbox();
  try {
    const result = await s.cli(["panel", "apply", JSON.stringify({
      interval: 45,
      authors: ["marcus"],
      addQuote: { author: "marcus", citation: "Meditations IX.1", text: "The panel wrote this line." },
    })]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const state = stateOf(result);
    expect(state.customQuotes).toBe(1);
    expect(readFileSync(quotesPath(s), "utf8")).toContain("marcus\tMeditations IX.1\tThe panel wrote this line.");
    expect(saved(s)).toEqual({ interval: 45, authors: ["marcus"] });
    // The line is in rotation: `config --list` stars it, and show renders it.
    const listed = await s.cli(["config", "--list"]);
    expect(listed.stdout).toContain("c01");
    expect(listed.stdout).toContain("The panel wrote this line.");

    // An explicit custom selection gains the new id instead of dropping it.
    s.put(settingsPath(s), JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01", "c01"] } }));
    expect((await s.cli(["panel", "apply", JSON.stringify({
      addQuote: { author: "marcus", citation: "Meditations IX.2", text: "A second line." },
    })])).code).toBe(0);
    expect(saved(s).quotes.marcus).toEqual(["q01", "c01", "c02"]);
  } finally { s.cleanup(); }
});

test("panel apply refuses an incomplete or duplicate quote and leaves the file alone", async () => {
  const s = sandbox();
  try {
    for (const addQuote of [{ author: "marcus", citation: "Meditations IX.1" }, { author: "marcus", citation: "", text: "x" }, "marcus"]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify({ addQuote })]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("omastoic:");
    }
    expect(existsSync(quotesPath(s))).toBe(false);

    const line = { author: "marcus", citation: "Meditations IX.1", text: "Only once." };
    expect((await s.cli(["panel", "apply", JSON.stringify({ addQuote: line })])).code).toBe(0);
    const duplicate = await s.cli(["panel", "apply", JSON.stringify({ addQuote: line })]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already in");
  } finally { s.cleanup(); }
});

test("panel apply reads the same JSON from stdin", async () => {
  const s = sandbox();
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "panel", "apply"], {
      cwd: join(import.meta.dir, ".."),
      env: s.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ interval: 15, authors: ["zeno"] }));
    child.stdin.end();
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).settings).toEqual({ interval: 15, authors: ["zeno"] });
    expect(saved(s)).toEqual({ interval: 15, authors: ["zeno"] });
  } finally { s.cleanup(); }
});

test("panel state includes a cited sample, the backend, and no writes", async () => {
  const s = sandbox();
  try {
    const state = stateOf(await s.cli(["panel", "state"]));
    expect(state.samples).toHaveLength(6);
    expect(state.samples[0].slug).toBe("marcus");
    expect(state.samples[0].citation).toBe("Meditations VII.22");
    expect(state.samples[0].text).toBe("It is peculiar to man to love even those who do wrong.");
    expect(state.samples[0].text).not.toContain("…");
    expect(state.samples[0].portrait).toMatch(/\S/);
    const grid = (art: string) => {
      const lines = art.split("\n");
      return { rows: lines.length, cols: Math.max(...lines.map((line) => [...line].length)) };
    };
    const layout = headerPortraitLayout();
    const marcus = state.samples.find((sample: { slug: string }) => sample.slug === "marcus");
    const seneca = state.samples.find((sample: { slug: string }) => sample.slug === "seneca");
    expect(layout.fontPx).toBe(8);
    expect(layout.cellWidth).toBeGreaterThanOrEqual(5);
    expect(layout.dotPitch).toBeCloseTo(layout.cellWidth / 2);
    expect(layout.dotPitch).toBeCloseTo(layout.cellHeight / 4);
    expect(layout.dotPitch).toBeGreaterThanOrEqual(2);
    expect(layout.width).toBeGreaterThanOrEqual(80);
    expect(layout.width).toBeLessThanOrEqual(96);
    expect(layout.height).toBeGreaterThanOrEqual(80);
    expect(layout.height).toBeLessThanOrEqual(96);
    expect(state.portraitFont).toBe(layout.fontPx);
    expect(state.portraitLine).toBe(layout.cellHeight);
    expect(state.portraitWidth).toBe(layout.width);
    expect(state.portraitHeight).toBe(layout.height);
    expect(grid(marcus.portrait)).toEqual({ rows: layout.rows, cols: layout.cols });
    expect(grid(seneca.portrait)).toEqual({ rows: layout.rows, cols: layout.cols });
    expect(marcus.portrait).not.toBe(seneca.portrait);
    expect(["native", "terminal", "missing"]).toContain(state.backend);
    expect(typeof state.intervalApplied).toBe("boolean");
    expect(state.custom).toEqual([]);
  } finally { s.cleanup(); }
});

test("preview --quote writes that same line", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "art before the Stoics\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const sample = stateOf(await s.cli(["panel", "state"])).samples[0];
    const shown = await s.cli(["preview", "--quote", sample.id]);
    expect(shown.code).toBe(0);
    expect(readFileSync(branding, "utf8")).toContain(sample.citation);
    expect(readFileSync(branding, "utf8")).toContain("love even those who do");
    const missing = await s.cli(["preview", "--quote", "q99"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not in the book");
  } finally { s.cleanup(); }
});

test("panel apply leaves the daemon alone when nothing changed", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "my art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["on"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120, authors: ["marcus"] })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120, authors: ["marcus"] })])).code).toBe(0);
    expect(s.log()).not.toContain("restart");
    expect(saved(s)).toEqual({ interval: 120, authors: ["marcus"] });
  } finally { s.cleanup(); }
});

test("panel apply removes one custom quote and refuses a bundled id", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["panel", "apply", JSON.stringify({
      addQuote: { author: "marcus", citation: "Meditations IX.1", text: "First added line." },
    })])).code).toBe(0);
    expect((await s.cli(["panel", "apply", JSON.stringify({
      addQuote: { author: "seneca", citation: "Letters 1.1", text: "Second added line." },
    })])).code).toBe(0);
    const bundled = await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "q01" })]);
    expect(bundled.code).toBe(1);
    expect(bundled.stderr).toContain("Only a quote you added");
    expect(readFileSync(quotesPath(s), "utf8")).toContain("Second added line.");

    const removed = await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "c01" })]);
    expect(removed.code).toBe(0);
    const state = stateOf(removed);
    expect(state.custom.map((quote: { text: string }) => quote.text)).toEqual(["Second added line."]);
    expect(state.custom[0].id).toBe("c01");
    expect(readFileSync(quotesPath(s), "utf8")).not.toContain("First added line.");
    const unknown = await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "c09" })]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("not one of yours");
  } finally { s.cleanup(); }
});

test("panel apply restarts an enabled rotation service", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "my art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["on"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120 })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
    s.put(join(s.home, "systemctl.log"), "");
    // `panel state` is a read: it must never restart anything.
    expect((await s.cli(["panel", "state"])).code).toBe(0);
    expect(s.log()).not.toContain("restart");
  } finally { s.cleanup(); }
});

test("omastoic ui toggles the panel through the running shell", async () => {
  const s = sandbox();
  s.stub("omarchy-shell", 'echo "$*" >> "$HOME/shell.log"');
  try {
    expect((await s.cli(["ui"])).code).toBe(0);
    expect(readFileSync(join(s.home, "shell.log"), "utf8").trim()).toBe("shell toggle io.github.rastermanden.omastoic");
    s.stub("omarchy-shell", "exit 1");
    const failed = await s.cli(["ui"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("is omarchy-shell running?");

    rmSync(join(s.bin, "omarchy-shell"));
    const missing = await s.cli(["ui"], { PATH: s.bin });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("is omarchy-shell running?");
    expect(missing.stderr).not.toContain("Executable not found");
  } finally { s.cleanup(); }
});
