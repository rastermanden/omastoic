import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

// Drives a real pty: the first key set goes out once the author picker has drawn
// its frame, the second once the gum stub that follows has printed its prompt.
const ptyScript = [
  "import binascii, os, pty, select, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
  "def raw(name):",
  "    return binascii.unhexlify(os.environ.get(name, ''))",
  "marker, keys = raw('PTY_MARKER'), raw('PTY_KEYS')",
  "marker2, keys2 = raw('PTY_MARKER2'), raw('PTY_KEYS2')",
  "sent = not keys",
  "sent2 = not keys2",
  "buf = b''",
  "while True:",
  "    ready, _, _ = select.select([fd], [], [], 5)",
  "    if not ready:",
  "        os.kill(pid, 15)",
  "        sys.stderr.write('timed out waiting for the cli')",
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
  "    elif not sent2 and (not marker2 or marker2 in buf):",
  "        os.write(fd, keys2)",
  "        sent2 = True",
  "_, status = os.waitpid(pid, 0)",
  "sys.stdout.buffer.write(buf)",
  "raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)",
].join("\n");

function pty(s: ReturnType<typeof sandbox>, drive: { keys: string; keys2: string }) {
  const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
  return s.exec(["/usr/bin/python3", "-c", ptyScript, process.execPath, join(root, "src/cli.ts"), "config"], {
    PTY_KEYS: hex(drive.keys),
    PTY_MARKER: hex("space/x toggle"),
    PTY_KEYS2: hex(drive.keys2),
    PTY_MARKER2: hex("QUOTE-PROMPT"),
  });
}

// A gum stand-in that reads the terminal the way real gum does.
const gumStub = [
  "case \"$*\" in",
  "  *\"Stoics on the screensaver\"*)",
  "    echo 'the author picker must not shell out to gum' >&2",
  "    exit 1",
  "    ;;",
  "esac",
  "case \"$1\" in",
  "  choose)",
  "    printf 'QUOTE-PROMPT: ' >&2",
  "    if IFS= read -r answer; then",
  "      printf '%s\\n' \"$answer\" > \"$HOME/gum.stdin\"",
  "    else",
  "      printf 'eof\\n' > \"$HOME/gum.stdin\"",
  "    fi",
  "    prev=",
  "    for arg in \"$@\"; do",
  "      if [[ \"$prev\" == --selected ]]; then printf '%s\\n' \"$arg\"; fi",
  "      prev=\"$arg\"",
  "    done",
  "    ;;",
  "  input) echo 30 ;;",
  "  confirm) exit 1 ;;",
  "  *) echo \"unexpected gum: $*\" >&2; exit 1 ;;",
  "esac",
].join("\n");

test("a line typed after the author picker reaches the next gum prompt", async () => {
  const s = sandbox();
  try {
    s.stub("gum", gumStub);
    // Only Marcus, so exactly one quote prompt follows the picker.
    const run = await pty(s, { keys: "n1\r", keys2: "hello\n" });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Stoics on the screensaver");
    expect(run.stdout + run.stderr).not.toContain("must not shell out to gum");
    expect(readFileSync(join(s.home, "gum.stdin"), "utf8").trim()).toBe("hello");
  } finally { s.cleanup(); }
}, 20000);
