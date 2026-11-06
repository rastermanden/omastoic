import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexAdded, indexBundled, parseQuotes } from "../src/canvas.ts";
import { CHECKED, UNCHECKED, checkboxLabel, idsFromCheckboxOutput, quoteCheckboxArgs, stoicGroups } from "../src/quote-picker.ts";
import { root, sandbox } from "./sandbox.ts";

const roster = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];

test("a checkbox label keeps a long quote whole", () => {
  const text = "A sentence long enough that a forty-eight character cut would drop the ending of the line.";
  const quote = { id: "q99", citation: "Meditations XII.1", text };
  const label = checkboxLabel(quote);
  expect(label).toBe(`q99  Meditations XII.1  ${text}`);
  expect(label.endsWith("…")).toBe(false);
  expect(label).toContain(text);
  const wrapped = checkboxLabel(quote, 48);
  expect(wrapped.includes("…")).toBe(false);
  expect(wrapped.split("\n").length).toBeGreaterThan(1);
  const pad = " ".repeat(Bun.stringWidth("q99  Meditations XII.1  "));
  const joined = wrapped.split("\n").map((line, index) => index === 0 ? line.slice("q99  Meditations XII.1  ".length) : line.slice(pad.length)).join(" ");
  expect(joined).toBe(text);
  expect(wrapped.split("\n").every((line) => Bun.stringWidth(line) <= 48)).toBe(true);
  const byLabel = new Map([[wrapped, "q99"]]);
  expect(idsFromCheckboxOutput(`${wrapped}\x1e`, byLabel)).toEqual(["q99"]);
});

test("quote checkboxes are grouped by Stoic and cover bundled and added lines", () => {
  const rows = [
    { label: checkboxLabel({ id: "q01", citation: "Meditations II.5", text: "And thou wilt give thyself relief." }), on: true },
    { label: checkboxLabel({ id: "q02", citation: "On Anger, II.29", text: "The greatest remedy for anger is delay." }), on: true },
    { label: checkboxLabel({ id: "a01", citation: "Desk note", text: "A custom sentence for the saver." }), on: false },
  ];
  const args = quoteCheckboxArgs("Marcus Aurelius", rows);
  expect(args.slice(0, 2)).toEqual(["choose", "--no-limit"]);
  expect(args).toContain("--selected-prefix");
  expect(args).toContain(CHECKED);
  expect(args).toContain("--unselected-prefix");
  expect(args).toContain(UNCHECKED);
  expect(args).toContain("--cursor-prefix");
  expect(args).toContain("Quotes from Marcus Aurelius  (x or tab to check, enter to confirm)");
  const selected = args.filter((arg, index) => args[index - 1] === "--selected");
  expect(selected).toEqual([
    rows[0].label,
    rows[1].label.replaceAll(",", "\\,"),
  ]);
  expect(args.slice(-3)).toEqual(rows.map((row) => row.label));
  expect(idsFromCheckboxOutput(`${rows[0].label}\n${rows[2].label}\n`, new Map(rows.map((row) => [row.label, row.label.slice(0, 3)])))).toEqual(["q01", "a01"]);
  expect(idsFromCheckboxOutput("", new Map())).toEqual([]);
  expect(stoicGroups(["marcus"], roster, ["plato"])).toEqual(["marcus"]);
  expect(stoicGroups([], roster, ["plato", "marcus"])).toEqual([...roster, "plato"]);
  expect(stoicGroups(roster, roster, ["plato"])).toEqual([...roster, "plato"]);
});

test("the config checkbox list turns bundled and added quotes on and off", async () => {
  const s = sandbox();
  try {
    const first = await s.cli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(first.code).toBe(0);
    const second = await s.cli(["config", "--add", "marcus\tDesk note 2\tA second custom line for the desk."]);
    expect(second.code).toBe(0);
    const bundled = indexBundled(parseQuotes(readFileSync(join(root, "data/quotes.tsv"), "utf8")));
    const q01 = bundled.find((quote) => quote.id === "q01");
    expect(q01).toBeDefined();
    const added = indexAdded([
      { author: "marcus", citation: "Desk note", text: "A custom sentence for the saver." },
      { author: "marcus", citation: "Desk note 2", text: "A second custom line for the desk." },
    ]);
    s.put(join(s.home, "author-reply.txt"), "Marcus Aurelius\n");
    s.put(join(s.home, "quote-reply.txt"), `${checkboxLabel(q01!)}\n${checkboxLabel(added[1])}\n`);
    s.stub("gum", [
      "printf '%s\\n' \"$@\" >> \"$HOME/gum.log\"",
      "printf '\\034\\n' >> \"$HOME/gum.log\"",
      "if [[ $1 == input ]]; then echo 45; exit 0; fi",
      "header=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [[ $prev == --header ]]; then header=$arg; fi",
      "  prev=$arg",
      "done",
      "case \"$header\" in",
      "  Stoics*) cat \"$HOME/author-reply.txt\" ;;",
      "  Quotes*) cat \"$HOME/quote-reply.txt\" ;;",
      "  *) echo \"unexpected gum header: $header\" >&2; exit 1 ;;",
      "esac",
    ].join("\n"));
    const terminal = await s.exec([
      "python3",
      "-c",
      [
        "import fcntl, os, pty, select, struct, sys, termios",
        "pid, fd = pty.fork()",
        "if pid == 0:",
        "    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 200, 0, 0))",
        "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
        "buf = b''",
        "while True:",
        "    ready, _, _ = select.select([fd], [], [], 8)",
        "    if not ready:",
        "        os.kill(pid, 15)",
        "        sys.stderr.write('timed out waiting for config checkboxes')",
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
    ]);
    expect(terminal.code).toBe(0);
    const log = readFileSync(join(s.home, "gum.log"), "utf8");
    expect(log).toContain("Quotes from Marcus Aurelius  (x or tab to check, enter to confirm)");
    expect(log).toContain("--selected-prefix");
    expect(log).toContain(CHECKED);
    expect(log).toContain("--unselected-prefix");
    expect(log).toContain(UNCHECKED);
    expect(log).toContain(checkboxLabel(added[0]));
    expect(log).toContain(checkboxLabel(q01!));
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved).toEqual({
      interval: 45,
      authors: ["marcus"],
      quotes: { marcus: ["q01"] },
      addedOff: { marcus: ["a01"] },
    });
    const listed = await s.cli(["config", "--list"]);
    expect(listed.stdout).toContain("* q01  marcus  Meditations II.5");
    expect(listed.stdout).toContain("  q02  marcus");
    expect(listed.stdout).toContain("  a01  marcus  Desk note  A custom sentence for the saver.");
    expect(listed.stdout).toContain("* a02  marcus  Desk note 2  A second custom line for the desk.");
    const canvases = [];
    for (let i = 0; i < 16; i++) canvases.push((await s.cli(["show", "--cols", "92", "--rows", "25"])).stdout);
    expect(canvases.some((canvas) => canvas.includes("every act of thy life"))).toBe(true);
    expect(canvases.some((canvas) => canvas.includes("A second custom line for the desk."))).toBe(true);
    expect(canvases.every((canvas) => !canvas.includes("A custom sentence for the saver."))).toBe(true);
    expect(canvases.every((canvas) => !canvas.includes("ten thousand years"))).toBe(true);
  } finally { s.cleanup(); }
});
