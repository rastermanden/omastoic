import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

const ptyScript = [
  "import os, pty, select, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
  "buf = b''",
  "while True:",
  "    ready, _, _ = select.select([fd], [], [], 3)",
  "    if not ready:",
  "        os.kill(pid, 15)",
  "        sys.stderr.write('timed out waiting for config')",
  "        raise SystemExit(1)",
  "    try:",
  "        chunk = os.read(fd, 4096)",
  "    except OSError:",
  "        break",
  "    if not chunk:",
  "        break",
  "    buf += chunk",
  "_, status = os.waitpid(pid, 0)",
  "sys.stdout.buffer.write(buf)",
  "raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)",
].join("\n");

function pty(s: ReturnType<typeof sandbox>, args: string[], extra: Record<string, string> = {}) {
  return s.exec(["/usr/bin/python3", "-c", ptyScript, process.execPath, join(root, "src/cli.ts"), ...args], extra);
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
    expect(limited.stdout).toContain("1 of 18 quotes");
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
    expect(book.stdout).toContain("65 quotes:");
  } finally { s.cleanup(); }
});

test("a bad quote field is ignored and an empty bundled list can fall back", async () => {
  const s = sandbox();
  try {
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 12, quotes: { marcus: ["nope"] } }));
    const kept = await s.cli(["status"]);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain("64 quotes:");
    expect(kept.stdout).toContain("every 12s");
    expect(kept.stderr).not.toContain("ignoring unreadable");

    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({
      quotes: { marcus: [], seneca: [], epictetus: [], zeno: [], cleanthes: [], chrysippus: [] },
    }));
    const fellBack = await s.cli(["status"]);
    expect(fellBack.code).toBe(0);
    expect(fellBack.stderr).toContain("config quotes matched no quotes");
    expect(fellBack.stdout).toContain("64 quotes:");
    expect(fellBack.stdout).toContain("0 of 64 quotes");
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
    expect(narrowed.stdout).toContain("0 of 18 quotes");
    expect(narrowed.stderr).toContain("config authors matched no quotes; using the whole book");
    const whole = await s.cli(["status"]);
    expect(whole.stdout).toContain("64 quotes:");
    expect(whole.stderr).toContain("config authors matched no quotes; using the whole book");

    const stoics = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];
    const selected = await s.cli(["config", "--authors", "marcus", ...stoics.flatMap((slug) => ["--quotes", `${slug}=none`])]);
    expect(selected.code).toBe(0);
    expect(selected.stdout).toContain("0 of 18 quotes");
    expect(selected.stderr).toContain("quote selection was ignored; using the selected Stoics' lines");
    expect(selected.stderr).not.toContain("using the whole book");
    const kept = await s.cli(["status"]);
    expect(kept.stdout).toContain("18 quotes:");
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

    symlinkSync("/usr/bin/flock", join(s.bin, "flock"));
    symlinkSync("/bin/sh", join(s.bin, "sh"));
    const terminal = await pty(s, ["config", "--add"], { PATH: s.bin });
    expect(terminal.code).toBe(1);
    expect(terminal.stdout + terminal.stderr).toContain("gum is missing");
    expect(terminal.stdout + terminal.stderr).toContain("marcus");
    expect(terminal.stdout + terminal.stderr).not.toContain("Author slug");
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);
  } finally { s.cleanup(); }
});

