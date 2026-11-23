// How Omastoic tells Omarchy's two screensavers apart, and how it starts the
// native one. The idle service and the System menu both run
// `omarchy-launch-screensaver` with no arguments, so they read
// ~/.config/omarchy/branding/screensaver.txt once. Preview is the path we
// launch ourselves: it can pass --input, and it must not stay attached to the
// saver, because the native binary runs until the user dismisses it.

export type ScreensaverBackend = "native" | "terminal" | "missing";

/** Effects that keep braille portraits and quotes legible within 3 s of start. */
export const CALM_EFFECTS = ["colorshift", "highlight", "sweep"] as const;

/** Curated effect list passed by `omastoic preview` via `--include-effects`. */
export function previewEffects(_quoteChars?: number): readonly string[] {
  return [...CALM_EFFECTS];
}

const NATIVE_LAUNCHER = /\/usr\/lib\/omarchy-screensaver\//;

/** The dev-channel launcher is a short script that execs the native binary. */
export function screensaverBackend(launcherText: string, available: { ttfx: boolean }): ScreensaverBackend {
  if (NATIVE_LAUNCHER.test(launcherText)) return "native";
  if (available.ttfx) return "terminal";
  return "missing";
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Start the native saver in its own session and return as soon as it is
 * clearly up, or with its status if it exits first. A failed `exec` of a
 * missing binary lands in `errorLog`.
 */
export function nativeLaunchScript(
  inputPath: string,
  errorLog: string,
  effects: readonly string[] = CALM_EFFECTS,
): string {
  const effectList = effects.join(",");
  const effectArgs = effectList ? ` --include-effects ${shellQuote(effectList)}` : "";
  const command = `setsid omarchy-launch-screensaver force --input ${shellQuote(inputPath)}${effectArgs} >/dev/null 2>${shellQuote(errorLog)} </dev/null`;
  return `${command} &
child=$!
sleep 0.4
if kill -0 "$child" 2>/dev/null; then
  echo running
  exit 0
fi
wait "$child"
status=$?
echo "exited:$status"
exit "$status"
`;
}

/** Bash's own "not found" when the launcher execs a package that is not installed. */
export function explainLauncherFailure(stderr: string): string | null {
  const missing =
    /omarchy-screensaver: (?:No such file or directory|not found)/i.test(stderr) ||
    /exec: .*\bomarchy-screensaver\b: not found/.test(stderr);
  if (!missing) return null;
  return "omastoic: native screensaver is not installed; install it with: omarchy pkg add omarchy-screensaver";
}
