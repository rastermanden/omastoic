#!/usr/bin/env bun
// omastoic — the Stoics on your Omarchy screensaver.
//
// Omarchy's screensaver loops `ttfx` over ~/.config/omarchy/branding/screensaver.txt,
// re-reading the file every time round. So omastoic never has to replace, shadow
// or patch anything Omarchy ships: it just keeps a fresh quote in that file, and
// swaps it for another one while the screensaver is actually up.
//
// The screensaver art is one slot, and Omarchy's own commands own it too. So
// omastoic tracks what it wrote: if the file has changed underneath it — someone
// ran `omarchy branding screensaver image`, say — it stands aside instead of
// clobbering the new art.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { atomicWrite, digest, locked, OwnedFiles } from "./files.ts";
import { dirname, join } from "node:path";
import { compose, indexBundled, indexCustom, loadArt, parseAuthors, parseQuotes, pick, type BundledQuote, type Quote } from "./canvas.ts";
import { screensaverSize, screensaverWindowEvents, waitForLiveGrid, type Size } from "./hyprland.ts";
import { authorCompletionList, renderCompletion } from "./completions.ts";
import { hasBlock, withBlock, withoutBlock } from "./menu.ts";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "./plugin-id.ts";
import { renderCanvasPng, themeForeground } from "./png.ts";
import {
  applyQuoteFlags,
  compactSettings,
  DEFAULT_INTERVAL,
  describeSettings,
  inRotation,
  quoteKept,
  parseAuthorList,
  parseInterval,
  normalizeSettings,
  type QuoteChoice,
  type Settings,
} from "./settings.ts";

const ROOT = dirname(import.meta.dir);
const HOME = process.env.HOME ?? "";
const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(HOME, ".config");
const STATE_HOME = process.env.XDG_STATE_HOME ?? join(HOME, ".local/state");

const BRANDING = join(CONFIG_HOME, "omarchy/branding/screensaver.txt");
const BACKUP = join(CONFIG_HOME, "omarchy/branding/screensaver.txt.pre-omastoic");
const MENU = join(CONFIG_HOME, "omarchy/extensions/omarchy-menu.jsonc");
const USER_CONFIG = join(CONFIG_HOME, "omastoic");
const STATE = join(STATE_HOME, "omastoic");
const WRITTEN = join(STATE, "written.sha");
const UNIT = join(CONFIG_HOME, "systemd/user/omastoic.service");
const LAUNCHER = join(HOME, ".local/bin/omastoic");
const CACHE_HOME = process.env.XDG_CACHE_HOME ?? join(HOME, ".cache");
const PREVIEWS = join(CACHE_HOME, "omastoic/slates");
const LOGO = join(process.env.OMARCHY_PATH ?? "/usr/share/omarchy", "logo.txt");

// Omarchy keeps feature flags as files under ~/.local/state/omarchy/toggles.
// Using its own commands means `checked` and `when` conditions in the menu read
// the same state omastoic writes.
const TOGGLE = "omastoic";
const GLYPH = "󱄄";
const INSTALLED = join(STATE, "installed");
const PLUGIN_HOME = join(CONFIG_HOME, "omarchy/plugins", PLUGIN_ID);
const PLUGIN_HOME_LEGACY = join(CONFIG_HOME, "omarchy/plugins", LEGACY_PLUGIN_ID);
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(HOME, ".local/share");
const BASH_COMPLETION = join(DATA_HOME, "bash-completion/completions/omastoic");
const FISH_COMPLETION = join(DATA_HOME, "fish/vendor_completions.d/omastoic.fish");
const PRUNE_SCRIPT = join(HOME, ".local/lib/omastoic/prune.sh");
const PRUNE_UNIT = join(CONFIG_HOME, "systemd/user/omastoic-prune.service");
const PRUNE_PATH = join(CONFIG_HOME, "systemd/user/omastoic-prune.path");
const PLUGINS_DIR = join(CONFIG_HOME, "omarchy/plugins");

const SETTINGS_FILE = join(USER_CONFIG, "config.json");
const owned = new OwnedFiles(STATE);
const DISPLACED = join(STATE, "displaced.kind");

async function bundledBook(): Promise<BundledQuote[]> {
  return indexBundled(parseQuotes(await Bun.file(join(ROOT, "data/quotes.tsv")).text()));
}

const choicesOf = (quotes: BundledQuote[]): QuoteChoice[] => quotes.map(({ id, author }) => ({ id, author }));

async function indexedCustom(): Promise<{ quotes: BundledQuote[]; readable: boolean; error?: string }> {
  try {
    return { quotes: indexCustom(await customQuotes()), readable: true };
  } catch (error) {
    return { quotes: [], readable: false, error: (error as Error).message };
  }
}

async function config(): Promise<Settings> {
  const file = Bun.file(SETTINGS_FILE);
  if (!(await file.exists())) return {};
  const roster = [...(await authors()).keys()];
  const custom = await indexedCustom();
  const catalog = [...choicesOf(await bundledBook()), ...choicesOf(custom.quotes)];
  try {
    if (file.size > 65536) throw new Error("config exceeds 64 KiB");
    return normalizeSettings(await file.json(), roster, catalog, custom.readable);
  } catch {
    console.error(`omastoic: ignoring unreadable ${SETTINGS_FILE}`);
    return {};
  }
}

