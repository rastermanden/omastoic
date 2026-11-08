import { join } from "node:path";
import { root, sandbox } from "./sandbox.ts";

// A real pty, driven in stages: wait until a marker shows up in the output, then
// type the keys for that stage. One keystroke per prompt is not enough any more,
// because every prompt in `omastoic config` now belongs to the CLI itself.
const ptyScript = [
  "import binascii, json, os, pty, select, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
  "steps = json.loads(os.environ.get('PTY_STEPS', '[]'))",
  "out = b''",
  "seen = b''",
  "index = 0",
  "while True:",
  "    ready, _, _ = select.select([fd], [], [], 5)",
  "    if not ready:",
  "        os.kill(pid, 15)",
  "        sys.stderr.write('timed out waiting for config at step %d' % index)",
  "        raise SystemExit(1)",
  "    try:",
  "        chunk = os.read(fd, 4096)",
  "    except OSError:",
  "        break",
  "    if not chunk:",
  "        break",
  "    out += chunk",
  "    seen += chunk",
  "    while index < len(steps):",
  "        marker = binascii.unhexlify(steps[index]['marker'])",
  "        if marker and marker not in seen:",
  "            break",
  "        if marker:",
  "            seen = seen[seen.index(marker) + len(marker):]",
  "        else:",
  "            seen = b''",
  "        os.write(fd, binascii.unhexlify(steps[index]['keys']))",
  "        index += 1",
  "_, status = os.waitpid(pid, 0)",
  "sys.stdout.buffer.write(out)",
  "raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)",
].join("\n");

export type PtyStep = { marker: string; keys: string };

/** Run the CLI on a real pty, typing each step's keys when its marker is printed. */
export function pty(s: ReturnType<typeof sandbox>, args: string[], steps: PtyStep[] = [], extra: Record<string, string> = {}) {
  const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
  return s.exec(["/usr/bin/python3", "-c", ptyScript, process.execPath, join(root, "src/cli.ts"), ...args], {
    ...extra,
    PTY_STEPS: JSON.stringify(steps.map((step) => ({ marker: hex(step.marker), keys: hex(step.keys) }))),
  });
}

/** The markers each prompt starts with, so a test can say which answer is which. */
export const SHOWS = {
  authors: "Stoics on the screensaver",
  quotes: "Quotes from ",
  interval: "Seconds between quotes while the screensaver is up: ",
  confirm: "Add a custom quote? [y/N]",
  author: "Author slug: ",
  citation: "Citation: ",
  text: "Quote text (ctrl-d to finish):",
};
