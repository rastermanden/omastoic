import { expect, test } from "bun:test";
import {
  CALM_EFFECTS,
  explainLauncherFailure,
  nativeLaunchScript,
  previewEffects,
  PRINT_MAX_QUOTE_CHARS,
  screensaverBackend,
  shellQuote,
} from "../src/screensaver.ts";

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

test("the native launch script passes force, --input, and --include-effects, and survives the caller exiting", () => {
  const script = nativeLaunchScript("/home/me/.config/omarchy/branding/screensaver.txt", "/tmp/omastoic-launch.err");
  expect(script).toContain("setsid");
  expect(script).toContain("omarchy-launch-screensaver force --input");
  expect(script).toContain(shellQuote("/home/me/.config/omarchy/branding/screensaver.txt"));
  expect(script).toContain(`--include-effects ${shellQuote(CALM_EFFECTS.join(","))}`);
  expect(script).not.toContain("print");
  expect(script).toContain("echo running");
  expect(nativeLaunchScript("/tmp/it's a quote.txt", "/tmp/err")).toContain(`'/tmp/it'\\''s a quote.txt'`);

  const shortScript = nativeLaunchScript("/tmp/canvas.txt", "/tmp/err", previewEffects(120));
  expect(shortScript).toContain(`--include-effects ${shellQuote("colorshift,highlight,sweep,waves,print")}`);
  const longScript = nativeLaunchScript("/tmp/canvas.txt", "/tmp/err", previewEffects(PRINT_MAX_QUOTE_CHARS + 1));
  expect(longScript).toContain(`--include-effects ${shellQuote("colorshift,highlight,sweep,waves")}`);
  expect(longScript).not.toContain("print");
});

test("previewEffects returns the calm set and excludes print above 200 quote characters", () => {
  expect(previewEffects(1)).toEqual(["colorshift", "highlight", "sweep", "waves", "print"]);
  expect(previewEffects(PRINT_MAX_QUOTE_CHARS)).toEqual(["colorshift", "highlight", "sweep", "waves", "print"]);
  expect(previewEffects(PRINT_MAX_QUOTE_CHARS + 1)).toEqual(["colorshift", "highlight", "sweep", "waves"]);
  expect(previewEffects(370)).toEqual(["colorshift", "highlight", "sweep", "waves"]);
  for (const destructive of ["decrypt", "rain", "matrix"]) {
    expect(previewEffects(50)).not.toContain(destructive);
    expect(previewEffects(370)).not.toContain(destructive);
  }
});