async function saveSettings(
  settings: Settings,
  roster: string[],
  catalog: QuoteChoice[],
  dropUnknownCustom = true,
): Promise<void> {
  mkdirSync(USER_CONFIG, { recursive: true });
  const next = compactSettings(settings, roster, catalog, dropUnknownCustom);
  atomicWrite(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

async function restartDaemon(): Promise<void> {
  if (enabled() && (await Bun.file(UNIT).exists())) {
    await checked(["systemctl", "--user", "restart", "omastoic.service"]);
  }
}

async function customQuotes(): Promise<Quote[]> {
  const extra = Bun.file(join(USER_CONFIG, "quotes.tsv"));
  if (!(await extra.exists())) return [];
  if (extra.size > 1024 * 1024) throw new Error("custom quote file exceeds 1 MiB");
  return parseQuotes(await extra.text());
}

function warnIgnoredRotation(bundled: BundledQuote[], custom: Quote[], settings: Settings): void {
  const rotation = inRotation(bundled, custom, settings);
  if (rotation.ignoredSelection) {
    const wanted = new Set(settings.authors ?? []);
    const selected = bundled.filter((quote) => wanted.has(quote.author));
    const onlySelected =
      wanted.size > 0 &&
      selected.length > 0 &&
      selected.length < bundled.length &&
      rotation.quotes.length === selected.length &&
      rotation.quotes.every(
        (quote, index) =>
          quote.author === selected[index]?.author &&
          quote.citation === selected[index]?.citation &&
          quote.text === selected[index]?.text,
      );
    console.error(
      onlySelected
        ? "omastoic: quote selection was ignored; using the selected Stoics' lines"
        : "omastoic: config quotes matched no quotes; using the whole book",
    );
  }
  if (rotation.ignoredAuthors) console.error("omastoic: config authors matched no quotes; using the whole book");
}

async function quoteBook(): Promise<Quote[]> {
  const bundled = await bundledBook();
  const cfg = await config();
  const custom = indexCustom(await customQuotes());
  // A bundled-only allow-list still keeps every custom line, so a new quote
  // shows up without an id being typed by hand.
  warnIgnoredRotation(bundled, custom, cfg);
  return inRotation(bundled, custom, cfg).quotes;
}

const authors = async () => parseAuthors(await Bun.file(join(ROOT, "data/authors.tsv")).text());

async function recent(): Promise<number[]> {
  try {
    const value = await Bun.file(join(STATE, "recent.json")).json();
    return Array.isArray(value) ? value.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

const run = (cmd: string[]) => Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" }).exited;
const quiet = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
async function checked(cmd: string[]): Promise<void> {
  const code = await run(cmd);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}); check the user session bus and journalctl --user -u omastoic.service, then retry setup`);
}

/**
 * Omarchy's launcher talks to Hyprland over socat and prints "Broken pipe"
 * when that socket closes — noise, not a failed screensaver. Keep real errors.
 */
async function launchScreensaver(): Promise<number> {
  if (!Bun.which("omarchy-launch-screensaver")) {
    console.error("omastoic: omarchy-launch-screensaver is missing");
    return 1;
  }

  const proc = Bun.spawn(["omarchy-launch-screensaver", "force"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const keep = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.trim() && !/socat\[\d+\].*Broken pipe/.test(line));
  for (const line of keep(stdout)) console.log(line);
  for (const line of keep(stderr)) console.error(line);

  if (code === 0) console.log("→ screensaver");
  return code ?? 1;
}

const enabled = () =>
  Bun.which("omarchy-toggle-enabled")
    ? quiet(["omarchy-toggle-enabled", TOGGLE]).exitCode === 0
    : false;

const setEnabled = (on: boolean) => {
  if (quiet(["omarchy-toggle", TOGGLE, on ? "on" : "off"]).exitCode !== 0) throw new Error("could not change Omarchy's omastoic toggle");
};

const notify = (message: string) =>
  quiet(["omarchy-notification-send", "-g", GLYPH, message]);

// --- who owns the screensaver slot ------------------------------------------

async function rememberWrite(canvas: string): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  atomicWrite(WRITTEN, digest(canvas));
}

/** True when the branding file still holds exactly what omastoic last put there. */
async function ownsBranding(): Promise<boolean> {
  const current = Bun.file(BRANDING);
  if (!(await current.exists())) return true; // nothing to trample

  const written = Bun.file(WRITTEN);
  if (!(await written.exists())) {
    return false; // A backup's mere existence is not proof of ownership.
  }

  try {
    return digest(await current.text()) === (await written.text()).trim();
  } catch {
    return false;
  }
}

async function composeQuote(quote: Quote, grid: Size): Promise<string> {
  const art = await loadArt(join(ROOT, "art"), quote.author);
  return compose(quote, (await authors()).get(quote.author), {
    cols: grid.cols,
    rows: grid.rows,
    art,
  });
}

async function onScreen(): Promise<Quote | null> {
  const quotes = await quoteBook();
  const index = (await recent())[0];
  return typeof index === "number" ? quotes[index] ?? null : null;
}

async function render(size?: Size): Promise<{ body: string; recent: number[] }> {
  const quotes = await quoteBook();
  if (!quotes.length) throw new Error("the quote book is empty");

  const chosen = pick(quotes, await recent());
  const grid = size ?? (await screensaverSize());
  return { body: await composeQuote(chosen.quote, grid), recent: chosen.recent };
}

/** Replace the branding file in one step, so a running ttfx never reads a half-written canvas. */
async function commitCanvas(body: string, before: string | null, takeSlot = false): Promise<boolean> {
  const canvas = `${body}\n`;
  if (!takeSlot && !(await ownsBranding())) { standAside(); return false; }
  if ((await Bun.file(BRANDING).text().catch(() => null)) !== before) { standAside(); return false; }
  atomicWrite(BRANDING, canvas);
  await rememberWrite(canvas);
  return true;
}

async function writeBranding(takeSlot = false, size?: Size): Promise<boolean> {
  // Recheck after rendering too: a user's branding command may run while we
  // measure terminals. All our writers hold the transaction lock.
  const before = await Bun.file(BRANDING).text().catch(() => null);
  if (!takeSlot && !(await ownsBranding())) { standAside(); return false; }
  const drawn = await render(size);
  if (!(await commitCanvas(drawn.body, before, takeSlot))) return false;
  atomicWrite(join(STATE, "recent.json"), JSON.stringify(drawn.recent));
  return true;
}

async function reflowQuote(size: Size): Promise<boolean> {
  const before = await Bun.file(BRANDING).text().catch(() => null);
  if (!(await ownsBranding())) { standAside(); return false; }
  const quote = await onScreen();
  if (!quote) return false;
  return commitCanvas(await composeQuote(quote, size), before, false);
}

/**
 * Keep the art we are about to cover so `off` can put it back. Always the last
 * non-omastoic canvas — Omarchy's branding commands are the way you set art,
 * and toggling the Stoics off should return whatever they displaced.
 */
async function preserveDisplaced(): Promise<void> {
  const current = Bun.file(BRANDING);
  if (await ownsBranding() && await Bun.file(DISPLACED).exists()) return;
  if (!(await current.exists())) { atomicWrite(DISPLACED, "absent"); return; }
  const text = await current.text();
  owned.write("backup", BACKUP, text);
  atomicWrite(DISPLACED, "file");
}

async function restoreSlot(): Promise<void> {
  if (!(await Bun.file(DISPLACED).exists()) && !(await Bun.file(WRITTEN).exists())) return;
  const backup = Bun.file(BACKUP);
  const kind = await Bun.file(DISPLACED).text().catch(() => "legacy");
  if (kind === "absent") rmSync(BRANDING, { force: true });
  else if (await backup.exists() && owned.owns("backup", BACKUP)) atomicWrite(BRANDING, await backup.text());
  else if (kind === "file") throw new Error(`displaced branding backup changed or is missing: ${BACKUP}; restore the backup before retrying off/uninstall`);
  else if (kind === "legacy" && await Bun.file(LOGO).exists()) atomicWrite(BRANDING, await Bun.file(LOGO).text());
  owned.remove("backup", BACKUP);
  rmSync(DISPLACED, { force: true });
  rmSync(WRITTEN, { force: true });
}

async function stopDaemon(): Promise<void> {
  if (owned.owns("unit", UNIT)) await checked(["systemctl", "--user", "disable", "--now", "omastoic.service"]);
}

async function on(): Promise<number> {
  const wasEnabled = enabled();
  const previousCanvas = wasEnabled && await ownsBranding() ? await Bun.file(BRANDING).text().catch(() => null) : null;
  await preserveDisplaced();

  try {
    setEnabled(true);
    if (!(await writeBranding(true))) throw new Error("could not activate the Stoics");
    if (owned.owns("unit", UNIT)) await checked(["systemctl", "--user", "enable", "--now", "omastoic.service"]);
    else console.log("→ not installed as a service yet; run: omastoic setup");
  } catch (error) {
    setEnabled(wasEnabled);
    if (await ownsBranding()) {
      if (previousCanvas !== null) {
        atomicWrite(BRANDING, previousCanvas);
        await rememberWrite(previousCanvas);
      } else await restoreSlot();
    }
    throw error;
  }

  console.log("→ the Stoics have the screensaver");
  notify("Screensaver: the Stoics");
  return 0;
}

async function off(): Promise<number> {
  const ours = await ownsBranding();
  setEnabled(false);
  await stopDaemon();
  if (ours) await restoreSlot();
  console.log("→ the Stoics have stood down");
  notify("Screensaver: the Stoics off");
  return 0;
}

/**
 * Someone else has written the screensaver slot. Turn off rather than fight over
 * it — Omarchy's own branding commands should win, and silently reverting them
 * would look like a bug in Omarchy.
 */
function standAside(): void {
  setEnabled(false);
  console.error("omastoic: the screensaver art changed underneath us — standing aside");
  notify("Screensaver art changed — the Stoics stood aside");
}

// --- installation ------------------------------------------------------------

async function addMenuRows(quiet = false): Promise<void> {
  const file = Bun.file(MENU);
  const source = (await file.exists()) ? await file.text() : "{\n}\n";
  const next = withBlock(source);
  if (next === source) return;
  mkdirSync(dirname(MENU), { recursive: true });
  if ((await file.exists()) && await file.text() !== source) throw new Error("menu changed during setup; retry");
  atomicWrite(MENU, next);
  if (!quiet) console.log(`→ added Stoics under Appearance → Branding → Screensaver`);
}

async function removeMenuRows(): Promise<void> {
  const file = Bun.file(MENU);
  if (!(await file.exists())) return;
  const source = await file.text();
  if (!hasBlock(source)) return;
  const next = withoutBlock(source);
  // withBlock validates the remaining user document without reserializing it.
  withBlock(next);
  if (await file.text() !== source) throw new Error("menu changed during removal; retry");
  atomicWrite(MENU, next);
  console.log("→ removed the Stoics row from the Omarchy menu");
}

function checkLauncher(): void {
  let stat;
  try { stat = lstatSync(LAUNCHER); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let previous: string | undefined;
  try { previous = readFileSync(join(STATE, "launcher.target"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (stat.isSymbolicLink() && [join(ROOT, "bin/omastoic"), previous].includes(readlinkSync(LAUNCHER))) return;
  throw new Error(`refusing to overwrite unrelated launcher: ${LAUNCHER}`);
}

function linkLauncher(): void {
  checkLauncher();
  const target = join(ROOT, "bin/omastoic");
  mkdirSync(dirname(LAUNCHER), { recursive: true });
  let current: string | undefined;
  try { current = readlinkSync(LAUNCHER); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (current !== target) {
    if (current != null) unlinkSync(LAUNCHER);
    symlinkSync(target, LAUNCHER);
  }
  atomicWrite(join(STATE, "launcher.target"), target);
}

function unlinkLauncher(): void {
  try {
    const target = readFileSync(join(STATE, "launcher.target"), "utf8");
    if (lstatSync(LAUNCHER).isSymbolicLink() && readlinkSync(LAUNCHER) === target) unlinkSync(LAUNCHER);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  rmSync(join(STATE, "launcher.target"), { force: true });
}

function completionFiles(): [string, string, string][] {
  const roster = authorCompletionList(readFileSync(join(ROOT, "data/authors.tsv"), "utf8"));
  return [
    ["bash", BASH_COMPLETION, renderCompletion(readFileSync(join(ROOT, "completions/omastoic.bash"), "utf8"), roster)],
    ["fish", FISH_COMPLETION, renderCompletion(readFileSync(join(ROOT, "completions/omastoic.fish"), "utf8"), roster)],
  ];
}

type SetupOpts = { onFirst?: boolean; quiet?: boolean };

function unitBody(): string {
  // The launcher, not the plugin-tree binary: after `omarchy plugin remove`
  // a dangling or missing ~/.local/bin/omastoic fails closed instead of
  // restart-looping on a path that no longer exists.
  return `[Unit]
Description=Rotate the Stoic quote on the Omarchy screensaver
ConditionPathExists=${LAUNCHER}
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=${LAUNCHER} daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
`;
}

function pruneUnitBody(): string {
  return `[Unit]
Description=Remove leftover omastoic files after the plugin folder is gone
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=${PRUNE_SCRIPT}
`;
}

function prunePathBody(): string {
  return `[Unit]
Description=Watch for omastoic plugin disable or removal

[Path]
PathChanged=${PLUGINS_DIR}
PathChanged=${join(CONFIG_HOME, "omarchy/shell.json")}
PathChanged=${BRANDING}
Unit=omastoic-prune.service

[Install]
WantedBy=default.target
`;
}

async function removePrune(): Promise<void> {
  if (owned.owns("prune-path", PRUNE_PATH)) await checked(["systemctl", "--user", "disable", "--now", "omastoic-prune.path"]);
  owned.remove("prune-path", PRUNE_PATH);
  owned.remove("prune-unit", PRUNE_UNIT);
  owned.remove("prune-script", PRUNE_SCRIPT);
  await checked(["systemctl", "--user", "daemon-reload"]);
}

async function requireOmarchy(): Promise<number> {
  if (!Bun.which("omarchy")) {
    console.error("omastoic: omarchy is not on PATH — this needs Omarchy's terminal/ttfx screensaver");
    return 1;
  }
  if (!Bun.which("ttfx")) {
    console.error("omastoic: ttfx is missing, so the Omarchy screensaver cannot run");
    console.error("          install it with: omarchy pkg add ttfx");
    return 1;
  }
  for (const command of ["systemctl", "jq", "python3", "flock", "omarchy-toggle", "omarchy-toggle-enabled"]) {
    if (!Bun.which(command)) { console.error(`omastoic: required command missing: ${command}`); return 1; }
  }
  // The native renderer reads its input only once and has no terminal events.
  const launcher = Bun.which("omarchy-launch-screensaver");
  if (launcher && /\/usr\/lib\/omarchy-screensaver\//.test(await Bun.file(launcher).text())) {
    console.error("omastoic: native Omarchy screensaver is not supported by this release; nothing was installed");
    return 1;
  }
  return 0;
}

/**
 * Idempotent plumbing: launcher, menu row, systemd unit. Does not touch the
 * screensaver slot unless this is the first setup and `--on-first` was passed
 * — otherwise a shell restart would steal the slot back after `omastoic off`.
 */
async function setup(opts: SetupOpts = {}): Promise<number> {
  const missing = await requireOmarchy();
  if (missing) return missing;

  const say = (line: string) => {
    if (!opts.quiet) console.log(line);
  };

  const previous = await Bun.file(INSTALLED).text().catch(() => "");
  const first = !previous;
  let undoActivation = false;
  if (previous && existsSync(WRITTEN) && !existsSync(DISPLACED)) {
    owned.write("backup", BACKUP, readFileSync(existsSync(BACKUP) ? BACKUP : LOGO, "utf8"));
    atomicWrite(DISPLACED, "file");
  }
  const fingerprint = digest(["src", "data", "art", "bin"].flatMap((dir) => readdirSync(join(ROOT, dir)).sort().map((f) => readFileSync(join(ROOT, dir, f), "utf8"))).join("\0") + await Bun.file(join(ROOT, "manifest.json")).text());
  const marker = JSON.stringify({ root: ROOT, fingerprint });
  const artifacts: [string, string, string, string?][] = [
    ...completionFiles(),
    ["unit", UNIT, unitBody()],
    ["prune-unit", PRUNE_UNIT, pruneUnitBody(), pruneUnitBody().replace("StartLimitIntervalSec=0\n", "")],
    ["prune-path", PRUNE_PATH, prunePathBody(), prunePathBody().replace("disable or removal", "removal").replace(`PathChanged=${join(CONFIG_HOME, "omarchy/shell.json")}\n`, "").replace(`PathChanged=${BRANDING}\n`, "")],
    ["prune-script", PRUNE_SCRIPT, readFileSync(join(ROOT, "scripts/prune.sh"), "utf8")],
  ];
  // Preflight every conflict and the menu before creating any external artifact.
  checkLauncher();
  withBlock(await Bun.file(MENU).text().catch(() => "{\n}\n"));
  for (const [id, path, body, legacy] of artifacts) owned.check(id, path, body, legacy);
  try {
    linkLauncher();
    let changed = false;
    for (const [id, path, body, legacy] of artifacts) changed = owned.write(id, path, body, legacy) || changed;
    chmodSync(PRUNE_SCRIPT, 0o755);
    await addMenuRows(opts.quiet);
    if (changed) await checked(["systemctl", "--user", "daemon-reload"]);
    await checked(["systemctl", "--user", "enable", "--now", "omastoic-prune.path"]);
    if (opts.onFirst && first) {
      const code = await on();
      if (code) throw new Error("could not activate the Stoics");
      undoActivation = true;
    } else if (enabled()) {
      await checked(["systemctl", "--user", "enable", "omastoic.service"]);
      if (previous !== marker || changed) await checked(["systemctl", "--user", "restart", "omastoic.service"]);
      else await checked(["systemctl", "--user", "start", "omastoic.service"]);
    } else {
      await stopDaemon();
    }
    atomicWrite(INSTALLED, marker); // Only successful setup is an installation.
    undoActivation = false;
  } catch (error) {
    if (undoActivation) {
      await run(["systemctl", "--user", "disable", "--now", "omastoic.service"]);
      if (existsSync(WRITTEN) && await ownsBranding()) await restoreSlot();
      setEnabled(false);
    }
    throw error;
  }
  const interval = (await config()).interval ?? DEFAULT_INTERVAL;
  say(`→ a new quote every ${interval}s while the screensaver is up`);
  return 0;
}

async function install(): Promise<number> {
  const code = await setup({ onFirst: true });
  if (code) return code;
  console.log("\nTry it now:    omastoic preview");
  console.log("Switch away:   Appearance → Branding → Screensaver → Stoics, or omastoic toggle");
  return 0;
}

async function uninstall(opts: { purge?: boolean } = {}): Promise<number> {
  await off();

  owned.remove("unit", UNIT);
  await checked(["systemctl", "--user", "daemon-reload"]);
  await removeMenuRows();
  unlinkLauncher();
  for (const [id, path] of completionFiles()) owned.remove(id, path);
  await removePrune();

  owned.remove("backup", BACKUP);
  await Bun.file(INSTALLED).delete().catch(() => {});

  if (opts.purge) {
    rmSync(USER_CONFIG, { recursive: true, force: true });
    for (const name of readdirSync(STATE)) if (name !== "transaction.flock") rmSync(join(STATE, name), { recursive: true, force: true });
    rmSync(PREVIEWS, { recursive: true, force: true });
    console.log(`→ removed ${USER_CONFIG}`);
  }

  // The plugin folder is what `omarchy plugin add` keys on. Leaving it behind
  // after teardown makes the next add fail with "id already used", and the
  // still-enabled service would set the Stoics up again on the next shell start.
  for (const [id, home] of [
    [PLUGIN_ID, PLUGIN_HOME],
    [LEGACY_PLUGIN_ID, PLUGIN_HOME_LEGACY],
  ] as const) {
    if (!(await Bun.file(join(home, "manifest.json")).exists())) continue;
    const code = await run(["omarchy", "plugin", "remove", id, "--yes"]);
    if (code !== 0) {
      console.error("omastoic: plugin folder still there — remove it with:");
      console.error(`          omarchy plugin remove ${id} --yes`);
      return 1;
    }
  }
  return 0;
}

// --- the rotation service -----------------------------------------------------

async function intervalMs(): Promise<number> {
  return ((await config()).interval ?? DEFAULT_INTERVAL) * 1000;
}

async function daemon(): Promise<number> {
  if (!enabled()) {
    console.log("omastoic: parked (omastoic toggle to bring the Stoics back)");
    return 0;
  }

  const open = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fitted: Size | null = null;
  const GRID_POLL_MS = 200;

  const stopRotating = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const sameGrid = (grid: Size) => fitted?.cols === grid.cols && fitted?.rows === grid.rows;

  const rotate = async (): Promise<boolean> => {
    await locked(STATE, async () => {
      if (!enabled()) return;
      const grid = await screensaverSize();
      if (await writeBranding(false, grid)) fitted = grid.source === "live" ? grid : null;
    }).catch((err) => { console.error(`omastoic: ${err.message}`); });
    if (!enabled()) {
      stopRotating();
      return false;
    }
    if (!(await ownsBranding())) {
      standAside();
      stopRotating();
      return false;
    }
    return true;
  };

  const refit = async (): Promise<boolean> => {
    const seen = await screensaverSize();
    if (seen.source !== "live" || sameGrid(seen)) return enabled() && await ownsBranding();
    await locked(STATE, async () => {
      if (!enabled()) return;
      const grid = await screensaverSize();
      if (grid.source !== "live" || sameGrid(grid)) return;
      try {
        if (await reflowQuote(grid)) fitted = grid;
      } catch (err) {
        fitted = grid;
        throw err;
      }
    }).catch((err) => { console.error(`omastoic: ${err.message}`); });
    if (!enabled()) {
      stopRotating();
      return false;
    }
    if (!(await ownsBranding())) {
      standAside();
      stopRotating();
      return false;
    }
    return true;
  };

  const tick = async () => {
    timer = null;
    if (!(await rotate())) return;
    if (open.size === 0) return;
    timer = setTimeout(tick, await intervalMs());
  };

  const startRotating = async () => {
    if (timer) return;
    timer = setTimeout(tick, await intervalMs());
  };

  // Leave a fresh quote sitting in the file so the very first frame of the next
  // screensaver is already new, without racing the ttfx that is about to read it.
  await rotate();

  const windows = screensaverWindowEvents()[Symbol.asyncIterator]();
  type Incoming = { kind: "event"; result: Awaited<ReturnType<typeof windows.next>> } | { kind: "grid" };
  const queue: Incoming[] = [];
  let notify: (() => void) | null = null;
  const push = (item: Incoming) => {
    queue.push(item);
    notify?.();
    notify = null;
  };
  const take = (): Promise<Incoming> => queue.length
    ? Promise.resolve(queue.shift()!)
    : new Promise((resolve) => { notify = () => resolve(queue.shift()!); });
  void (async () => {
    try {
      while (true) {
        const result = await windows.next();
        push({ kind: "event", result });
        if (result.done) return;
      }
    } catch (error) {
      console.error(`omastoic: ${String(error)}`);
      push({ kind: "event", result: { done: true, value: undefined } });
    }
  })();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (open.size === 0) return;
    pollTimer = setTimeout(() => {
      if (!queue.some((item) => item.kind === "grid")) push({ kind: "grid" });
    }, GRID_POLL_MS);
  };

  while (true) {
    const incoming = await take();
    if (incoming.kind === "grid") {
      if (open.size > 0) await refit();
    } else if (incoming.result.done) {
      if (pollTimer) clearTimeout(pollTimer);
      return 0;
    } else {
      const event = incoming.result.value;
      if (event.kind === "sync") {
        open.clear();
        for (const address of event.addresses) open.add(address);
        if (open.size) {
          if (await refit()) await startRotating();
        } else stopRotating();
      } else if (event.kind === "open") {
        if (!open.has(event.address)) {
          open.add(event.address);
          if (enabled()) {
            if (open.size === 1) await waitForLiveGrid();
            if (await refit()) await startRotating();
          }
        }
      } else if (event.kind === "close" && open.delete(event.address)) {
        if (open.size === 0) {
          stopRotating();
          fitted = null;
          await rotate();
        } else await refit();
      }
    }
    arm();
  }
}

// --- configure ----------------------------------------------------------------

function stringFlag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : undefined;
}

function flagValues(rest: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== `--${name}`) continue;
    const next = rest[i + 1];
    out.push(next && !next.startsWith("--") ? next : "");
  }
  return out;
}

async function gumRun(args: string[]): Promise<{ out: string; code: number } | null> {
  if (!Bun.which("gum")) return null;
  const proc = Bun.spawn(["gum", ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(proc.stdout).text()).trim();
  return { out, code: await proc.exited };
}

async function gumText(args: string[]): Promise<string | null> {
  const result = await gumRun(args);
  if (result == null || result.code !== 0) return null;
  return result.out;
}

async function pickAuthors(roster: Map<string, { name: string }>, selected: string[]): Promise<string[] | undefined> {
  const byName = new Map([...roster].map(([slug, a]) => [a.name, slug]));
  const args = [
    "choose",
    "--no-limit",
    "--limit",
    String(roster.size + 1),
    "--header",
    "Stoics on the screensaver  (x or tab to toggle, enter to confirm)",
  ];
  if (selected.length) {
    for (const slug of selected) {
      const name = roster.get(slug)?.name;
      if (name) args.push("--selected", name);
    }
  } else {
    args.push("--selected", "*");
  }
  args.push(...byName.keys());
  const out = await gumText(args);
  if (out == null) return undefined;
  if (!out) return [];
  return out.split("\n").flatMap((line) => {
    const slug = byName.get(line.trim());
    return slug ? [slug] : [];
  });
}

async function pickInterval(current: number): Promise<number | undefined> {
  const out = await gumText([
    "input",
    "--header",
    "Seconds between quotes while the screensaver is up",
    "--placeholder",
    String(DEFAULT_INTERVAL),
    "--value",
    String(current),
  ]);
  if (out == null) return undefined;
  const n = parseInterval(out);
  if (n == null) {
    console.error(`omastoic: interval must be a whole number of seconds from 1 to 3600`);
    return undefined;
  }
  return n;
}

/** Gum splits every `--selected` value on commas, so a chooser label cannot contain one. */
function quoteLabel(quote: BundledQuote): string {
  const clip = (value: string) => value.replaceAll(", ", " ").replaceAll(",", " ").trim();
  const text = quote.text.length > 48 ? `${quote.text.slice(0, 47)}…` : quote.text;
  return `${quote.id}  ${clip(quote.citation)}  ${clip(text)}`;
}

async function pickQuotes(name: string, choices: BundledQuote[], selected: string[] | null): Promise<string[] | undefined> {
  const byLabel = new Map(choices.map((quote) => [quoteLabel(quote), quote.id]));
  const args = [
    "choose",
    "--no-limit",
    "--limit",
    String(choices.length + 1),
    "--header",
    `Quotes from ${name}  (x or tab to toggle, enter to confirm)`,
  ];
  const chosen = selected ?? choices.map((quote) => quote.id);
  if (chosen.length === choices.length) args.push("--selected", "*");
  else for (const quote of choices) if (chosen.includes(quote.id)) args.push("--selected", quoteLabel(quote));
  args.push(...byLabel.keys());
  const out = await gumText(args);
  if (out == null) return undefined;
  if (!out) return [];
  return out.split("\n").flatMap((line) => {
    const id = byLabel.get(line.trim());
    return id ? [id] : [];
  });
}

const QUOTE_HEADER = "# author-slug <TAB> citation <TAB> text\n";

type PromptedQuote = { kind: "quote"; quote: Quote } | { kind: "cancel" } | { kind: "invalid" };

/** Collapse tabs and newlines so a gum answer stays one quotes.tsv row. */
function flatField(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function quoteRow(quote: Quote): string {
  return `${quote.author}\t${quote.citation}\t${quote.text}`;
}

function addUsage(): void {
  console.error("omastoic: --add expects one author, citation and text, separated by tabs");
  console.error("          omastoic config --add");
  console.error("          omastoic config --add $'marcus\\tMeditations IX.1\\tYour line.'");
}

async function promptCustomQuote(): Promise<PromptedQuote> {
  const author = await gumText([
    "input",
    "--header",
    "Author slug",
    "--value",
    "marcus",
    "--char-limit",
    "64",
  ]);
  if (author == null) return { kind: "cancel" };
  const citation = await gumText([
    "input",
    "--header",
    "Citation",
    "--value",
    "Meditations IX.1",
    "--char-limit",
    "256",
  ]);
  if (citation == null) return { kind: "cancel" };
  const text = await gumText([
    "write",
    "--header",
    "Quote text",
    "--value",
    "Your line.",
    "--char-limit",
    "4096",
    "--height",
    "6",
  ]);
  if (text == null) return { kind: "cancel" };
  try {
    const rows = parseQuotes(`${flatField(author)}\t${flatField(citation)}\t${flatField(text)}\n`);
    if (rows.length !== 1) {
      console.error("omastoic: --add expects one author, citation and text, separated by tabs");
      return { kind: "invalid" };
    }
    return { kind: "quote", quote: rows[0] };
  } catch (error) {
    console.error(`omastoic: ${(error as Error).message}`);
    return { kind: "invalid" };
  }
}

async function offerCustomQuote(): Promise<PromptedQuote | { kind: "skip" } | { kind: "abort" }> {
  const answer = await gumRun(["confirm", "Add a custom quote?"]);
  if (answer == null || (answer.code !== 0 && answer.code !== 1)) return { kind: "abort" };
  if (answer.code === 1) return { kind: "skip" };
  return promptCustomQuote();
}

async function appendQuotes(lines: string[]): Promise<number> {
  const parsed: Quote[] = [];
  for (const line of lines) {
    let rows: Quote[];
    try {
      rows = parseQuotes(line.endsWith("\n") ? line : `${line}\n`);
    } catch (error) {
      console.error(`omastoic: ${(error as Error).message}`);
      return 1;
    }
    if (rows.length !== 1) {
      console.error("omastoic: --add expects one author, citation and text, separated by tabs");
      return 1;
    }
    parsed.push(rows[0]);
  }
  const path = join(USER_CONFIG, "quotes.tsv");
  const existing = await Bun.file(path).text().catch(() => "");
  let have: Quote[] = [];
  try {
    have = existing ? parseQuotes(existing) : [];
  } catch (error) {
    console.error(`omastoic: ${(error as Error).message}`);
    return 1;
  }
  const key = (quote: Quote) => `${quote.author}\t${quote.citation}\t${quote.text}`;
  const seen = new Set(have.map(key));
  const rows: string[] = [];
  for (const quote of parsed) {
    const row = key(quote);
    if (seen.has(row)) {
      console.error(`omastoic: that quote is already in ${path}`);
      return 1;
    }
    seen.add(row);
    rows.push(`${row}\n`);
  }
  const body = existing === "" ? QUOTE_HEADER : existing.endsWith("\n") ? existing : `${existing}\n`;
  const next = `${body}${rows.join("")}`;
  if (Buffer.byteLength(next) > 1024 * 1024) {
    console.error("omastoic: custom quote file exceeds 1 MiB");
    return 1;
  }
  mkdirSync(USER_CONFIG, { recursive: true });
  atomicWrite(path, next);
  console.log(`→ added ${rows.length} ${rows.length === 1 ? "quote" : "quotes"} to ${path}`);
  return 0;
}

function formatQuoteList(bundled: BundledQuote[], custom: BundledQuote[], settings: Settings): string {
  const lines = ["bundled:"];
  const row = (quote: BundledQuote) => {
    const authorOn = !settings.authors?.length || settings.authors.includes(quote.author);
    const kept = authorOn && quoteKept(quote.id, settings.quotes?.[quote.author]);
    const text = quote.text.length > 60 ? `${quote.text.slice(0, 59)}…` : quote.text;
    return `${kept ? "*" : " "} ${quote.id}  ${quote.author}  ${quote.citation}  ${text}`;
  };
  for (const quote of bundled) lines.push(row(quote));
  lines.push("custom:");
  if (!custom.length) lines.push("  (none)");
  for (const quote of custom) lines.push(row(quote));
  return lines.join("\n");
}

/** A bundled-only list gains every custom id. An explicit custom list gains the quote just added. */
function rememberAddedQuote(settings: Settings, custom: BundledQuote[], added: Quote): Settings {
  const list = settings.quotes?.[added.author];
  if (!list) return settings;
  const mine = custom.filter((quote) => quote.author === added.author);
  const addedRow = mine.find((quote) => quote.citation === added.citation && quote.text === added.text);
  if (!addedRow) return settings;
  const explicit = list.some((id) => id.startsWith("c"));
  const ids = list.filter((id) => id !== "c00");
  for (const id of explicit ? [addedRow.id] : mine.map((quote) => quote.id)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return { ...settings, quotes: { ...settings.quotes, [added.author]: ids } };
}

function printSettings(settings: Settings, names: Map<string, { name: string }>, catalog: QuoteChoice[]): void {
  console.log(`→ ${describeSettings(settings, names, catalog)}`);
}

async function configure(rest: string[]): Promise<number> {
  const roster = await authors();
  const slugs = [...roster.keys()];
  const bundled = await bundledBook();
  const customBook = await indexedCustom();
  let catalog = [...choicesOf(bundled), ...choicesOf(customBook.quotes)];
  const current = await config();
  const authorsFlag = stringFlag(rest, "authors");
  const intervalFlag = stringFlag(rest, "interval");
  const quoteFlags = flagValues(rest, "quotes");
  const addFlags = flagValues(rest, "add");
  const list = rest.includes("--list");
  const interactive = authorsFlag == null && intervalFlag == null && quoteFlags.length === 0 && addFlags.length === 0 && !list;

  if (interactive && !process.stdin.isTTY) {
    printSettings(current, roster, catalog);
    console.log(`  omastoic config --authors marcus,seneca --interval 15`);
    console.log(`  omastoic config --quotes marcus=q01,q02`);
    console.log(`  omastoic config --quotes marcus=all`);
    console.log(`  omastoic config --quotes all`);
    console.log(`  omastoic config --add`);
    console.log(`  omastoic config --add $'marcus\\tMeditations IX.1\\tYour line.'`);
    console.log(`  omastoic config --list`);
    return 0;
  }

  let next: Settings = { ...current };
  let quoteLines: string[] | null = null;
  let quoteFailure: number | null = null;

  if (interactive) {
    if (!Bun.which("gum")) {
      console.error("omastoic: gum is missing — set authors, quotes and seconds from the command line:");
      console.error("          omastoic config --authors marcus --quotes marcus=q01,q02 --interval 15");
      console.error("          omastoic config --add $'marcus\\tMeditations IX.1\\tYour line.'");
      console.error("          omastoic config --list");
      return 1;
    }
    const picked = await pickAuthors(roster, current.authors ?? []);
    if (picked == null) return 0;
    next.authors = picked;
    const editing = picked.length ? picked : slugs;
    next.quotes = { ...(current.quotes ?? {}) };
    for (const slug of editing) {
      const choices = [...bundled.filter((quote) => quote.author === slug), ...customBook.quotes.filter((quote) => quote.author === slug)];
      if (!choices.length) continue;
      const selected = current.quotes && Object.hasOwn(current.quotes, slug)
        ? choices.filter((quote) => quoteKept(quote.id, current.quotes?.[slug])).map((quote) => quote.id)
        : null;
      const ids = await pickQuotes(roster.get(slug)?.name ?? slug, choices, selected);
      if (ids == null) return 0;
      const picked = ids.filter((id) => id !== "c00");
      if (choices.some((quote) => quote.id.startsWith("c")) && !picked.some((id) => id.startsWith("c"))) picked.push("c00");
      if (!customBook.readable) {
        for (const id of current.quotes?.[slug] ?? []) {
          if (id.startsWith("c") && !picked.includes(id)) picked.push(id);
        }
      }
      next.quotes[slug] = picked;
    }
    const seconds = await pickInterval(current.interval ?? DEFAULT_INTERVAL);
    if (seconds == null) return 0;
    next.interval = seconds;
    const offered = await offerCustomQuote();
    if (offered.kind === "abort") return 0;
    if (offered.kind === "invalid") quoteFailure = 1;
    else if (offered.kind === "quote") quoteLines = [quoteRow(offered.quote)];
  } else {
    if (authorsFlag != null) {
      const parsed = parseAuthorList(authorsFlag, slugs);
      if (parsed == null) {
        console.error(`omastoic: unknown author — try: ${slugs.join(", ")} (or all)`);
        return 1;
      }
      next.authors = parsed;
    }
    if (intervalFlag != null) {
      const parsed = parseInterval(intervalFlag);
      if (parsed == null) {
        console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
        return 1;
      }
      next.interval = parsed;
    }
    if (quoteFlags.length) {
      const applied = applyQuoteFlags(next.quotes, quoteFlags, slugs, catalog, customBook.readable);
      if (!applied.ok) {
        console.error(`omastoic: ${applied.error}`);
        return 1;
      }
      next.quotes = applied.quotes;
    }
    if (addFlags.length) {
      if (addFlags.some((line) => !line)) {
        if (addFlags.length !== 1 || !process.stdin.isTTY) {
          addUsage();
          return 1;
        }
        if (!Bun.which("gum")) {
          console.error("omastoic: gum is missing — pass one tab-separated line:");
          console.error("          omastoic config --add $'marcus\\tMeditations IX.1\\tYour line.'");
          return 1;
        }
        const prompted = await promptCustomQuote();
        if (prompted.kind === "invalid") quoteFailure = 1;
        else if (prompted.kind === "quote") quoteLines = [quoteRow(prompted.quote)];
      } else {
        quoteLines = addFlags;
      }
    }
  }

  const settingsTouched = interactive || authorsFlag != null || intervalFlag != null || quoteFlags.length > 0;
  let selectionTouched = false;
  if (quoteLines) {
    const code = await appendQuotes(quoteLines);
    if (code !== 0) quoteFailure = code;
    else {
      const customNow = indexCustom(await customQuotes());
      catalog = [...choicesOf(bundled), ...choicesOf(customNow)];
      for (const line of quoteLines) {
        const added = parseQuotes(line.endsWith("\n") ? line : `${line}\n`)[0];
        if (!added) continue;
        const updated = rememberAddedQuote(next, customNow, added);
        if (updated !== next) {
          next = updated;
          selectionTouched = true;
        }
      }
    }
  }
  if (settingsTouched || selectionTouched) await saveSettings(next, slugs, catalog, customBook.readable);
  if (quoteFailure != null) {
    if (settingsTouched) {
      await restartDaemon();
      printSettings(await config(), roster, catalog);
    }
    return quoteFailure;
  }
  if (!settingsTouched && !quoteLines && !list) return 0;
  if (settingsTouched || quoteLines) await restartDaemon();
  const saved = await config();
  printSettings(saved, roster, catalog);
  const custom = quoteLines && quoteFailure == null ? indexCustom(await customQuotes()) : customBook.quotes;
  warnIgnoredRotation(bundled, custom, saved);
  if (list) {
    if (customBook.error) console.error(`omastoic: ${customBook.error}`);
    console.log(formatQuoteList(bundled, custom, saved));
  }
  return 0;
}

async function status(): Promise<number> {
  const quotes = await quoteBook();
  const byAuthor = new Map<string, number>();
  for (const q of quotes) byAuthor.set(q.author, (byAuthor.get(q.author) ?? 0) + 1);

  const names = await authors();
  console.log(`${quotes.length} quotes:`);
  for (const [slug, count] of [...byAuthor].sort((a, b) => b[1] - a[1])) {
    const art = (await loadArt(join(ROOT, "art"), slug)) ? "portrait" : "no portrait";
    console.log(`  ${(names.get(slug)?.name ?? slug).padEnd(18)} ${String(count).padStart(3)}  ${art}`);
  }

  const size = await screensaverSize();
  const unit = Bun.spawnSync(["systemctl", "--user", "is-active", "omastoic.service"]);
  const on = enabled();
  const ours = on && (await ownsBranding());

  console.log(`
screensaver:      ${on ? (ours ? "the Stoics" : "the Stoics (stood aside)") : "Omarchy's"}
settings:         ${describeSettings(await config(), names, [...choicesOf(await bundledBook()), ...choicesOf((await indexedCustom()).quotes)])}
grid:             ${size.cols}x${size.rows} (${size.source})
canvas file:      ${BRANDING}
rotation service: ${unit.stdout.toString().trim() || "not installed"}`);
  return 0;
}

async function requireOn(): Promise<boolean> {
  if (enabled()) return true;
  console.error("omastoic: the Stoics are off — turn them on with: omastoic toggle");
  return false;
}

async function main(): Promise<number> {
  const [command = "help", ...rest] = Bun.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : undefined;
  };

  switch (command) {
    case "show": {
      const cols = flag("cols") ?? (process.stdout.columns || undefined);
      const rows = flag("rows") ?? (process.stdout.rows || undefined);
      console.log((await render({ cols: cols ?? 92, rows: rows ?? 25 })).body);
      return 0;
    }
    case "on":
      return on();
    case "off":
      return off();
    case "toggle":
      return enabled() ? off() : on();
    case "choose":
    case "switcher":
    case "use":
    case "slates":
      console.error("omastoic: the screensaver slot is Omarchy's — Appearance → Branding → Screensaver");
      console.error("          Stoics on/off is: omastoic toggle");
      return 1;
    case "render-png": {
      // Used by scripts/preview.sh.
      const [input, out = "/tmp/omastoic-preview.png"] = rest;
      if (!input) {
        console.error("usage: omastoic render-png <canvas.txt> [out.png]");
        return 1;
      }
      await renderCanvasPng(await Bun.file(input).text(), out, {
        foreground: await themeForeground(),
      });
      console.log(out);
      return 0;
    }
    case "next":
      if (!(await requireOn())) return 1;
      return await writeBranding() ? 0 : 1;
    case "preview":
      if (!enabled()) {
        const code = await on();
        if (code) return code;
      } else if (!(await writeBranding())) return 1;
      {
        const code = await launchScreensaver();
        const live = await waitForLiveGrid();
        if (!(await ownsBranding())) { standAside(); return 1; }
        if (live && !(await reflowQuote(live))) return 1;
        return code;
      }
    case "daemon":
      return daemon();
    case "setup":
      return setup({ onFirst: rest.includes("--on-first"), quiet: rest.includes("--quiet") });
    case "install":
      return install();
    case "uninstall":
      return uninstall({ purge: rest.includes("--purge") });
    case "status":
      return status();
    case "config":
    case "configure":
      return configure(rest);
    default:
      console.log(`omastoic — the Stoics on your Omarchy screensaver

  omastoic toggle      hand the screensaver to the Stoics, or give it back
  omastoic preview     write a new canvas and start the screensaver now
  omastoic config      choose Stoics, their quotes, and seconds, or add a quote with gum
  omastoic status      who has the screensaver, and what is in the quote book
  omastoic uninstall   take the service, menu row and plugin back out

Install:  omarchy plugin add https://github.com/rastermanden/omastoic.git --enable
Remove:   omastoic uninstall

Appearance → Branding → Screensaver → Stoics is the same toggle. Edit Text, Set From Image
and Restore Default stay Omarchy's; if they write the slot, the Stoics
stand aside.

Quotes:   ${join(USER_CONFIG, "quotes.tsv")}
Settings: ${join(USER_CONFIG, "config.json")}`);
      return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
}

try {
  const command = Bun.argv[2];
  const mutating = ["on", "off", "toggle", "next", "preview", "setup", "install", "uninstall", "config", "configure"].includes(command);
  process.exit(await (mutating ? locked(STATE, main) : main()));
} catch (error) {
  console.error(`omastoic: ${(error as Error).message}`);
  process.exit(1);
}
