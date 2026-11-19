import { expect, test } from "bun:test";
import { explainLauncherFailure, nativeLaunchScript, screensaverBackend, shellQuote } from "../src/screensaver.ts";

const NATIVE = "#!/bin/bash\nexec /usr/lib/omarchy-screensaver/omarchy-screensaver \"$@\"\n";

test("a launcher that execs the native binary is the native backend, even when ttfx is installed", () => {
  expect(screensaverBackend(NATIVE, { ttfx: true })).toBe("native");
  expect(screensaverBackend(NATIVE, { ttfx: false })).toBe("native");
});

test("an older launcher is the terminal backend only when ttfx is installed", () => {
  const terminal = "#!/bin/bash\n# walks monitors and starts ttfx\nexit 0\n";
  expect(screensaverBackend(terminal, { ttfx: true })).toBe("terminal");
  expect(screensaverBackend(terminal, { ttfx: false })).toBe("missing");
  expect(screensaverBackend("", { ttfx: false })).toBe("missing");
});

test("a missing native binary is reported as an install hint, not a raw exec error", () => {
  const bash = "/usr/share/omarchy/bin/omarchy-launch-screensaver: line 10: /usr/lib/omarchy-screensaver/omarchy-screensaver: No such file or directory\n";
  const exec = "exec: /usr/lib/omarchy-screensaver/omarchy-screensaver: not found\n";
  for (const stderr of [bash, exec]) {
    const message = explainLauncherFailure(stderr);
    expect(message).toContain("omarchy pkg add omarchy-screensaver");
    expect(message).not.toContain("No such file or directory");
    expect(message).not.toContain("not found");
  }
  expect(explainLauncherFailure("omarchy-launch-screensaver: no WAYLAND_DISPLAY (use --headless on this box)\n")).toBeNull();
});

test("the native launch script passes force and --input, and survives the caller exiting", () => {
  const script = nativeLaunchScript("/home/me/.config/omarchy/branding/screensaver.txt", "/tmp/omastoic-launch.err");
  expect(script).toContain("setsid");
  expect(script).toContain("omarchy-launch-screensaver force --input");
  expect(script).toContain(shellQuote("/home/me/.config/omarchy/branding/screensaver.txt"));
  expect(script).toContain("echo running");
  expect(nativeLaunchScript("/tmp/it's a quote.txt", "/tmp/err")).toContain(`'/tmp/it'\\''s a quote.txt'`);
});
