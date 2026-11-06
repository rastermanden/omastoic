import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

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

    s.put(join(s.config, "omastoic/quotes.tsv"), "marcus\tDesk note\tA custom sentence for the saver.\n");
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({
      authors: ["marcus"],
      quotes: Object.fromEntries(stoics.map((slug) => [slug, []])),
      addedOff: { marcus: ["a01"] },
    }));
    const customStatus = await s.cli(["status"]);
    expect(customStatus.code).toBe(0);
    expect(customStatus.stdout).toContain("19 quotes:");
    expect(customStatus.stdout).toContain("Marcus Aurelius");
    expect(customStatus.stdout).not.toContain("Seneca");
    expect(customStatus.stderr).toContain("quote selection was ignored; using the selected Stoics' lines");
    expect(customStatus.stderr).not.toContain("using the whole book");
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

test("config --add without a value is a usage error", async () => {
  const s = sandbox();
  try {
    const missing = await s.cli(["config", "--add"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--add expects one author, citation and text");

    const terminal = await s.exec([
      "python3",
      "-c",
      [
        "import os, pty, select, sys",
        "pid, fd = pty.fork()",
        "if pid == 0:",
        "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
        "buf = b''",
        "while True:",
        "    ready, _, _ = select.select([fd], [], [], 3)",
        "    if not ready:",
        "        os.kill(pid, 15)",
        "        sys.stderr.write('timed out waiting for --add')",
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
      ].join("\n"),
      process.execPath,
      join(root, "src/cli.ts"),
      "config",
      "--add",
    ]);
    expect(terminal.code).toBe(1);
    expect(terminal.stdout + terminal.stderr).toContain("--add expects one author, citation and text");
    expect(terminal.stdout + terminal.stderr).not.toContain("gum is missing");
    expect(terminal.stdout + terminal.stderr).not.toContain("Author slug");
  } finally { s.cleanup(); }
});