test("config --add prompts for author, citation and text", async () => {
  const s = sandbox();
  try {
    s.stub("gum", [
      "printf '%s\\n' \"$*\" >> \"$HOME/gum.log\"",
      "case \"$1\" in",
      "  input)",
      "    case \"$*\" in",
      "      *Author*) echo marcus ;;",
      "      *Citation*) printf '%s\\n' $'Desk note\\nwith a tab\\there' ;;",
      "      *) echo \"unexpected input: $*\" >&2; exit 1 ;;",
      "    esac",
      "    ;;",
      "  write)",
      "    printf '%s\\n' 'A custom sentence' 'for the saver.'",
      "    ;;",
      "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const added = await pty(s, ["config", "--add"]);
    expect(added.code).toBe(0);
    const saved = readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8");
    expect(saved).toBe("# author-slug <TAB> citation <TAB> text\nmarcus\tDesk note with a tab here\tA custom sentence for the saver.\n");
    expect(saved).not.toContain("\t\t");
    expect(readFileSync(join(s.home, "gum.log"), "utf8")).toContain("Author slug");
    const again = await pty(s, ["config", "--add"]);
    expect(again.code).toBe(1);
    expect(again.stdout + again.stderr).toContain("already in");
  } finally { s.cleanup(); }
});

test("cancelling the add prompt writes nothing, and a bad slug is rejected", async () => {
  const s = sandbox();
  try {
    s.stub("gum", [
      "case \"$1\" in",
      "  input) exit 1 ;;",
      "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const cancelled = await pty(s, ["config", "--add"]);
    expect(cancelled.code).toBe(0);
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);

    s.stub("gum", [
      "case \"$1\" in",
      "  input)",
      "    case \"$*\" in",
      "      *Author*) echo 'Marcus Aurelius' ;;",
      "      *) echo 'Desk note' ;;",
      "    esac",
      "    ;;",
      "  write) echo 'A custom sentence for the saver.' ;;",
      "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const rejected = await pty(s, ["config", "--add"]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("invalid quote author slug");
    expect(existsSync(join(s.config, "omastoic/quotes.tsv"))).toBe(false);
  } finally { s.cleanup(); }
});

test("omastoic config offers a gum quote after the Stoic prompts", async () => {
  const s = sandbox();
  try {
    s.stub("gum", [
      "printf '%s\\n' \"$*\" >> \"$HOME/gum.log\"",
      "case \"$1\" in",
      "  choose)",
      "    case \"$*\" in",
      "      *Stoics*) echo 'Marcus Aurelius' ;;",
      "    esac",
      "    ;;",
      "  input)",
      "    case \"$*\" in",
      "      *Seconds*) echo 30 ;;",
      "      *Author*) echo marcus ;;",
      "      *Citation*) echo 'Desk note' ;;",
      "      *) echo \"unexpected input: $*\" >&2; exit 1 ;;",
      "    esac",
      "    ;;",
      "  write) echo 'A custom sentence for the saver.' ;;",
      "  confirm) exit 0 ;;",
      "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const configured = await pty(s, ["config"]);
    expect(configured.code).toBe(0);
    expect(readFileSync(join(s.home, "gum.log"), "utf8")).toContain("Add a custom quote?");
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: [] },
    });
    expect(readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8")).toContain("marcus\tDesk note\tA custom sentence for the saver.\n");
  } finally { s.cleanup(); }
});

test("accepted settings survive a cancelled or invalid optional quote", async () => {
  const s = sandbox();
  const settingsPath = join(s.config, "omastoic/config.json");
  const quotesPath = join(s.config, "omastoic/quotes.tsv");
  const wizard = (confirm: string, author: string) => [
    "case \"$1\" in",
    "  choose)",
    "    case \"$*\" in",
    "      *Stoics*) echo 'Marcus Aurelius' ;;",
    "    esac",
    "    ;;",
    "  input)",
    "    case \"$*\" in",
    "      *Seconds*) echo 30 ;;",
    author,
    "    esac",
    "    ;;",
    `  confirm) ${confirm} ;;`,
    "  write) echo 'A custom sentence for the saver.' ;;",
    "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
    "esac",
  ].join("\n");
  try {
    s.stub("gum", wizard("exit 0", "      *) exit 1 ;;"));
    const escaped = await pty(s, ["config"]);
    expect(escaped.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: [] },
    });
    expect(existsSync(quotesPath)).toBe(false);

    rmSync(settingsPath);
    s.stub("gum", wizard("exit 0", "      *Author*) echo 'Marcus Aurelius' ;;\n      *) echo 'Desk note' ;;"));
    const rejected = await pty(s, ["config"]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain("invalid quote author slug");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      authors: ["marcus"],
      interval: 30,
      quotes: { marcus: [] },
    });
    expect(existsSync(quotesPath)).toBe(false);

    rmSync(settingsPath);
    s.stub("gum", wizard("exit 130", "      *) echo 'should not ask' >&2; exit 1 ;;"));
    const aborted = await pty(s, ["config"]);
    expect(aborted.code).toBe(0);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(quotesPath)).toBe(false);

    s.stub("gum", [
      "case \"$1\" in",
      "  input) exit 1 ;;",
      "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const flagged = await pty(s, ["config", "--authors", "seneca", "--interval", "30", "--add"]);
    expect(flagged.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ authors: ["seneca"], interval: 30 });
    expect(existsSync(quotesPath)).toBe(false);

    s.stub("gum", [
      "case \"$1\" in",
      "  input)",
      "    case \"$*\" in",
      "      *Author*) echo 'Marcus Aurelius' ;;",
      "      *) echo 'Desk note' ;;",
      "    esac",
      "    ;;",
      "  write) echo 'A custom sentence for the saver.' ;;",
      "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const flaggedBad = await pty(s, ["config", "--interval", "45", "--add"]);
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
