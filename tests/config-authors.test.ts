import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

const ptyScript = [
  "import binascii, os, pty, select, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
  "marker = binascii.unhexlify(os.environ.get('PTY_MARKER', ''))",
  "keys = binascii.unhexlify(os.environ.get('PTY_KEYS', ''))",
  "sent = not keys",
  "buf = b''",
  "while True:",
  "    ready, _, _ = select.select([fd], [], [], 5)",
  "    if not ready:",
  "        if not sent:",
  "            os.write(fd, keys)",
  "            sent = True",
  "            continue",
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
  "    if not sent and (not marker or marker in buf):",
  "        os.write(fd, keys)",
  "        sent = True",
  "_, status = os.waitpid(pid, 0)",
  "sys.stdout.buffer.write(buf)",
  "raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)",
].join("\n");

function pty(s: ReturnType<typeof sandbox>, args: string[], keys = "", marker = "space/x toggle") {
  const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
  return s.exec(["/usr/bin/python3", "-c", ptyScript, process.execPath, join(root, "src/cli.ts"), ...args], {
    PTY_KEYS: hex(keys),
    PTY_MARKER: hex(marker),
  });
}

const quoteStub = [
  "printf '%s\\n' \"$*\" >> \"$HOME/gum.log\"",
  "case \"$1\" in",
  "  choose)",
  "    case \"$*\" in",
  "      *\"Stoics on the screensaver\"*) echo 'the author picker must not shell out to gum' >&2; exit 1 ;;",
  "      *)",
  "        prev=",
  "        for arg in \"$@\"; do",
  "          if [[ \"$prev\" == --selected ]]; then printf '%s\\n' \"$arg\"; fi",
  "          prev=\"$arg\"",
  "        done",
  "        ;;",
  "    esac",
  "    ;;",
  "  input) echo 30 ;;",
  "  confirm) exit 1 ;;",
  "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
  "esac",
].join("\n");

test("the author picker runs in the terminal instead of spawning gum", async () => {
  const s = sandbox();
  try {
    s.stub("gum", quoteStub);
    const configured = await pty(s, ["config"], "n1\r");
    expect(configured.code).toBe(0);
    expect(configured.stdout).toContain("Stoics on the screensaver");
    expect(configured.stdout + configured.stderr).not.toContain("the author picker must not shell out to gum");
    const gum = readFileSync(join(s.home, "gum.log"), "utf8");
    expect(gum).not.toContain("Stoics on the screensaver");
    expect(gum).toContain("Seconds between quotes");
    expect(gum).toContain("Add a custom quote?");
    expect(gum).toContain("Quotes from Marcus Aurelius");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.authors).toEqual(["marcus"]);
    expect(saved.interval).toBe(30);
    expect(Object.keys(saved.quotes)).toEqual(["marcus"]);
  } finally { s.cleanup(); }
});

test("cancelling the author picker writes nothing", async () => {
  const s = sandbox();
  try {
    s.stub("gum", quoteStub);
    const cancelled = await pty(s, ["config"], "q");
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain("Stoics on the screensaver");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
    expect(existsSync(join(s.home, "gum.log"))).toBe(false);
  } finally { s.cleanup(); }
});

test("config --plain reads a numbered answer from a pipeline", async () => {
  const s = sandbox();
  try {
    s.stub("gum", quoteStub);
    const piped = await s.exec(["/bin/bash", "-c",
      `printf '%b' ${JSON.stringify("2\\n")} | '${process.execPath}' '${join(root, "src/cli.ts")}' config --plain`]);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toContain("Select Stoics");
    expect(piped.stdout).toContain("2 [x] Seneca");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.authors).toEqual(["seneca"]);
    expect(saved.interval).toBe(30);
  } finally { s.cleanup(); }
});

test("config --plain stops at end of input instead of hanging", async () => {
  const s = sandbox();
  try {
    s.stub("gum", quoteStub);
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
    s.stub("gum", quoteStub);
    const printed = await s.cli(["config"]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).not.toContain("Select Stoics");
    expect(printed.stdout).toContain("omastoic config --authors marcus,seneca --interval 15");
    expect(existsSync(join(s.config, "omastoic/config.json"))).toBe(false);
  } finally { s.cleanup(); }
});
