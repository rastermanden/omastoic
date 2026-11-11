import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";

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
    expect(state.myAuthors).toEqual([]);
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

test("author add and remove keep your own authors, portraits included", async () => {
  const s = sandbox();
  try {
    const registry = join(s.config, "omastoic/authors.tsv");
    expect((await s.cli(["panel", "state"])).code).toBe(0);
    // Reading the panel never writes the registry.
    expect(existsSync(registry)).toBe(false);

    const added = await s.cli(["author", "add", "Tomas", "Sowell", "--dates", "b. 1932"]);
    expect(added.code).toBe(0);
    expect(readFileSync(registry, "utf8")).toContain("tomas-sowell\tTomas Sowell\tb. 1932");
    expect((await s.cli(["author", "list"])).stdout).toContain("Tomas Sowell (tomas-sowell) · b. 1932  0 quotes, no portrait");

    // A quote attaches to the author, shows their name, and blocks removal.
    const quote = await s.cli(["panel", "apply", JSON.stringify({ addQuote: { author: "tomas-sowell", citation: "Basic Economics", text: "Trade-offs." } })]);
    expect(quote.code).toBe(0);
    expect(stateOf(quote).quotes.find((row: { custom: boolean }) => row.custom).name).toBe("Tomas Sowell");
    const refused = await s.cli(["author", "remove", "Tomas Sowell"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("still has 1 quote");

    // The six Stoics are already there, and cannot be duplicated.
    expect((await s.cli(["author", "add", "Marcus Aurelius"])).code).toBe(1);

    // Deleting the quote lets the author go, portrait and all.
    const art = join(s.config, "omastoic/art/tomas-sowell.txt");
    mkdirSync(join(s.config, "omastoic/art"), { recursive: true });
    writeFileSync(art, "x\n");
    expect((await s.cli(["panel", "apply", JSON.stringify({ deleteQuote: { id: "c01" } })])).code).toBe(0);
    expect((await s.cli(["author", "remove", "tomas-sowell"])).code).toBe(0);
    expect(existsSync(art)).toBe(false);
    expect(readFileSync(registry, "utf8")).not.toContain("tomas-sowell");
  } finally { s.cleanup(); }
});

test("a quote by an author you never listed registers them by name", async () => {
  const s = sandbox();
  try {
    const result = await s.cli(["panel", "apply", JSON.stringify({ addQuote: { author: "aldous-huxley", citation: "Brave New World", text: "Words." } })]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8")).toContain("aldous-huxley\tAldous Huxley");
    expect(stateOf(result).myAuthors).toEqual([{ slug: "aldous-huxley", name: "Aldous Huxley", dates: "", portrait: false, quotes: 1 }]);
    // The Stoics need no row of their own.
    await s.cli(["panel", "apply", JSON.stringify({ addQuote: { author: "seneca", citation: "Letters 1", text: "Time." } })]);
    expect(readFileSync(join(s.config, "omastoic/authors.tsv"), "utf8")).not.toContain("seneca\t");
  } finally { s.cleanup(); }
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

test("panel apply adds an author first, then attaches quotes to them", async () => {
  const s = sandbox();
  try {
    const registry = join(s.config, "omastoic/authors.tsv");
    const added = await s.cli(["panel", "apply", JSON.stringify({ addAuthor: { slug: "tomas-sowell", name: "Tomas Sowell", dates: "b. 1932" } })]);
    expect(added.code).toBe(0);
    expect(readFileSync(registry, "utf8")).toContain("tomas-sowell\tTomas Sowell\tb. 1932");
    expect(stateOf(added).myAuthors).toEqual([{ slug: "tomas-sowell", name: "Tomas Sowell", dates: "b. 1932", portrait: false, quotes: 0 }]);

    const quote = await s.cli(["panel", "apply", JSON.stringify({ addQuote: { author: "tomas-sowell", citation: "Basic Economics", text: "Trade-offs." } })]);
    expect(quote.code).toBe(0);
    expect(stateOf(quote).myAuthors[0].quotes).toBe(1);

    for (const payload of [
      { addAuthor: { slug: "marcus", name: "Marcus Aurelius" } },
      { addAuthor: { slug: "Tomas Sowell", name: "Tomas Sowell" } },
      { addAuthor: { slug: "tomas-sowell", name: " " } },
      { addAuthor: { name: "No Slug" } },
      { removeAuthor: { slug: "tomas-sowell" } },
      { removeAuthor: { slug: "nobody" } },
    ]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify(payload)]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("omastoic:");
    }
    expect(readFileSync(registry, "utf8")).toContain("tomas-sowell");

    // With no quotes left, the author can go.
    expect((await s.cli(["panel", "apply", JSON.stringify({ deleteQuote: { id: "c01" } })])).code).toBe(0);
    const removed = await s.cli(["panel", "apply", JSON.stringify({ removeAuthor: { slug: "tomas-sowell" } })]);
    expect(removed.code).toBe(0);
    expect(stateOf(removed).myAuthors).toEqual([]);
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
    const mine = state.quotes.filter((quote: { custom: boolean }) => quote.custom);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "c01", author: "marcus", citation: "Meditations IX.1", inRotation: true });
    expect(state.quotes.length).toBeGreaterThan(1);
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

test("panel apply switches single quotes off and on, like config --quotes", async () => {
  const s = sandbox();
  try {
    const off = await s.cli(["panel", "apply", JSON.stringify({ keep: { q02: false } })]);
    expect(off.code).toBe(0);
    const row = stateOf(off).quotes.find((quote: { id: string }) => quote.id === "q02");
    expect(row).toMatchObject({ author: "marcus", kept: false, inRotation: false, switchable: true });
    const marcus = (saved(s).quotes as Record<string, string[]>).marcus;
    expect(marcus).not.toContain("q02");
    expect(marcus).toContain("q01");

    const config = sandbox();
    try {
      await config.cli(["config", "--quotes", `marcus=${marcus.join(",")}`]);
      expect(saved(s)).toEqual(saved(config));
    } finally { config.cleanup(); }

    const on = await s.cli(["panel", "apply", JSON.stringify({ keep: { q02: true } })]);
    expect(on.code).toBe(0);
    expect(saved(s).quotes).toBeUndefined();

    const before = readFileSync(settingsPath(s), "utf8");
    for (const keep of [{ zz: false }, { q02: "off" }, ["q02"]]) {
      expect((await s.cli(["panel", "apply", JSON.stringify({ keep })])).code).toBe(1);
    }
    expect(readFileSync(settingsPath(s), "utf8")).toBe(before);
  } finally { s.cleanup(); }
});

test("panel apply saves mine only, and picking Stoics again clears it", async () => {
  const s = sandbox();
  try {
    await s.cli(["panel", "apply", JSON.stringify({ addQuote: { author: "tomas-sowell", citation: "Basic Economics", text: "Trade-offs." } })]);
    const only = await s.cli(["panel", "apply", JSON.stringify({ mineOnly: true })]);
    expect(only.code).toBe(0);
    const state = stateOf(only);
    expect(state.mineOnly).toBe(true);
    expect(state.authors.every((author: { selected: boolean }) => !author.selected)).toBe(true);
    expect(state.quotes.filter((quote: { inRotation: boolean }) => quote.inRotation).map((quote: { custom: boolean }) => quote.custom)).toEqual([true]);
    expect(saved(s).mineOnly).toBe(true);

    const back = await s.cli(["panel", "apply", JSON.stringify({ authors: ["seneca"], mineOnly: false })]);
    expect(stateOf(back).mineOnly).toBe(false);
    expect(saved(s).mineOnly).toBeUndefined();
    // Your own quote keeps rotating beside the Stoic you picked.
    expect(stateOf(back).quotes.find((quote: { custom: boolean }) => quote.custom).inRotation).toBe(true);
    expect((await s.cli(["panel", "apply", JSON.stringify({ mineOnly: "yes" })])).code).toBe(1);
  } finally { s.cleanup(); }
});

test("panel apply edits and deletes your quotes, keeping comments and picks", async () => {
  const s = sandbox();
  try {
    const file = quotesPath(s);
    mkdirSync(join(s.config, "omastoic"), { recursive: true });
    writeFileSync(file, "# mine\nmarcus\tA\tone\nseneca\tB\ttwo\n# note\nmarcus\tC\tthree\n");
    writeFileSync(settingsPath(s), JSON.stringify({ quotes: { marcus: ["q01", "c01", "c03"] } }));

    const edited = await s.cli(["panel", "apply", JSON.stringify({ editQuote: { id: "c02", author: "seneca", citation: "B2", text: "two, edited" } })]);
    expect(edited.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# mine\nmarcus\tA\tone\nseneca\tB2\ttwo, edited\n# note\nmarcus\tC\tthree\n");

    const deleted = await s.cli(["panel", "apply", JSON.stringify({ deleteQuote: { id: "c01" } })]);
    expect(deleted.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# mine\nseneca\tB2\ttwo, edited\n# note\nmarcus\tC\tthree\n");
    // Marcus kept c03 ("three"); it is c02 now, and still kept.
    expect(saved(s).quotes.marcus).toEqual(["q01", "c02"]);
    const three = stateOf(deleted).quotes.find((quote: { text: string }) => quote.text === "three");
    expect(three).toMatchObject({ id: "c02", kept: true });

    const before = readFileSync(file, "utf8");
    for (const payload of [
      { deleteQuote: { id: "c09" } },
      { deleteQuote: { id: "q01" } },
      { editQuote: { id: "c01", author: "marcus", citation: "", text: "x" } },
      { editQuote: { id: "c01", author: "marcus", citation: "C", text: "three" } },
    ]) {
      expect((await s.cli(["panel", "apply", JSON.stringify(payload)])).code).toBe(1);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
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
