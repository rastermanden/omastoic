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

// A real pty that waits for a prompt marker and then sends the process a signal,
// so the test can see how the process died and whether it handed the tty back.
const signalScript = [
  "import os, pty, select, signal, sys, termios, time",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
  "marker = os.environ['PTY_MARKER'].encode()",
  "number = getattr(signal, os.environ['PTY_SIGNAL'])",
  "out = b''",
  "deadline = time.time() + 5",
  "while marker not in out and time.time() < deadline:",
  "    ready, _, _ = select.select([fd], [], [], 0.2)",
  "    if not ready:",
  "        continue",
  "    try:",
  "        chunk = os.read(fd, 4096)",
  "    except OSError:",
  "        break",
  "    if not chunk:",
  "        break",
  "    out += chunk",
  "seen = marker in out",
  "os.kill(pid, number)",
  "while True:",
  "    ready, _, _ = select.select([fd], [], [], 5)",
  "    if not ready:",
  "        os.kill(pid, signal.SIGKILL)",
  "        break",
  "    try:",
  "        chunk = os.read(fd, 4096)",
  "    except OSError:",
  "        break",
  "    if not chunk:",
  "        break",
  "    out += chunk",
  "attrs = termios.tcgetattr(fd)",
  "_, status = os.waitpid(pid, 0)",
  "signaled = os.WIFSIGNALED(status)",
  "term = os.WTERMSIG(status) if signaled else 0",
  "code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1",
  "cooked = 1 if attrs[3] & termios.ICANON else 0",
  "sys.stdout.buffer.write(out)",
  "sys.stderr.write('SIGNAL signaled=%d number=%d code=%d marker=%d cooked=%d' % (signaled, term, code, 1 if seen else 0, cooked))",
  "raise SystemExit(0)",
].join("\n");

/** Run the CLI on a real pty, wait for a prompt, then signal it. */
export function ptySignal(s: ReturnType<typeof sandbox>, args: string[], marker: string, name: string) {
  return s.exec(["/usr/bin/python3", "-c", signalScript, process.execPath, join(root, "src/cli.ts"), ...args], {
    PTY_MARKER: marker,
    PTY_SIGNAL: name,
  });
}

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
