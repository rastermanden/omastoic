#!/usr/bin/env bun
// omastoic — the Stoics on your Omarchy screensaver.
//
// The native screensaver (omarchy-screensaver 1.3+) reads its text once, at
// start, from --input or else ~/.config/omarchy/branding/screensaver.txt.
// Omarchy's idle timer and System menu launch it with no arguments, so the
// quote they show is whatever is already in that branding file. Omastoic
// keeps the next quote there and writes a different one when the saver
// exits. It does not wrap or replace omarchy-launch-screensaver.
//
// Older Omarchy still runs ttfx in a terminal and rereads the branding file
// between effects. On that backend the daemon swaps quotes on the interval
// while a screensaver window is open.
//
// The screensaver art is one slot, and Omarchy's own commands own it too. So
// omastoic tracks what it wrote: if the file has changed underneath it — someone
// ran `omarchy branding screensaver image`, say — it stands aside instead of
// clobbering the new art.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { atomicWrite, digest, locked, OwnedFiles } from "./files.ts";
import { createBrandingSlot, ownsBranding as slotOwnsBranding, preserveDisplaced as slotPreserveDisplaced, rememberWrite as slotRememberWrite, restoreSlot as slotRestoreSlot, standAside as slotStandAside, writeSlot } from "./branding.ts";
import { dirname, join } from "node:path";
import { AUTHOR_SLUG, compose, indexBundled, indexCustom, loadArt, normalizeAuthorDates, parseAuthors, parseQuotes, pick, canonicalQuoteId, type Author, type BundledQuote, type Quote } from "./canvas.ts";
import { headerPortraitLayout, padPortrait, portraitDownscale, transcodePortrait } from "./portrait.ts";
import { pickPortraitImage, PORTRAIT_PICKER_EXIT } from "./file-picker.ts";
import { screensaverIsRunning, screensaverSize, screensaverWindowEvents, waitForLiveGrid } from "./hyprland.ts";
import {
  CALM_EFFECTS,
  explainLauncherFailure,
  nativeLaunchScript,
  previewEffects,
  screensaverBackend,
  type ScreensaverBackend,
} from "./screensaver.ts";
import { authorCompletionList, renderCompletion } from "./completions.ts";
import { hasBlock, withBlock, withoutBlock } from "./menu.ts";
import { ChunkSource, pickAuthors } from "./author-picker.ts";
import { pickQuotes, type QuoteRow } from "./quote-picker.ts";
import { askConfirm, askLine, askText } from "./line-prompt.ts";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "./plugin-id.ts";
import { renderCanvasPng, themeForeground } from "./png.ts";
import { parsePanelSizeCommand, readPanelSize, writePanelSize } from "./panel-size.ts";
import {
  checkedSystemctl,
  isTruthyEnv,
  isUnitActive,
  isUnitEnabled,
  querySystemctl,
  runSystemctl,
} from "./systemctl.ts";
import {
  applyQuoteFlags,
  authorsAfterRemoval,
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

function manifestVersion(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as { version?: unknown } | null;
  const version = typeof manifest === "object" && manifest !== null ? manifest.version : undefined;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("manifest.json has no version");
  }
  return version.trim();
}
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
const PRUNE_LIB = join(HOME, ".local/lib/omastoic");
const PRUNE_SCRIPT = join(PRUNE_LIB, "prune.sh");
const PRUNE_UNIT = join(CONFIG_HOME, "systemd/user/omastoic-prune.service");
const PRUNE_PATH = join(CONFIG_HOME, "systemd/user/omastoic-prune.path");
const PLUGINS_DIR = join(CONFIG_HOME, "omarchy/plugins");

const SETTINGS_FILE = join(USER_CONFIG, "config.json");
const USER_AUTHORS_FILE = join(USER_CONFIG, "authors.tsv");
const USER_ART_DIR = join(USER_CONFIG, "art");
const owned = new OwnedFiles(STATE);
const DISPLACED = join(STATE, "displaced.kind");
const PANEL_SIZE_FILE = join(STATE, "panel-size.json");

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

function readExisting(path: string): { missing: true } | { missing: false; text: string } {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    throw new Error(`could not read ${path}: ${(error as Error).message}`);
  }
  try { return { missing: false, text: readFileSync(path, "utf8") }; }
  catch (error) { throw new Error(`could not read ${path}: ${(error as Error).message}`); }
}

/** Settings for a write. Throws when an existing file cannot be read whole. */
async function loadSettings(): Promise<Settings> {
  const read = readExisting(SETTINGS_FILE);
  // Refuse to rewrite settings while custom authors cannot be parsed, so saved
  // custom slugs in config.json are not silently dropped.
  const customAuthorMap = await customAuthors();
  if (read.missing) return {};
  if (Buffer.byteLength(read.text) > 65536) throw new Error(`refusing to replace unreadable ${SETTINGS_FILE}`);
  let raw: unknown;
  try { raw = JSON.parse(read.text); }
  catch { throw new Error(`refusing to replace unreadable ${SETTINGS_FILE}`); }
  const merged = await bundledAuthors();
  for (const [slug, author] of customAuthorMap) {
    if (!merged.has(slug)) merged.set(slug, author);
  }
  const roster = [...merged.keys()];
  const custom = await indexedCustom();
  const catalog = [...choicesOf(await bundledBook()), ...choicesOf(custom.quotes)];
  return normalizeSettings(raw, roster, catalog, custom.readable);
}

async function config(): Promise<Settings> {
  try { return await loadSettings(); }
  catch {
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

async function daemonRotationDigest(bundled: BundledQuote[]): Promise<string> {
  const settings = await config();
  const custom = await indexedCustom();
  const activeQuotes = inRotation(bundled, custom.quotes, settings).quotes;
  const roster = await authors();
  const activeSlugs = [...new Set(activeQuotes.map((quote) => quote.author))].sort();
  const activeAuthors = await Promise.all(
    activeSlugs.map(async (slug) => {
      const meta = roster.get(slug);
      const art = await loadPortrait(slug);
      return [slug, meta?.name ?? "", meta?.dates ?? "", art ? digest(art.join("\n")) : ""];
    }),
  );
  return digest(
    JSON.stringify({
      interval: settings.interval ?? DEFAULT_INTERVAL,
      quotes: activeQuotes.map((quote) => [quote.author, quote.citation, quote.text]),
      authors: activeAuthors,
    }),
  );
}

async function restartDaemon(): Promise<void> {
  if (enabled() && (await Bun.file(UNIT).exists()) && isUnitActive("omastoic.service")) {
    await checkedSystemctl(["restart", "omastoic.service"]);
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

async function bundledAuthors(): Promise<Map<string, Author>> {
  return parseAuthors(await Bun.file(join(ROOT, "data/authors.tsv")).text());
}

async function customAuthors(): Promise<Map<string, Author>> {
  const read = readExisting(USER_AUTHORS_FILE);
  if (read.missing) return new Map();
  if (Buffer.byteLength(read.text) > 1024 * 1024) throw new Error("custom author file exceeds 1 MiB");
  return parseAuthors(read.text);
}

async function authors(): Promise<Map<string, Author>> {
  const merged = await bundledAuthors();
  try {
    for (const [slug, author] of await customAuthors()) {
      if (!merged.has(slug)) merged.set(slug, author);
    }
  } catch (error) {
    console.error(`omastoic: ignoring unreadable ${USER_AUTHORS_FILE}: ${(error as Error).message}`);
  }
  return merged;
}

async function loadPortrait(slug: string): Promise<string[] | null> {
  const bundled = await loadArt(join(ROOT, "art"), slug);
  if (bundled) return bundled;
  try {
    return await loadArt(USER_ART_DIR, slug);
  } catch (error) {
    console.error(`omastoic: ignoring unreadable portrait for ${slug}: ${(error as Error).message}`);
    return null;
  }
}

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

const keepLauncherLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() && !/socat\[\d+\].*Broken pipe/.test(line) && !line.startsWith("exited:"));

async function installedBackend(): Promise<ScreensaverBackend> {
  const launcher = Bun.which("omarchy-launch-screensaver");
  const text = launcher ? await Bun.file(launcher).text().catch(() => "") : "";
  return screensaverBackend(text, { ttfx: Boolean(Bun.which("ttfx")) });
}

/**
 * The terminal launcher exits once its windows are open. The native binary
 * is the screensaver and runs until dismissed, so preview must leave it in
 * its own session instead of waiting out the overlay.
 */
async function launchScreensaver(
  backend: Exclude<ScreensaverBackend, "missing">,
  effects: readonly string[] = CALM_EFFECTS,
): Promise<number> {
  if (!Bun.which("omarchy-launch-screensaver")) {
    console.error("omastoic: omarchy-launch-screensaver is missing");
    return 1;
  }
  if (backend === "native") return launchNative(effects);

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
  for (const line of keepLauncherLines(stdout)) console.log(line);
  for (const line of keepLauncherLines(stderr)) console.error(line);
  if (code === 0) console.log("→ screensaver");
  return code ?? 1;
}

async function launchNative(effects: readonly string[] = CALM_EFFECTS): Promise<number> {
  mkdirSync(STATE, { recursive: true });
  const errorLog = join(STATE, "launch.err");
  rmSync(errorLog, { force: true });
  const proc = Bun.spawn(["bash", "-c", nativeLaunchScript(BRANDING, errorLog, effects)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stdout.startsWith("running")) {
    console.log("→ screensaver");
    return 0;
  }
  const childError = await Bun.file(errorLog).text().catch(() => "");
  const explained = explainLauncherFailure(`${childError}\n${stderr}`);
  if (explained) {
    console.error(explained);
    return 1;
  }
  for (const line of keepLauncherLines(stdout)) console.log(line);
  for (const line of keepLauncherLines(`${stderr}\n${childError}`)) console.error(line);
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

const brandingSlot = createBrandingSlot({
  branding: BRANDING,
  backup: BACKUP,
  state: STATE,
  written: WRITTEN,
  displaced: DISPLACED,
  logo: LOGO,
  owned,
  setEnabled,
  notify,
  beforeReplace: () => {
    const hook = process.env.OMASTOIC_BEFORE_BRANDING_REPLACE;
    if (!hook) return;
    const ran = Bun.spawnSync(["bash", "-c", hook], { env: process.env });
    if (ran.exitCode !== 0) throw new Error("could not finish the screensaver restore");
  },
});

const rememberWrite = (canvas: string): void => slotRememberWrite(brandingSlot, canvas);
const ownsBranding = (): boolean => slotOwnsBranding(brandingSlot);
const preserveDisplaced = (): Promise<void> => slotPreserveDisplaced(brandingSlot);
const restoreSlot = (): Promise<void> => slotRestoreSlot(brandingSlot);
const standAside = (): void => slotStandAside(brandingSlot);

async function renderQuote(
  size?: { cols: number; rows: number },
  forced?: Quote,
): Promise<{ text: string; quote: Quote; recent: number[] }> {
  const quotes = await quoteBook();
  if (!quotes.length) throw new Error("the quote book is empty");

  const chosen = forced ? { quote: forced, recent: await recent() } : pick(quotes, await recent());
  const grid = size ?? (await screensaverSize());
  const art = await loadPortrait(chosen.quote.author);
  return {
    text: compose(chosen.quote, (await authors()).get(chosen.quote.author), {
      cols: grid.cols,
      rows: grid.rows,
      art,
    }),
    quote: chosen.quote,
    recent: chosen.recent,
  };
}

async function render(size?: { cols: number; rows: number }, remember = true, forced?: Quote): Promise<string> {
  const drawn = await renderQuote(size, forced);
  if (remember && !forced) atomicWrite(join(STATE, "recent.json"), JSON.stringify(drawn.recent));
  return drawn.text;
}

/** Replace the branding file in one step, so a running ttfx never reads a half-written canvas. */
async function writeBranding(takeSlot = false, forced?: Quote): Promise<Quote | null> {
  let recentIds: number[] | null = null;
  let writtenQuote: Quote | null = null;
  const wrote = await writeSlot(
    brandingSlot,
    async () => {
      const drawn = await renderQuote(undefined, forced);
      recentIds = drawn.recent;
      writtenQuote = drawn.quote;
      return `${drawn.text}\n`;
    },
    takeSlot,
  );
  if (wrote && !forced && recentIds) atomicWrite(join(STATE, "recent.json"), JSON.stringify(recentIds));
  return wrote ? writtenQuote : null;
}

async function stopDaemon(): Promise<void> {
  if (owned.owns("unit", UNIT)) await checkedSystemctl(["disable", "--now", "omastoic.service"]);
}

async function activate(forced?: Quote): Promise<{ code: number; quote: Quote | null }> {
  const wasEnabled = enabled();
  const previousCanvas = wasEnabled && ownsBranding() ? await Bun.file(BRANDING).text().catch(() => null) : null;
  await preserveDisplaced();

  let quote: Quote | null = null;
  try {
    setEnabled(true);
    quote = await writeBranding(true, forced);
    if (!quote) throw new Error("could not activate the Stoics");
    if (owned.owns("unit", UNIT)) await checkedSystemctl(["enable", "--now", "omastoic.service"]);
    else console.log("→ not installed as a service yet; run: omastoic setup");
  } catch (error) {
    setEnabled(wasEnabled);
    if (ownsBranding()) {
      if (previousCanvas !== null) {
        atomicWrite(BRANDING, previousCanvas);
        rememberWrite(previousCanvas);
      } else await restoreSlot();
    }
    throw error;
  }

  console.log("→ the Stoics have the screensaver");
  notify("Screensaver: the Stoics");
  return { code: 0, quote };
}

async function on(): Promise<number> {
  return (await activate()).code;
}

async function off(): Promise<number> {
  setEnabled(false);
  await stopDaemon();
  await restoreSlot();
  console.log("→ the Stoics have stood down");
  notify("Screensaver: the Stoics off");
  return 0;
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
Description=Keep a Stoic quote ready for the Omarchy screensaver
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
  if (owned.owns("prune-path", PRUNE_PATH)) await checkedSystemctl(["disable", "--now", "omastoic-prune.path"]);
  owned.remove("prune-path", PRUNE_PATH);
  owned.remove("prune-unit", PRUNE_UNIT);
  owned.remove("prune-script", PRUNE_SCRIPT);
  await checkedSystemctl(["daemon-reload"]);
}

async function requireOmarchy(): Promise<number> {
  if (!Bun.which("omarchy")) {
    console.error("omastoic: omarchy is not on PATH");
    return 1;
  }
  const required = ["jq", "python3", "flock", "omarchy-toggle", "omarchy-toggle-enabled", "omarchy-launch-screensaver"];
  if (!isTruthyEnv(process.env.OMASTOIC_NO_SYSTEMCTL)) required.unshift("systemctl");
  for (const command of required) {
    if (!Bun.which(command)) { console.error(`omastoic: required command missing: ${command}`); return 1; }
  }
  const backend = await installedBackend();
  if (backend === "missing") {
    console.error("omastoic: no screensaver backend — install omarchy-screensaver, or ttfx for the older terminal saver (omarchy pkg add ttfx)");
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
    let unitChanged = false;
    for (const [id, path, body, legacy] of artifacts) {
      const wrote = owned.write(id, path, body, legacy);
      changed = wrote || changed;
      if (id === "unit" && wrote) unitChanged = true;
    }
    chmodSync(PRUNE_SCRIPT, 0o755);
    await addMenuRows(opts.quiet);
    if (changed) await checkedSystemctl(["daemon-reload"]);
    await checkedSystemctl(["enable", "--now", "omastoic-prune.path"]);
    if (opts.onFirst && first) {
      const code = await on();
      if (code) throw new Error("could not activate the Stoics");
    } else if (enabled()) {
      const needsRestart = previous !== marker || unitChanged;
      const active = isUnitActive("omastoic.service");
      if (!isUnitEnabled("omastoic.service")) await checkedSystemctl(["enable", "omastoic.service"]);
      if (needsRestart && active) await checkedSystemctl(["restart", "omastoic.service"]);
      else if (!active) await checkedSystemctl(["start", "omastoic.service"]);
    } else if (isUnitActive("omastoic.service") || isUnitEnabled("omastoic.service")) {
      await stopDaemon();
    }
    atomicWrite(INSTALLED, marker); // Only successful setup is an installation.
  } catch (error) {
    // Leave owned plumbing available for retry/uninstall, but fail closed.
    await runSystemctl(["disable", "--now", "omastoic.service"]);
    await runSystemctl(["disable", "--now", "omastoic-prune.path"]);
    if (existsSync(WRITTEN) && ownsBranding()) await restoreSlot();
    setEnabled(false);
    throw error;
  }
  if ((await installedBackend()) === "native") say("→ a new quote each time the screensaver starts");
  else {
    const interval = (await config()).interval ?? DEFAULT_INTERVAL;
    say(`→ a new quote every ${interval}s while the screensaver is up`);
  }
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
  await checkedSystemctl(["daemon-reload"]);
  await removeMenuRows();
  unlinkLauncher();
  for (const [id, path] of completionFiles()) owned.remove(id, path);
  await removePrune();

  // restoreSlot already removed the backup when it put the old art back.
  // If the branding file changed, that backup has to stay.
  await Bun.file(INSTALLED).delete().catch(() => {});

  if (opts.purge) {
    rmSync(USER_CONFIG, { recursive: true, force: true });
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
  // Runtime files are not user quotes. The lock file stays: this command is
  // holding it until it exits, and replacing it would change the inode.
  sweepRuntimeState();
  return 0;
}

function sweepRuntimeState(): void {
  if (existsSync(STATE)) {
    for (const name of readdirSync(STATE)) {
      if (name === "transaction.flock") continue;
      rmSync(join(STATE, name), { recursive: true, force: true });
    }
  }
  try { rmdirSync(PRUNE_LIB); } catch { /* missing, or the user left something else there */ }
}

// --- the rotation service -----------------------------------------------------

async function intervalMs(): Promise<number> {
  return ((await config()).interval ?? DEFAULT_INTERVAL) * 1000;
}

async function brandingDigest(): Promise<string | null> {
  try {
    return digest(await Bun.file(BRANDING).text());
  } catch {
    return null;
  }
}

/** Write the next canvas when we still own the slot. `onStop` clears a terminal rotation timer. */
async function rotate(onStop?: () => void): Promise<boolean> {
  await locked(STATE, async () => {
    if (enabled()) await writeBranding();
  }).catch((err) => { console.error(`omastoic: ${err.message}`); });
  if (!enabled()) {
    onStop?.();
    return false;
  }
  if (!ownsBranding()) {
    standAside();
    onStop?.();
    return false;
  }
  return true;
}

/**
 * The native saver has already read its text by the time its process is
 * visible. Watch for it to leave, then write the quote the next start will
 * read. A quote written while it was up (`omastoic next`) is kept.
 */
async function daemonNative(): Promise<number> {
  if (!enabled()) {
    console.log("omastoic: parked (omastoic toggle to bring the Stoics back)");
    return 0;
  }

  let running = screensaverIsRunning();
  let shown: string | null = running ? await brandingDigest() : null;
  if (!running && !(await rotate())) return 0;

  while (true) {
    await Bun.sleep(400);
    if (!enabled()) return 0;
    const now = screensaverIsRunning();
    if (!now && !ownsBranding()) {
      standAside();
      return 0;
    }
    if (!running && now) shown = await brandingDigest();
    if (running && !now) {
      const current = await brandingDigest();
      // Unchanged, or removed: the next start needs a new canvas. A different
      // digest is either `next` or someone else's art; the idle check stands
      // aside when we no longer own it.
      if ((current === null || current === shown) && !(await rotate())) return 0;
      shown = null;
    }
    running = now;
  }
}

async function daemon(): Promise<number> {
  if ((await installedBackend()) === "native") return daemonNative();
  if (!enabled()) {
    console.log("omastoic: parked (omastoic toggle to bring the Stoics back)");
    return 0;
  }

  const open = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopRotating = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const tick = async () => {
    timer = null;
    if (!(await rotate(stopRotating))) return;
    if (open.size === 0) return;
    timer = setTimeout(tick, await intervalMs());
  };

  const startRotating = async () => {
    if (timer) return;
    timer = setTimeout(tick, await intervalMs());
  };

  // Leave a fresh quote sitting in the file so the very first frame of the next
  // screensaver is already new, without racing the ttfx that is about to read it.
  await rotate(stopRotating);

  for await (const event of screensaverWindowEvents()) {
    if (event.kind === "sync") {
      open.clear();
      for (const address of event.addresses) open.add(address);
      if (open.size) await startRotating();
      else stopRotating();
    } else if (event.kind === "open") {
      if (open.has(event.address)) continue;
      const alreadyReading = open.size > 0;
      open.add(event.address);
      if (enabled()) {
        // ttfx measures the tty at start; wait until it has left 80x24, then
        // write a canvas that matches the real grid before the first effect.
        if (!alreadyReading) {
          await waitForLiveGrid();
          await rotate(stopRotating);
        }
        await startRotating();
      }
    } else if (open.delete(event.address) && open.size === 0) {
      stopRotating();
      await rotate(stopRotating);
    }
  }
  return 0;
}

// --- configure ----------------------------------------------------------------

const CONFIG_VALUE_FLAGS = new Set([
  "--authors", "--interval", "--quotes", "--add", "--add-author",
  "--replace-author", "--remove-author", "--name", "--dates",
  "--image", "--citation", "--text",
]);
const CONFIG_BOOL_FLAGS = new Set(["--list", "--plain"]);
const CONFIG_FLAGS = new Set([...CONFIG_VALUE_FLAGS, ...CONFIG_BOOL_FLAGS]);

type ParsedConfigFlags = {
  values: Map<string, Array<string | undefined>>;
  bools: Set<string>;
};

function parseConfigFlags(rest: string[]): ParsedConfigFlags {
  const values = new Map<string, Array<string | undefined>>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (CONFIG_BOOL_FLAGS.has(arg)) {
      bools.add(arg);
      continue;
    }
    if (CONFIG_VALUE_FLAGS.has(arg)) {
      const next = i + 1 < rest.length ? rest[i + 1]! : undefined;
      const hasValue = next !== undefined && !CONFIG_FLAGS.has(next);
      const list = values.get(arg) ?? [];
      list.push(hasValue ? next : undefined);
      values.set(arg, list);
      if (hasValue) i += 1;
    }
  }
  return { values, bools };
}

async function pickAuthorList(roster: Map<string, { name: string }>, selected: string[], io: ConfigIo): Promise<string[] | undefined> {
  const rows = [...roster].map(([slug, author]) => ({ slug, name: author.name }));
  return pickAuthors(rows, selected, { ...io, plain: io.plain });
}

/** Everything `config` asks shares one reader, so a piped answer is never dropped. */
type ConfigIo = { input: typeof process.stdin; output: typeof process.stdout; signals: typeof process; plain: boolean; source: ChunkSource; fatal: (signal: string) => void };

/** The prompt has handed the terminal back; die by the signal that interrupted it. */
function raiseSignal(signal: string): void {
  process.kill(process.pid, signal === "SIGHUP" ? "SIGHUP" : "SIGTERM");
}

function configIo(plain: boolean): ConfigIo {
  return { input: process.stdin, output: process.stdout, signals: process, plain, source: new ChunkSource(process.stdin), fatal: raiseSignal };
}

async function pickInterval(current: number, io: ConfigIo): Promise<number | undefined> {
  const header = "Seconds between quotes while the screensaver is up";
  const answer = await askLine(
    { header, value: String(current), charLimit: 8 },
    io,
  );
  if (answer == null) return undefined;
  const n = parseInterval(answer.trim());
  if (n == null) {
    console.error(`omastoic: interval must be a whole number of seconds from 1 to 3600`);
    return undefined;
  }
  return n;
}

/** A bundled or custom quote as the quote picker shows it: the id is the key. */
function quoteRows(choices: BundledQuote[]): QuoteRow[] {
  return choices.map((quote) => ({ id: quote.id, citation: quote.citation, text: quote.text }));
}

async function pickQuoteList(name: string, choices: BundledQuote[], selected: string[] | null, io: ConfigIo): Promise<string[] | undefined> {
  return pickQuotes(name, quoteRows(choices), selected, io);
}

/** The quote picker is the id-keyed checklist; the labels live in quote-picker.ts. */

const QUOTE_HEADER = "# author-slug <TAB> citation <TAB> text\n";
const AUTHORS_HEADER = "# slug <TAB> display name <TAB> dates\n";

type PromptedQuote = { kind: "quote"; quote: Quote } | { kind: "cancel" } | { kind: "invalid" };
type NewAuthorInput = {
  slug: string;
  name: string;
  dates?: string;
  image: string;
  quotes: Array<{ citation: string; text: string }>;
};
type PromptedAuthor = { kind: "author"; input: NewAuthorInput } | { kind: "cancel" };

/** Collapse tabs and newlines so an answer stays one quotes.tsv row. */
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

function addAuthorUsage(): void {
  console.error("omastoic: --add-author needs a slug, --name, --image (JPEG or PNG), and at least one quote");
  console.error("          omastoic config --add-author");
  console.error("          omastoic config --add-author musonius --name \"Musonius Rufus\" --dates \"c. AD 30 – 100\" --image portrait.jpg --citation \"Lectures VI\" --text \"Your line.\"");
  console.error("          omastoic config --add-author musonius --name \"Musonius Rufus\" --image portrait.png --add $'musonius\\tLectures VI\\tYour line.'");
}

function replaceAuthorUsage(): void {
  console.error("omastoic: --replace-author needs a custom author slug and at least one field to update");
  console.error("          omastoic config --replace-author musonius --image new.jpg");
  console.error("          omastoic config --replace-author musonius --name \"Musonius Rufus\" --dates \"c. AD 30 – 100\" --citation \"Lectures VI\" --text \"Your line.\"");
}

function removeAuthorUsage(): void {
  console.error("omastoic: --remove-author needs a custom author slug");
  console.error("          omastoic config --remove-author musonius");
}

async function promptNewAuthor(io: ConfigIo): Promise<PromptedAuthor> {
  const slug = await askLine({ header: "Author slug", value: "", charLimit: 64 }, io);
  if (slug == null) return { kind: "cancel" };
  const name = await askLine({ header: "Display name", value: "", charLimit: 128 }, io);
  if (name == null) return { kind: "cancel" };
  const dates = await askLine({ header: "Dates (optional)", value: "", charLimit: 128 }, io);
  if (dates == null) return { kind: "cancel" };
  const image = await askLine({ header: "Portrait image (JPEG or PNG)", value: "", charLimit: 1024 }, io);
  if (image == null) return { kind: "cancel" };
  const citation = await askLine({ header: "Citation", value: "", charLimit: 256 }, io);
  if (citation == null) return { kind: "cancel" };
  const text = await askText({ header: "Quote text (ctrl-d to finish)", value: "", charLimit: 4096 }, io);
  if (text == null) return { kind: "cancel" };
  return {
    kind: "author",
    input: {
      slug,
      name,
      dates,
      image,
      quotes: [{ citation, text }],
    },
  };
}

type ValidatedNewAuthor = { author: Author; quotes: Quote[]; image: string };

/** Validate author metadata, quotes and bundled-slug collisions before transcoding. */
async function validateNewAuthorInput(
  input: NewAuthorInput,
): Promise<{ ok: true; value: ValidatedNewAuthor } | { ok: false; error: string }> {
  const slug = flatField(input.slug);
  const name = flatField(input.name);
  const dates = normalizeAuthorDates(flatField(input.dates ?? ""));
  const image = input.image.trim();

  if (!slug || !AUTHOR_SLUG.test(slug)) {
    return { ok: false, error: "invalid author slug (use lowercase letters, digits, _ or -, up to 64 characters)" };
  }
  if (slug === "all") {
    return { ok: false, error: "\"all\" is reserved and cannot be used as an author slug" };
  }
  const bundled = await bundledAuthors();
  if (bundled.has(slug)) {
    return { ok: false, error: `author "${slug}" is already a bundled author` };
  }
  if (!name) return { ok: false, error: "author needs a display name" };
  if (name.length > 128) return { ok: false, error: "author display name must be at most 128 characters" };
  if (dates.length > 128) return { ok: false, error: "author dates must be at most 128 characters" };

  let author: Author;
  try {
    const parsed = parseAuthors(`${slug}\t${name}\t${dates}\n`).get(slug);
    if (!parsed) return { ok: false, error: "invalid author metadata" };
    author = parsed;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  if (!input.quotes.length) return { ok: false, error: "adding an author requires at least one quote" };
  const parsedQuotes: Quote[] = [];
  for (const item of input.quotes) {
    const citation = flatField(item.citation);
    const text = flatField(item.text);
    if (!citation || !text) return { ok: false, error: "each quote needs a citation and text" };
    try {
      const rows = parseQuotes(`${slug}\t${citation}\t${text}\n`);
      if (rows.length !== 1) return { ok: false, error: "each quote needs a citation and text" };
      parsedQuotes.push(rows[0]);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  if (!image) return { ok: false, error: "author needs a portrait image (JPEG or PNG)" };
  return { ok: true, value: { author, quotes: parsedQuotes, image } };
}

/**
 * Commit a validated author and pre-transcoded portrait under the state lock.
 * Checks existing user files before writing and rolls back (including any newly
 * created art/ directory) if a later write fails.
 */
async function commitNewAuthor(
  validated: ValidatedNewAuthor,
  artText: string,
  quiet = false,
  source: "cli" | "panel" = "cli",
): Promise<{ ok: true; author: Author; quotes: Quote[] } | { ok: false; error: string }> {
  const { author, quotes: parsedQuotes } = validated;
  const slug = author.slug;

  let existingAuthorsText = "";
  let hadAuthorsFile = false;
  try {
    const read = readExisting(USER_AUTHORS_FILE);
    hadAuthorsFile = !read.missing;
    existingAuthorsText = read.missing ? "" : read.text;
    const existingAuthors = existingAuthorsText ? parseAuthors(existingAuthorsText) : new Map<string, Author>();
    if (existingAuthors.has(slug)) {
      return {
        ok: false,
        error: source === "panel"
          ? `"${slug}" already exists. Use Edit on that author to update it.`
          : `author "${slug}" already exists in ${USER_AUTHORS_FILE}. Use --replace-author ${slug} to update it.`,
      };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const authorBody = existingAuthorsText === ""
    ? AUTHORS_HEADER
    : existingAuthorsText.endsWith("\n") ? existingAuthorsText : `${existingAuthorsText}\n`;
  const nextAuthorsText = `${authorBody}${author.slug}\t${author.name}\t${author.dates}\n`;
  if (Buffer.byteLength(nextAuthorsText) > 1024 * 1024) {
    return { ok: false, error: "custom author file exceeds 1 MiB" };
  }

  const quotesPath = join(USER_CONFIG, "quotes.tsv");
  let existingQuotesText = "";
  let haveQuotes: Quote[] = [];
  try {
    const read = readExisting(quotesPath);
    existingQuotesText = read.missing ? "" : read.text;
    haveQuotes = existingQuotesText ? parseQuotes(existingQuotesText) : [];
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const seenQuotes = new Set(haveQuotes.map(quoteRow));
  const newQuoteRows: string[] = [];
  for (const quote of parsedQuotes) {
    const row = quoteRow(quote);
    if (seenQuotes.has(row)) {
      return { ok: false, error: `that quote is already in ${quotesPath}` };
    }
    seenQuotes.add(row);
    newQuoteRows.push(`${row}\n`);
  }
  const quoteBody = existingQuotesText === ""
    ? QUOTE_HEADER
    : existingQuotesText.endsWith("\n") ? existingQuotesText : `${existingQuotesText}\n`;
  const nextQuotesText = `${quoteBody}${newQuoteRows.join("")}`;
  if (Buffer.byteLength(nextQuotesText) > 1024 * 1024) {
    return { ok: false, error: "custom quote file exceeds 1 MiB" };
  }

  const artPath = join(USER_ART_DIR, `${slug}.txt`);
  let hadArtFile = false;
  let existingArtText = "";
  try {
    const existingArt = readExisting(artPath);
    hadArtFile = !existingArt.missing;
    existingArtText = existingArt.missing ? "" : existingArt.text;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const hadArtDir = existsSync(USER_ART_DIR);
  const cleanupArtDir = () => {
    if (!hadArtDir) {
      try { rmdirSync(USER_ART_DIR); } catch { /* not empty or already gone */ }
    }
  };
  const rollbackArt = () => {
    if (hadArtFile) atomicWrite(artPath, existingArtText);
    else {
      rmSync(artPath, { force: true });
      cleanupArtDir();
    }
  };

  mkdirSync(USER_ART_DIR, { recursive: true });
  try {
    atomicWrite(artPath, artText);
  } catch (error) {
    cleanupArtDir();
    throw error;
  }
  try {
    atomicWrite(USER_AUTHORS_FILE, nextAuthorsText);
  } catch (error) {
    rollbackArt();
    throw error;
  }
  try {
    atomicWrite(quotesPath, nextQuotesText);
  } catch (error) {
    if (hadAuthorsFile) atomicWrite(USER_AUTHORS_FILE, existingAuthorsText);
    else rmSync(USER_AUTHORS_FILE, { force: true });
    rollbackArt();
    throw error;
  }

  if (!quiet) {
    console.log(`→ added author ${author.name} (${author.slug}) with portrait and ${parsedQuotes.length} ${parsedQuotes.length === 1 ? "quote" : "quotes"}`);
  }
  return { ok: true, author, quotes: parsedQuotes };
}

type ReplaceAuthorInput = {
  slug: string;
  name?: string;
  dates?: string;
  image?: string;
  quotes?: Array<{ citation: string; text: string }>;
};

type ValidatedReplaceAuthor = {
  slug: string;
  name?: string;
  dates?: string;
  image?: string;
  quotes?: Quote[];
};

function splitTsvLines(existingText: string): string[] {
  const normalized = existingText.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function replaceAuthorInTsv(existingText: string, author: Author): string {
  const row = `${author.slug}\t${author.name}\t${author.dates}`;
  let inserted = false;
  const out: string[] = [];
  for (const line of splitTsvLines(existingText)) {
    if (!line.trim() || line.startsWith("#")) {
      out.push(line);
      continue;
    }
    const fields = line.split("\t");
    if (fields[0]?.trim() === author.slug) {
      if (!inserted) {
        out.push(row);
        inserted = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!inserted) {
    if (out.length === 0) out.push(AUTHORS_HEADER.slice(0, -1));
    out.push(row);
  }
  return `${out.join("\n")}\n`;
}

function removeAuthorFromTsv(existingText: string, slug: string): { text: string; removed: boolean } {
  let removed = false;
  const out: string[] = [];
  for (const line of splitTsvLines(existingText)) {
    if (!line.trim() || line.startsWith("#")) {
      out.push(line);
      continue;
    }
    const fields = line.split("\t");
    if (fields[0]?.trim() === slug) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  return { text: out.length ? `${out.join("\n")}\n` : "", removed };
}

function replaceAuthorQuotesInTsv(existingText: string, slug: string, newQuotes: Quote[]): string {
  const rows = newQuotes.map(quoteRow);
  let inserted = false;
  const out: string[] = [];
  for (const line of splitTsvLines(existingText)) {
    if (!line.trim() || line.startsWith("#")) {
      out.push(line);
      continue;
    }
    const fields = line.split("\t");
    if (fields[0]?.trim() === slug) {
      if (!inserted) {
        out.push(...rows);
        inserted = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!inserted) {
    if (out.length === 0) out.push(QUOTE_HEADER.slice(0, -1));
    out.push(...rows);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Remap saved `cNN` quote ids after removing or replacing `resetSlug`'s rows in
 * quotes.tsv. Drops `resetSlug`'s own allow-list and keeps `c00` cleared state
 * intact for other authors.
 */
function remapCustomQuoteIds(
  settings: Settings,
  beforeCustom: BundledQuote[],
  afterCustom: BundledQuote[],
  resetSlug: string,
): Settings {
  if (!settings.quotes) return settings;
  const afterIdsByRow = new Map<string, string[]>();
  for (const quote of afterCustom) {
    if (quote.author === resetSlug) continue;
    const key = quoteRow(quote);
    const list = afterIdsByRow.get(key) ?? [];
    list.push(quote.id);
    afterIdsByRow.set(key, list);
  }
  const idMap = new Map<string, string>();
  for (const quote of beforeCustom) {
    if (quote.author === resetSlug) continue;
    const list = afterIdsByRow.get(quoteRow(quote));
    const nextId = list?.shift();
    if (nextId) idMap.set(quote.id, nextId);
  }
  const quotes: Record<string, string[]> = {};
  for (const [author, ids] of Object.entries(settings.quotes)) {
    if (author === resetSlug) continue;
    const hadCustom = ids.some((id) => id.startsWith("c"));
    const mapped = ids.flatMap((id) => {
      if (id === "c00") return ["c00"];
      if (id.startsWith("c")) return idMap.has(id) ? [idMap.get(id)!] : [];
      return [id];
    });
    if (hadCustom && !mapped.some((id) => id.startsWith("c"))) mapped.push("c00");
    quotes[author] = mapped;
  }
  return { ...settings, quotes: Object.keys(quotes).length ? quotes : undefined };
}

async function checkEditableCustomSlug(
  rawSlug: string,
  action: "replaced" | "removed",
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const slug = flatField(rawSlug);
  if (!slug || !AUTHOR_SLUG.test(slug)) {
    return { ok: false, error: "invalid author slug (use lowercase letters, digits, _ or -, up to 64 characters)" };
  }
  if (slug === "all") {
    return { ok: false, error: "\"all\" is reserved and cannot be used as an author slug" };
  }
  const bundled = await bundledAuthors();
  if (bundled.has(slug)) {
    return { ok: false, error: `author "${slug}" is a bundled author and cannot be ${action}` };
  }
  try {
    const customMap = await customAuthors();
    if (!customMap.has(slug)) {
      return { ok: false, error: `author "${slug}" is not a custom author` };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, slug };
}

async function validateReplaceAuthorInput(
  input: ReplaceAuthorInput,
  source: "cli" | "panel" = "cli",
): Promise<{ ok: true; value: ValidatedReplaceAuthor } | { ok: false; error: string }> {
  const checkedSlug = await checkEditableCustomSlug(input.slug, "replaced");
  if (!checkedSlug.ok) return checkedSlug;
  const slug = checkedSlug.slug;

  const hasName = input.name !== undefined;
  const hasDates = input.dates !== undefined;
  const hasImage = input.image !== undefined;
  const hasQuotes = input.quotes !== undefined;
  if (!hasName && !hasDates && !hasImage && !hasQuotes) {
    return {
      ok: false,
      error: source === "panel"
        ? "Change the portrait, name, dates, or quote first."
        : "replace requires at least one change (--image, --name, --dates, or quotes via --citation/--text or --add)",
    };
  }

  let cleanName: string | undefined;
  if (hasName) {
    cleanName = flatField(input.name!);
    if (!cleanName) return { ok: false, error: "author needs a display name" };
    if (cleanName.length > 128) return { ok: false, error: "author display name must be at most 128 characters" };
    try {
      parseAuthors(`${slug}\t${cleanName}\t\n`);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  let cleanDates: string | undefined;
  if (hasDates) {
    cleanDates = normalizeAuthorDates(flatField(input.dates!));
    if (cleanDates.length > 128) return { ok: false, error: "author dates must be at most 128 characters" };
    try {
      parseAuthors(`${slug}\tPlaceholder\t${cleanDates}\n`);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  let cleanImage: string | undefined;
  if (hasImage) {
    cleanImage = input.image!.trim();
    if (!cleanImage) return { ok: false, error: "author portrait image path cannot be empty" };
  }

  let parsedQuotes: Quote[] | undefined;
  if (hasQuotes) {
    if (!input.quotes!.length) return { ok: false, error: "replacement quotes cannot be empty" };
    parsedQuotes = [];
    const seen = new Set<string>();
    for (const item of input.quotes!) {
      const citation = flatField(item.citation);
      const text = flatField(item.text);
      if (!citation || !text) return { ok: false, error: "each quote needs a citation and text" };
      let rows: Quote[];
      try {
        rows = parseQuotes(`${slug}\t${citation}\t${text}\n`);
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
      if (rows.length !== 1) return { ok: false, error: "each quote needs a citation and text" };
      const key = quoteRow(rows[0]);
      if (seen.has(key)) return { ok: false, error: "duplicate quote in replace request" };
      seen.add(key);
      parsedQuotes.push(rows[0]);
    }
  }

  return {
    ok: true,
    value: { slug, name: cleanName, dates: cleanDates, image: cleanImage, quotes: parsedQuotes },
  };
}

/**
 * Commit a validated replacement for an existing custom author under the state
 * lock, rolling back all modified files if any write fails.
 */
async function commitReplaceAuthor(
  validated: ValidatedReplaceAuthor,
  artText: string | null,
  currentSettings: Settings,
  quiet = false,
): Promise<
  | { ok: true; author: Author; nextSettings: Settings; settingsRemapped: boolean; quotesChanged: boolean; rollback: () => void }
  | { ok: false; error: string }
> {
  const { slug } = validated;
  let existingAuthorsText = "";
  let prevAuthor: Author;
  try {
    const read = readExisting(USER_AUTHORS_FILE);
    existingAuthorsText = read.missing ? "" : read.text;
    const existingAuthors = existingAuthorsText ? parseAuthors(existingAuthorsText) : new Map<string, Author>();
    const found = existingAuthors.get(slug);
    if (!found) return { ok: false, error: `author "${slug}" is not a custom author` };
    prevAuthor = found;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const nextAuthor: Author = {
    slug,
    name: validated.name ?? prevAuthor.name,
    dates: validated.dates ?? prevAuthor.dates,
  };
  const authorsChanged = validated.name !== undefined || validated.dates !== undefined;
  let nextAuthorsText = existingAuthorsText;
  if (authorsChanged) {
    try {
      parseAuthors(`${nextAuthor.slug}\t${nextAuthor.name}\t${nextAuthor.dates}\n`);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    nextAuthorsText = replaceAuthorInTsv(existingAuthorsText, nextAuthor);
    if (Buffer.byteLength(nextAuthorsText) > 1024 * 1024) {
      return { ok: false, error: "custom author file exceeds 1 MiB" };
    }
  }

  const quotesPath = join(USER_CONFIG, "quotes.tsv");
  let hadQuotesFile = false;
  let existingQuotesText = "";
  let nextQuotesText = "";
  let beforeCustom: BundledQuote[] = [];
  let afterCustom: BundledQuote[] = [];
  const quotesChanged = validated.quotes !== undefined;
  if (quotesChanged) {
    try {
      const read = readExisting(quotesPath);
      hadQuotesFile = !read.missing;
      existingQuotesText = read.missing ? "" : read.text;
      const beforeQuotes = existingQuotesText ? parseQuotes(existingQuotesText) : [];
      nextQuotesText = replaceAuthorQuotesInTsv(existingQuotesText, slug, validated.quotes!);
      if (Buffer.byteLength(nextQuotesText) > 1024 * 1024) {
        return { ok: false, error: "custom quote file exceeds 1 MiB" };
      }
      beforeCustom = indexCustom(beforeQuotes);
      afterCustom = indexCustom(parseQuotes(nextQuotesText));
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  const artPath = join(USER_ART_DIR, `${slug}.txt`);
  let hadArtFile = false;
  let existingArtText = "";
  const artChanged = artText !== null;
  if (artChanged) {
    try {
      const existingArt = readExisting(artPath);
      hadArtFile = !existingArt.missing;
      existingArtText = existingArt.missing ? "" : existingArt.text;
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  const hadArtDir = existsSync(USER_ART_DIR);
  const cleanupArtDir = () => {
    if (!hadArtDir) {
      try { rmdirSync(USER_ART_DIR); } catch { /* not empty or already gone */ }
    }
  };

  let wroteArt = false;
  let wroteAuthors = false;
  let wroteQuotes = false;
  const rollback = () => {
    if (wroteQuotes) {
      try {
        if (hadQuotesFile) atomicWrite(quotesPath, existingQuotesText);
        else rmSync(quotesPath, { force: true });
      } catch { /* best-effort restore */ }
    }
    if (wroteAuthors) {
      try {
        atomicWrite(USER_AUTHORS_FILE, existingAuthorsText);
      } catch { /* best-effort restore */ }
    }
    if (wroteArt) {
      try {
        if (hadArtFile) atomicWrite(artPath, existingArtText);
        else {
          rmSync(artPath, { force: true });
          cleanupArtDir();
        }
      } catch { /* best-effort restore */ }
    }
  };

  try {
    if (artChanged) {
      mkdirSync(USER_ART_DIR, { recursive: true });
      atomicWrite(artPath, artText);
      wroteArt = true;
    }
    if (authorsChanged) {
      atomicWrite(USER_AUTHORS_FILE, nextAuthorsText);
      wroteAuthors = true;
    }
    if (quotesChanged) {
      atomicWrite(quotesPath, nextQuotesText);
      wroteQuotes = true;
    }
  } catch (error) {
    rollback();
    cleanupArtDir();
    throw error;
  }

  const nextSettings = quotesChanged
    ? remapCustomQuoteIds(currentSettings, beforeCustom, afterCustom, slug)
    : currentSettings;
  const settingsRemapped = quotesChanged && JSON.stringify(nextSettings) !== JSON.stringify(currentSettings);

  if (!quiet) {
    console.log(`→ replaced author ${nextAuthor.name} (${slug})`);
  }
  return { ok: true, author: nextAuthor, nextSettings, settingsRemapped, quotesChanged, rollback };
}

/**
 * Remove a custom author row, their quotes, their art file, and their slug
 * from saved settings under the state lock, rolling back on failure.
 */
type RemoveAuthorOverrides = {
  authors?: string[];
  quotes?: Record<string, string[]>;
};

async function commitRemoveAuthor(
  rawSlug: string,
  currentSettings: Settings,
  bundled: BundledQuote[],
  quiet = false,
  overrides?: RemoveAuthorOverrides,
): Promise<
  | { ok: true; author: Author; nextSettings: Settings; settingsSaved: boolean; fallbackAuthor: Author | null; rollback: () => void }
  | { ok: false; error: string }
> {
  const checkedSlug = await checkEditableCustomSlug(rawSlug, "removed");
  if (!checkedSlug.ok) return checkedSlug;
  const slug = checkedSlug.slug;

  let existingAuthorsText = "";
  let removedAuthor: Author;
  try {
    const read = readExisting(USER_AUTHORS_FILE);
    existingAuthorsText = read.missing ? "" : read.text;
    const existingAuthors = existingAuthorsText ? parseAuthors(existingAuthorsText) : new Map<string, Author>();
    const found = existingAuthors.get(slug);
    if (!found) return { ok: false, error: `author "${slug}" is not a custom author` };
    removedAuthor = found;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const nextAuthorsText = removeAuthorFromTsv(existingAuthorsText, slug).text;
  const nextCustomAuthors = nextAuthorsText ? parseAuthors(nextAuthorsText) : new Map<string, Author>();
  const bundledMap = await bundledAuthors();
  const nextRosterMap = new Map<string, Author>(bundledMap);
  for (const [key, author] of nextCustomAuthors) {
    if (!nextRosterMap.has(key)) nextRosterMap.set(key, author);
  }
  const nextRoster = [...nextRosterMap.keys()];

  const quotesPath = join(USER_CONFIG, "quotes.tsv");
  let existingQuotesText = "";
  let nextQuotesText = "";
  let quotesChanged = false;
  let beforeCustom: BundledQuote[] = [];
  let afterCustom: BundledQuote[] = [];
  try {
    const read = readExisting(quotesPath);
    if (!read.missing) {
      existingQuotesText = read.text;
      const beforeQuotes = existingQuotesText ? parseQuotes(existingQuotesText) : [];
      const stripped = removeAuthorFromTsv(existingQuotesText, slug);
      nextQuotesText = stripped.text;
      quotesChanged = stripped.removed;
      beforeCustom = indexCustom(beforeQuotes);
      afterCustom = indexCustom(nextQuotesText ? parseQuotes(nextQuotesText) : []);
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const artPath = join(USER_ART_DIR, `${slug}.txt`);
  let hadArtFile = false;
  let existingArtText = "";
  try {
    const stat = lstatSync(artPath);
    if (!stat.isFile()) {
      return { ok: false, error: `refusing to remove non-file: ${artPath}` };
    }
    existingArtText = readFileSync(artPath, "utf8");
    hadArtFile = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, error: `could not inspect ${artPath}: ${(error as Error).message}` };
    }
  }

  let nextSettings: Settings = remapCustomQuoteIds({ ...currentSettings }, beforeCustom, afterCustom, slug);
  const nextCatalog = [...choicesOf(bundled), ...choicesOf(afterCustom)];
  if (overrides && Object.hasOwn(overrides, "quotes")) {
    nextSettings.quotes = overrides.quotes;
  }
  let fallbackAuthor: Author | null = null;
  if (overrides?.authors !== undefined) {
    nextSettings.authors = overrides.authors;
  } else {
    const resolved = authorsAfterRemoval(
      nextSettings.authors,
      slug,
      nextRoster,
      nextCatalog,
      nextSettings.quotes,
    );
    nextSettings.authors = resolved.authors;
    if (resolved.fallback) {
      fallbackAuthor = nextRosterMap.get(resolved.fallback) ?? { slug: resolved.fallback, name: resolved.fallback, dates: "" };
    }
  }

  let hadSettingsFile = false;
  let existingSettingsText = "";
  try {
    const settingsRead = readExisting(SETTINGS_FILE);
    hadSettingsFile = !settingsRead.missing;
    existingSettingsText = settingsRead.missing ? "" : settingsRead.text;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const compactedNext = compactSettings(nextSettings, nextRoster, nextCatalog, true);
  const nextSettingsJson = `${JSON.stringify(compactedNext, null, 2)}\n`;
  const settingsNeedsSave =
    (hadSettingsFile && existingSettingsText !== nextSettingsJson) ||
    (!hadSettingsFile && Object.keys(compactedNext).length > 0);

  let wroteAuthors = false;
  let wroteQuotes = false;
  let wroteSettings = false;
  let removedArt = false;
  const rollback = () => {
    if (removedArt) {
      try { atomicWrite(artPath, existingArtText); } catch { /* best-effort restore */ }
    }
    if (wroteSettings) {
      try {
        if (hadSettingsFile) atomicWrite(SETTINGS_FILE, existingSettingsText);
        else rmSync(SETTINGS_FILE, { force: true });
      } catch { /* best-effort restore */ }
    }
    if (wroteQuotes) {
      try { atomicWrite(quotesPath, existingQuotesText); } catch { /* best-effort restore */ }
    }
    if (wroteAuthors) {
      try { atomicWrite(USER_AUTHORS_FILE, existingAuthorsText); } catch { /* best-effort restore */ }
    }
  };
  try {
    atomicWrite(USER_AUTHORS_FILE, nextAuthorsText);
    wroteAuthors = true;
    if (quotesChanged) {
      atomicWrite(quotesPath, nextQuotesText);
      wroteQuotes = true;
    }
    if (settingsNeedsSave) {
      await saveSettings(nextSettings, nextRoster, nextCatalog, true);
      wroteSettings = true;
    }
    if (hadArtFile) {
      rmSync(artPath);
      removedArt = true;
    }
  } catch (error) {
    rollback();
    throw error;
  }

  if (!quiet) {
    console.log(`→ removed author ${removedAuthor.name} (${slug})`);
    if (fallbackAuthor) {
      console.log(`→ ${removedAuthor.name} was the only selected author. Rotation is now ${fallbackAuthor.name}.`);
    }
  }
  return { ok: true, author: removedAuthor, nextSettings, settingsSaved: settingsNeedsSave, fallbackAuthor, rollback };
}

async function promptCustomQuote(io: ConfigIo): Promise<PromptedQuote> {
  const author = await askLine({ header: "Author slug", value: "marcus", charLimit: 64 }, io);
  if (author == null) return { kind: "cancel" };
  const citation = await askLine({ header: "Citation", value: "Meditations IX.1", charLimit: 256 }, io);
  if (citation == null) return { kind: "cancel" };
  const text = await askText({ header: "Quote text (ctrl-d to finish)", value: "Your line.", charLimit: 4096 }, io);
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

async function offerCustomQuote(io: ConfigIo): Promise<PromptedQuote | { kind: "skip" } | { kind: "abort" }> {
  const answer = await askConfirm("Add a custom quote?", io);
  if (answer == null) return { kind: "abort" };
  if (!answer) return { kind: "skip" };
  return promptCustomQuote(io);
}

async function appendQuotes(lines: string[], quiet = false): Promise<number> {
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
  let existing: string;
  try {
    const read = readExisting(path);
    existing = read.missing ? "" : read.text;
  } catch (error) {
    console.error(`omastoic: ${(error as Error).message}`);
    return 1;
  }
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
  if (!quiet) console.log(`→ added ${rows.length} ${rows.length === 1 ? "quote" : "quotes"} to ${path}`);
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

async function validateQuoteFlagsForReplace(
  baseSettings: Settings,
  quoteFlags: string[],
  slugs: string[],
  bundled: BundledQuote[],
  customBefore: BundledQuote[],
  customReadable: boolean,
  slug: string,
  replacementQuotes?: Quote[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!quoteFlags.length) return { ok: true };
  let candidateSettings = baseSettings;
  let candidateCustom = customBefore;
  if (replacementQuotes) {
    const quotesPath = join(USER_CONFIG, "quotes.tsv");
    const existingQuotesText = readExisting(quotesPath).missing ? "" : readExisting(quotesPath).text;
    const nextQuotesText = replaceAuthorQuotesInTsv(existingQuotesText, slug, replacementQuotes);
    candidateCustom = indexCustom(parseQuotes(nextQuotesText));
    candidateSettings = remapCustomQuoteIds(baseSettings, customBefore, candidateCustom, slug);
  }
  const candidateCatalog = [...choicesOf(bundled), ...choicesOf(candidateCustom)];
  const checked = applyQuoteFlags(candidateSettings.quotes, quoteFlags, slugs, candidateCatalog, customReadable);
  return checked.ok ? { ok: true } : { ok: false, error: checked.error };
}

async function configure(rest: string[]): Promise<number> {
  const parsedFlags = parseConfigFlags(rest);
  const singleFlag = (name: string): { present: boolean; value?: string } => {
    const list = parsedFlags.values.get(`--${name}`);
    return list ? { present: true, value: list[0] } : { present: false };
  };
  for (const key of ["authors", "interval", "name", "dates", "image", "citation", "text"]) {
    if ((parsedFlags.values.get(`--${key}`)?.length ?? 0) > 1) {
      console.error(`omastoic: --${key} can only be passed once`);
      return 1;
    }
  }
  const authorsValues = parsedFlags.values.get("--authors") ?? [];
  const intervalValues = parsedFlags.values.get("--interval") ?? [];
  if (authorsValues.some((v) => v === undefined)) {
    console.error("omastoic: --authors requires a value");
    return 1;
  }
  if (intervalValues.some((v) => v === undefined)) {
    console.error("omastoic: --interval requires a value");
    return 1;
  }
  const authorsFlag = authorsValues[0];
  const intervalFlag = intervalValues[0];
  const quoteFlags = (parsedFlags.values.get("--quotes") ?? []).map((v) => v ?? "");
  let addFlags = (parsedFlags.values.get("--add") ?? []).map((v) => v ?? "");
  const addAuthorFlags = (parsedFlags.values.get("--add-author") ?? []).map((v) => v ?? "");
  const replaceAuthorFlags = parsedFlags.values.get("--replace-author") ?? [];
  const removeAuthorFlags = parsedFlags.values.get("--remove-author") ?? [];
  const nameFlag = singleFlag("name");
  const datesFlag = singleFlag("dates");
  const imageFlag = singleFlag("image");
  const citationFlag = singleFlag("citation");
  const textFlag = singleFlag("text");
  const list = parsedFlags.bools.has("--list");
  // --plain asks for numbers instead of keys for the authors and their quotes; the
  // interval and custom-quote prompts read a line either way.
  const plain = parsedFlags.bools.has("--plain");
  const authorActionCount =
    (addAuthorFlags.length > 0 ? 1 : 0) +
    (replaceAuthorFlags.length > 0 ? 1 : 0) +
    (removeAuthorFlags.length > 0 ? 1 : 0);
  if (authorActionCount > 1) {
    console.error("omastoic: use only one of --add-author, --replace-author, or --remove-author at a time");
    return 1;
  }
  const authorSubFlags = nameFlag.present || datesFlag.present || imageFlag.present || citationFlag.present || textFlag.present;
  if (authorSubFlags && addAuthorFlags.length === 0 && replaceAuthorFlags.length === 0) {
    console.error("omastoic: --name, --dates, --image, --citation and --text require --add-author or --replace-author");
    return 1;
  }
  if (removeAuthorFlags.length > 0 && addFlags.length > 0) {
    console.error("omastoic: --add cannot be used with --remove-author");
    return 1;
  }
  const interactive = authorsFlag == null && intervalFlag == null && quoteFlags.length === 0 && addFlags.length === 0 && authorActionCount === 0 && !list;

  if (interactive && !process.stdin.isTTY && !plain) {
    const roster = await authors();
    const bundled = await bundledBook();
    const customBook = await indexedCustom();
    const catalog = [...choicesOf(bundled), ...choicesOf(customBook.quotes)];
    let current: Settings;
    try { current = await loadSettings(); }
    catch (error) {
      console.error(`omastoic: ${(error as Error).message}`);
      return 1;
    }
    printSettings(current, roster, catalog);
    console.log(`  omastoic config --authors marcus,seneca --interval 15`);
    console.log(`  omastoic config --quotes marcus=q01,q02`);
    console.log(`  omastoic config --quotes marcus=all`);
    console.log(`  omastoic config --quotes all`);
    console.log(`  omastoic config --add`);
    console.log(`  omastoic config --add $'marcus\\tMeditations IX.1\\tYour line.'`);
    console.log(`  omastoic config --add-author musonius --name "Musonius Rufus" --image portrait.jpg --citation "Lectures VI" --text "Your line."`);
    console.log(`  omastoic config --replace-author musonius --image new.jpg`);
    console.log(`  omastoic config --remove-author musonius`);
    console.log(`  omastoic config --list`);
    console.log(`  omastoic config --plain`);
    return 0;
  }

  // Validate and transcode --add-author / --replace-author outside the state
  // transaction lock so a slow converter or interactive prompt never blocks daemon writes.
  let preparedAuthor: { validated: ValidatedNewAuthor; artText: string } | null = null;
  if (addAuthorFlags.length) {
    if (addAuthorFlags.length > 1) {
      console.error("omastoic: --add-author accepts one author at a time");
      return 1;
    }
    if (intervalFlag != null && parseInterval(intervalFlag) == null) {
      console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
      return 1;
    }
    const slugArg = addAuthorFlags[0]!;
    let authorInput: NewAuthorInput | null = null;
    const promptMode = !slugArg && !authorSubFlags && addFlags.length === 0;
    if (promptMode) {
      if (!process.stdin.isTTY && !plain) {
        addAuthorUsage();
        return 1;
      }
      const io = configIo(plain);
      try {
        const prompted = await promptNewAuthor(io);
        if (prompted.kind === "author") authorInput = prompted.input;
      } finally {
        io.source.close();
      }
    } else {
      if (datesFlag.present && datesFlag.value === undefined) {
        console.error("omastoic: --dates requires a value");
        return 1;
      }
      if (!slugArg || !nameFlag.value || !imageFlag.value) {
        addAuthorUsage();
        return 1;
      }
      if (citationFlag.present !== textFlag.present) {
        console.error("omastoic: --citation and --text must be given together");
        return 1;
      }
      const quotesForAuthor: Array<{ citation: string; text: string }> = [];
      if (citationFlag.present && textFlag.present) {
        if (!citationFlag.value || !textFlag.value) {
          console.error("omastoic: --citation and --text cannot be empty");
          return 1;
        }
        quotesForAuthor.push({ citation: citationFlag.value, text: textFlag.value });
      }
      if (addFlags.length) {
        if (addFlags.some((line) => !line)) {
          addUsage();
          return 1;
        }
        for (const line of addFlags) {
          let rows: Quote[];
          try {
            rows = parseQuotes(line.endsWith("\n") ? line : `${line}\n`);
          } catch (error) {
            console.error(`omastoic: ${(error as Error).message}`);
            return 1;
          }
          if (rows.length !== 1) {
            addUsage();
            return 1;
          }
          if (rows[0].author !== slugArg.trim()) {
            console.error(`omastoic: --add quote author "${rows[0].author}" does not match --add-author "${slugArg.trim()}"`);
            return 1;
          }
          quotesForAuthor.push({ citation: rows[0].citation, text: rows[0].text });
        }
        addFlags = [];
      }
      if (!quotesForAuthor.length) {
        console.error("omastoic: adding an author requires at least one quote (--add or --citation and --text)");
        return 1;
      }
      authorInput = {
        slug: slugArg,
        name: nameFlag.value,
        dates: datesFlag.value ?? "",
        image: imageFlag.value,
        quotes: quotesForAuthor,
      };
    }

    if (authorInput) {
      const checked = await validateNewAuthorInput(authorInput);
      if (!checked.ok) {
        console.error(`omastoic: ${checked.error}`);
        return 1;
      }
      // Fast-fail existing-author, --authors and --quotes errors before invoking the image converter.
      const preRoster = await authors();
      const preSlugs = [...preRoster.keys()];
      if (preRoster.has(checked.value.author.slug)) {
        console.error(`omastoic: author "${checked.value.author.slug}" already exists in ${USER_AUTHORS_FILE}. Use --replace-author ${checked.value.author.slug} to update it.`);
        return 1;
      }
      const candidateSlugs = [...preSlugs, checked.value.author.slug];
      if (authorsFlag != null && parseAuthorList(authorsFlag, candidateSlugs) == null) {
        console.error(`omastoic: unknown author — try: ${candidateSlugs.join(", ")} (or all)`);
        return 1;
      }
      if (quoteFlags.length) {
        const preBundled = await bundledBook();
        const preCustom = await indexedCustom();
        let preSettings: Settings;
        try { preSettings = await loadSettings(); }
        catch (error) {
          console.error(`omastoic: ${(error as Error).message}`);
          return 1;
        }
        const prospective = checked.value.quotes.map((_, offset) => ({
          id: `c${String(preCustom.quotes.length + offset + 1).padStart(2, "0")}`,
          author: checked.value.author.slug,
        }));
        const candidateCatalog = [...choicesOf(preBundled), ...choicesOf(preCustom.quotes), ...prospective];
        const checkedQuotes = applyQuoteFlags(preSettings.quotes, quoteFlags, candidateSlugs, candidateCatalog, preCustom.readable);
        if (!checkedQuotes.ok) {
          console.error(`omastoic: ${checkedQuotes.error}`);
          return 1;
        }
      }
      let artText: string;
      try {
        artText = await transcodePortrait(checked.value.image);
      } catch (error) {
        console.error(`omastoic: ${(error as Error).message}`);
        return 1;
      }
      preparedAuthor = { validated: checked.value, artText };
    }
  }

  let preparedReplace: { validated: ValidatedReplaceAuthor; artText: string | null } | null = null;
  if (replaceAuthorFlags.length) {
    if (replaceAuthorFlags.length > 1) {
      console.error("omastoic: --replace-author accepts one author at a time");
      return 1;
    }
    if (intervalFlag != null && parseInterval(intervalFlag) == null) {
      console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
      return 1;
    }
    const slugArg = replaceAuthorFlags[0];
    if (!slugArg) {
      replaceAuthorUsage();
      return 1;
    }
    if (datesFlag.present && datesFlag.value === undefined) {
      console.error("omastoic: --dates requires a value");
      return 1;
    }
    if (nameFlag.present && !nameFlag.value) {
      console.error("omastoic: --name requires a value");
      return 1;
    }
    if (imageFlag.present && !imageFlag.value) {
      console.error("omastoic: --image requires a file path");
      return 1;
    }
    if (citationFlag.present !== textFlag.present) {
      console.error("omastoic: --citation and --text must be given together");
      return 1;
    }
    const quotesForAuthor: Array<{ citation: string; text: string }> = [];
    if (citationFlag.present && textFlag.present) {
      if (!citationFlag.value || !textFlag.value) {
        console.error("omastoic: --citation and --text cannot be empty");
        return 1;
      }
      quotesForAuthor.push({ citation: citationFlag.value, text: textFlag.value });
    }
    if (addFlags.length) {
      if (addFlags.some((line) => !line)) {
        addUsage();
        return 1;
      }
      for (const line of addFlags) {
        let rows: Quote[];
        try {
          rows = parseQuotes(line.endsWith("\n") ? line : `${line}\n`);
        } catch (error) {
          console.error(`omastoic: ${(error as Error).message}`);
          return 1;
        }
        if (rows.length !== 1) {
          addUsage();
          return 1;
        }
        if (rows[0].author !== flatField(slugArg)) {
          console.error(`omastoic: --add quote author "${rows[0].author}" does not match --replace-author "${flatField(slugArg)}"`);
          return 1;
        }
        quotesForAuthor.push({ citation: rows[0].citation, text: rows[0].text });
      }
      addFlags = [];
    }
    const checked = await validateReplaceAuthorInput({
      slug: slugArg,
      name: nameFlag.present ? nameFlag.value : undefined,
      dates: datesFlag.present ? datesFlag.value : undefined,
      image: imageFlag.present ? imageFlag.value : undefined,
      quotes: quotesForAuthor.length ? quotesForAuthor : undefined,
    });
    if (!checked.ok) {
      console.error(`omastoic: ${checked.error}`);
      return 1;
    }
    const preRoster = await authors();
    const preSlugs = [...preRoster.keys()];
    if (authorsFlag != null && parseAuthorList(authorsFlag, preSlugs) == null) {
      console.error(`omastoic: unknown author — try: ${preSlugs.join(", ")} (or all)`);
      return 1;
    }
    if (quoteFlags.length) {
      const preBundled = await bundledBook();
      const preCustom = await indexedCustom();
      let preSettings: Settings;
      try { preSettings = await loadSettings(); }
      catch (error) {
        console.error(`omastoic: ${(error as Error).message}`);
        return 1;
      }
      const checkedQuotes = await validateQuoteFlagsForReplace(
        preSettings,
        quoteFlags,
        preSlugs,
        preBundled,
        preCustom.quotes,
        preCustom.readable,
        checked.value.slug,
        checked.value.quotes,
      );
      if (!checkedQuotes.ok) {
        console.error(`omastoic: ${checkedQuotes.error}`);
        return 1;
      }
    }
    let artText: string | null = null;
    if (checked.value.image !== undefined) {
      try {
        artText = await transcodePortrait(checked.value.image);
      } catch (error) {
        console.error(`omastoic: ${(error as Error).message}`);
        return 1;
      }
    }
    preparedReplace = { validated: checked.value, artText };
  }

  let pendingRemoveAuthorSlug: string | null = null;
  if (removeAuthorFlags.length) {
    if (removeAuthorFlags.length > 1) {
      console.error("omastoic: --remove-author accepts one author at a time");
      return 1;
    }
    if (intervalFlag != null && parseInterval(intervalFlag) == null) {
      console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
      return 1;
    }
    const slugArg = removeAuthorFlags[0];
    if (!slugArg) {
      removeAuthorUsage();
      return 1;
    }
    const checkedSlug = await checkEditableCustomSlug(slugArg, "removed");
    if (!checkedSlug.ok) {
      console.error(`omastoic: ${checkedSlug.error}`);
      return 1;
    }
    pendingRemoveAuthorSlug = checkedSlug.slug;
  }

  return locked(STATE, async () => {
    let roster = await authors();
    let slugs = [...roster.keys()];
    const bundled = await bundledBook();
    let customBook = await indexedCustom();
    let catalog = [...choicesOf(bundled), ...choicesOf(customBook.quotes)];
    let current: Settings;
    try { current = await loadSettings(); }
    catch (error) {
      console.error(`omastoic: ${(error as Error).message}`);
      return 1;
    }
    const beforeRotation = await daemonRotationDigest(bundled);

    let next: Settings = { ...current };
    let quoteLines: string[] | null = null;
    let quoteFailure: number | null = null;
    let authorChanged = false;
    let selectionTouched = false;
    let replaceRollback: (() => void) | null = null;
    let removeRollback: (() => void) | null = null;

    if (interactive) {
      const io: ConfigIo = configIo(plain);
      try {
        const picked = await pickAuthorList(roster, current.authors ?? [], io);
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
          const ids = await pickQuoteList(roster.get(slug)?.name ?? slug, choices, selected, io);
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
        const seconds = await pickInterval(current.interval ?? DEFAULT_INTERVAL, io);
        if (seconds == null) return 0;
        next.interval = seconds;
        const offered = await offerCustomQuote(io);
        if (offered.kind === "abort") return 0;
        if (offered.kind === "invalid") quoteFailure = 1;
        else if (offered.kind === "quote") quoteLines = [quoteRow(offered.quote)];
      } finally {
        io.source.close();
      }
    } else {
      if (intervalFlag != null) {
        const parsed = parseInterval(intervalFlag);
        if (parsed == null) {
          console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
          return 1;
        }
        next.interval = parsed;
      }

      if (preparedAuthor) {
        const newSlug = preparedAuthor.validated.author.slug;
        const candidateSlugs = slugs.includes(newSlug) ? slugs : [...slugs, newSlug];
        if (authorsFlag != null && parseAuthorList(authorsFlag, candidateSlugs) == null) {
          console.error(`omastoic: unknown author — try: ${candidateSlugs.join(", ")} (or all)`);
          return 1;
        }
        if (quoteFlags.length) {
          const prospective = preparedAuthor.validated.quotes.map((_, offset) => ({
            id: `c${String(customBook.quotes.length + offset + 1).padStart(2, "0")}`,
            author: newSlug,
          }));
          const candidateCatalog = [...catalog, ...prospective];
          const checkedQuotes = applyQuoteFlags(next.quotes, quoteFlags, candidateSlugs, candidateCatalog, customBook.readable);
          if (!checkedQuotes.ok) {
            console.error(`omastoic: ${checkedQuotes.error}`);
            return 1;
          }
        }
        const created = await commitNewAuthor(preparedAuthor.validated, preparedAuthor.artText);
        if (!created.ok) {
          console.error(`omastoic: ${created.error}`);
          return 1;
        }
        authorChanged = true;
        roster = await authors();
        slugs = [...roster.keys()];
        customBook = await indexedCustom();
        catalog = [...choicesOf(bundled), ...choicesOf(customBook.quotes)];
      }

      if (preparedReplace) {
        if (authorsFlag != null && parseAuthorList(authorsFlag, slugs) == null) {
          console.error(`omastoic: unknown author — try: ${slugs.join(", ")} (or all)`);
          return 1;
        }
        const checkedQuotes = await validateQuoteFlagsForReplace(
          next,
          quoteFlags,
          slugs,
          bundled,
          customBook.quotes,
          customBook.readable,
          preparedReplace.validated.slug,
          preparedReplace.validated.quotes,
        );
        if (!checkedQuotes.ok) {
          console.error(`omastoic: ${checkedQuotes.error}`);
          return 1;
        }
        const replaced = await commitReplaceAuthor(preparedReplace.validated, preparedReplace.artText, next);
        if (!replaced.ok) {
          console.error(`omastoic: ${replaced.error}`);
          return 1;
        }
        authorChanged = true;
        next = replaced.nextSettings;
        if (replaced.settingsRemapped) selectionTouched = true;
        replaceRollback = replaced.rollback;
        roster = await authors();
        slugs = [...roster.keys()];
        customBook = await indexedCustom();
        catalog = [...choicesOf(bundled), ...choicesOf(customBook.quotes)];
      }

      if (pendingRemoveAuthorSlug) {
        if (!slugs.includes(pendingRemoveAuthorSlug)) {
          console.error(`omastoic: author "${pendingRemoveAuthorSlug}" is not a custom author`);
          return 1;
        }
        const remainingSlugs = slugs.filter((item) => item !== pendingRemoveAuthorSlug);
        const removeOverrides: RemoveAuthorOverrides = {};
        if (authorsFlag != null) {
          const parsed = parseAuthorList(authorsFlag, remainingSlugs);
          if (parsed == null) {
            console.error(`omastoic: unknown author — try: ${remainingSlugs.join(", ")} (or all)`);
            return 1;
          }
          removeOverrides.authors = parsed;
        }
        if (quoteFlags.length) {
          const remainingCustom = indexCustom(customBook.quotes.filter((quote) => quote.author !== pendingRemoveAuthorSlug));
          const remainingCatalog = [...choicesOf(bundled), ...choicesOf(remainingCustom)];
          const remapped = remapCustomQuoteIds(next, customBook.quotes, remainingCustom, pendingRemoveAuthorSlug);
          const checkedQuotes = applyQuoteFlags(remapped.quotes, quoteFlags, remainingSlugs, remainingCatalog, customBook.readable);
          if (!checkedQuotes.ok) {
            console.error(`omastoic: ${checkedQuotes.error}`);
            return 1;
          }
          removeOverrides.quotes = checkedQuotes.quotes;
        }
        const removed = await commitRemoveAuthor(pendingRemoveAuthorSlug, next, bundled, false, removeOverrides);
        if (!removed.ok) {
          console.error(`omastoic: ${removed.error}`);
          return 1;
        }
        authorChanged = true;
        next = removed.nextSettings;
        removeRollback = removed.rollback;
        roster = await authors();
        slugs = [...roster.keys()];
        customBook = await indexedCustom();
        catalog = [...choicesOf(bundled), ...choicesOf(customBook.quotes)];
      }

      if (!pendingRemoveAuthorSlug && authorsFlag != null) {
        const parsed = parseAuthorList(authorsFlag, slugs);
        if (parsed == null) {
          replaceRollback?.();
          removeRollback?.();
          console.error(`omastoic: unknown author — try: ${slugs.join(", ")} (or all)`);
          return 1;
        }
        next.authors = parsed;
      }
      if (!pendingRemoveAuthorSlug && quoteFlags.length) {
        const applied = applyQuoteFlags(next.quotes, quoteFlags, slugs, catalog, customBook.readable);
        if (!applied.ok) {
          replaceRollback?.();
          removeRollback?.();
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
          const prompted = await promptCustomQuote(configIo(plain));
          if (prompted.kind === "invalid") quoteFailure = 1;
          else if (prompted.kind === "quote") quoteLines = [quoteRow(prompted.quote)];
        } else {
          quoteLines = addFlags;
        }
      }
    }

    const settingsTouched = interactive || authorsFlag != null || intervalFlag != null || quoteFlags.length > 0;
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
    if ((settingsTouched || selectionTouched) && !pendingRemoveAuthorSlug) {
      try {
        await saveSettings(next, slugs, catalog, customBook.readable);
      } catch (error) {
        replaceRollback?.();
        removeRollback?.();
        throw error;
      }
    }
    if (quoteFailure != null) {
      if (settingsTouched || selectionTouched || authorChanged) {
        if ((await daemonRotationDigest(bundled)) !== beforeRotation) await restartDaemon();
        printSettings(await config(), roster, catalog);
      }
      return quoteFailure;
    }
    if (!settingsTouched && !selectionTouched && !quoteLines && !authorChanged && !list) return 0;
    if ((settingsTouched || selectionTouched || quoteLines || authorChanged) && (await daemonRotationDigest(bundled)) !== beforeRotation) {
      await restartDaemon();
    }
    const saved = await config();
    printSettings(saved, roster, catalog);
    const custom = (quoteLines || authorChanged) && quoteFailure == null ? indexCustom(await customQuotes()) : customBook.quotes;
    warnIgnoredRotation(bundled, custom, saved);
    if (list) {
      if (customBook.error) console.error(`omastoic: ${customBook.error}`);
      console.log(formatQuoteList(bundled, custom, saved));
    }
    return 0;
  });
}

// --- panel ---------------------------------------------------------------------
// The Quickshell panel (ui/Panel.qml) never reads or writes config.json itself.
// It asks for this state, and sends one JSON object back; every write still goes
// through the same validators, lock and daemon restart as `omastoic config`.

/** What the panel renders. Read-only: no lock, no writes, no state directory. */
async function panelState(notice = ""): Promise<string> {
  const roster = await authors();
  const bundledRoster = await bundledAuthors();
  const settings = await config();
  const bundled = await bundledBook();
  const custom = await indexedCustom();
  const catalog = [...choicesOf(bundled), ...choicesOf(custom.quotes)];
  const selected = settings.authors?.length ? settings.authors : [...roster.keys()];
  const backend = await installedBackend();
  const header = headerPortraitLayout();
  const samples = [];
  for (const author of roster.values()) {
    const authored = bundled.filter((row) => row.author === author.slug);
    const pool = authored.length ? authored : custom.quotes.filter((row) => row.author === author.slug);
    const quote = pool
      .sort((a, b) => a.text.length - b.text.length || a.id.localeCompare(b.id))[0];
    const art = await loadPortrait(author.slug);
    const block = art?.join("\n") ?? "";
    samples.push({
      slug: author.slug,
      name: author.name,
      dates: author.dates,
      custom: !bundledRoster.has(author.slug),
      id: quote?.id ?? "",
      citation: quote?.citation ?? "",
      text: quote?.text ?? "",
      portrait: padPortrait(portraitDownscale(block, header.rows, header.cols), header.rows, header.cols),
    });
  }
  return JSON.stringify(
    {
      settings,
      summary: describeSettings(settings, roster, catalog),
      allAuthors: !settings.authors?.length,
      ...(notice ? { notice } : {}),
      backend,
      intervalApplied: backend !== "native",
      authors: [...roster.values()].map((author) => ({
        slug: author.slug,
        name: author.name,
        dates: author.dates,
        custom: !bundledRoster.has(author.slug),
        selected: selected.includes(author.slug),
      })),
      samples,
      portraitFont: header.fontPx,
      portraitLine: header.cellHeight,
      portraitWidth: header.width,
      portraitHeight: header.height,
      customQuotes: custom.quotes.length,
      custom: custom.quotes.map((quote) => ({
        id: quote.id,
        author: quote.author,
        name: roster.get(quote.author)?.name ?? quote.author,
        citation: quote.citation,
        text: quote.text,
      })),
      customQuotesError: custom.error ?? "",
      panelSize: readPanelSize(PANEL_SIZE_FILE),
      configPath: SETTINGS_FILE,
      quotesPath: join(USER_CONFIG, "quotes.tsv"),
      authorsPath: USER_AUTHORS_FILE,
    },
    null,
    2,
  );
}

/** Drop one custom row and renumber the ids that settings still name. */
function withoutCustomQuote(quotes: Quote[], id: string): { quotes: Quote[]; removed: Quote } | { error: string } {
  const canonical = canonicalQuoteId(id);
  if (!canonical || canonical === "c00" || !canonical.startsWith("c")) return { error: "Only a quote you added can be removed." };
  const indexed = indexCustom(quotes);
  const hit = indexed.find((quote) => quote.id === canonical);
  if (!hit) return { error: "That quote is not one of yours." };
  return { quotes: quotes.filter((quote) => !(quote.author === hit.author && quote.citation === hit.citation && quote.text === hit.text)), removed: hit };
}

function remapRemovedQuote(settings: Settings, before: BundledQuote[], removedId: string): Settings {
  if (!settings.quotes) return settings;
  const remaining = before.filter((quote) => quote.id !== removedId);
  const renumbered = indexCustom(remaining);
  const nextId = new Map(remaining.map((quote, index) => [quote.id, renumbered[index].id]));
  const quotes: Record<string, string[]> = {};
  for (const [author, ids] of Object.entries(settings.quotes)) {
    const mapped = ids.flatMap((kept) => {
      if (kept === removedId) return [];
      if (kept.startsWith("c") && kept !== "c00") return nextId.has(kept) ? [nextId.get(kept)!] : [];
      return [kept];
    });
    quotes[author] = mapped;
  }
  return { ...settings, quotes };
}

/** Collapse a panel field so it stays one quotes.tsv row, exactly like the prompts. */
function panelQuote(raw: unknown): { quote: Quote } | { error: string } {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fields = ["author", "citation", "text"].map((key) => (typeof row[key] === "string" ? flatField(row[key] as string) : ""));
  if (fields.some((field) => !field)) return { error: "panel addQuote needs an author, a citation and the quote text" };
  try {
    const parsed = parseQuotes(`${fields[0]}\t${fields[1]}\t${fields[2]}\n`);
    if (parsed.length !== 1) return { error: "panel addQuote needs one author, citation and text" };
    return { quote: parsed[0] };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function panelAuthor(raw: unknown): { input: NewAuthorInput } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "panel addAuthor expects an object with slug, name, image, citation and text" };
  }
  const row = raw as Record<string, unknown>;
  const slug = typeof row.slug === "string" ? row.slug : "";
  const name = typeof row.name === "string" ? row.name : "";
  const dates = typeof row.dates === "string" ? row.dates : "";
  const image = typeof row.image === "string" ? row.image : "";
  const quotes: Array<{ citation: string; text: string }> = [];
  if (Array.isArray(row.quotes)) {
    for (const item of row.quotes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { error: "panel addAuthor quotes must be objects with citation and text" };
      }
      const entry = item as Record<string, unknown>;
      quotes.push({
        citation: typeof entry.citation === "string" ? entry.citation : "",
        text: typeof entry.text === "string" ? entry.text : "",
      });
    }
  } else if (typeof row.citation === "string" || typeof row.text === "string") {
    quotes.push({
      citation: typeof row.citation === "string" ? row.citation : "",
      text: typeof row.text === "string" ? row.text : "",
    });
  }
  return { input: { slug, name, dates, image, quotes } };
}

function panelReplaceAuthor(raw: unknown): { input: ReplaceAuthorInput } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "panel replaceAuthor expects an object with slug and fields to update" };
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.slug !== "string") {
    return { error: "panel replaceAuthor needs an author slug" };
  }
  let name: string | undefined;
  if (Object.hasOwn(row, "name") && row.name !== undefined) {
    if (typeof row.name !== "string") return { error: "panel replaceAuthor name must be a string" };
    name = row.name;
  }
  let dates: string | undefined;
  if (Object.hasOwn(row, "dates") && row.dates !== undefined) {
    if (typeof row.dates !== "string") return { error: "panel replaceAuthor dates must be a string" };
    dates = row.dates;
  }
  let image: string | undefined;
  if (Object.hasOwn(row, "image") && row.image !== undefined) {
    if (typeof row.image !== "string") return { error: "panel replaceAuthor image must be a string" };
    image = row.image;
  }
  let quotes: Array<{ citation: string; text: string }> | undefined;
  if (Object.hasOwn(row, "quotes") && row.quotes !== undefined) {
    if (!Array.isArray(row.quotes) || row.quotes.length === 0) {
      return { error: "panel replaceAuthor quotes must be a non-empty list of citation and text" };
    }
    quotes = [];
    for (const item of row.quotes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { error: "panel replaceAuthor quotes must be objects with citation and text" };
      }
      const entry = item as Record<string, unknown>;
      quotes.push({
        citation: typeof entry.citation === "string" ? entry.citation : "",
        text: typeof entry.text === "string" ? entry.text : "",
      });
    }
  } else if (
    (Object.hasOwn(row, "citation") && row.citation !== undefined) ||
    (Object.hasOwn(row, "text") && row.text !== undefined)
  ) {
    if (typeof row.citation !== "string" || typeof row.text !== "string") {
      return { error: "panel replaceAuthor citation and text must be given together" };
    }
    quotes = [{ citation: row.citation, text: row.text }];
  }
  return { input: { slug: row.slug, name, dates, image, quotes } };
}

/** One JSON object from the panel: the fields `config` owns, plus one quote or author change. */
async function panelApply(raw: string): Promise<number> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.error("omastoic: panel apply expects a JSON object");
    return 1;
  }

  const value = payload as Record<string, unknown>;
  if (Object.hasOwn(value, "interval")) {
    const seconds =
      typeof value.interval === "number" || typeof value.interval === "string" ? parseInterval(String(value.interval)) : null;
    if (seconds == null) {
      console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
      return 1;
    }
  }

  const actionKeys = ["addAuthor", "replaceAuthor", "removeAuthor", "addQuote", "removeQuote"] as const;
  if (actionKeys.filter((key) => Object.hasOwn(value, key)).length > 1) {
    console.error("omastoic: Change one author or quote at a time.");
    return 1;
  }

  // Validate and transcode addAuthor / replaceAuthor outside the state lock so
  // slow image work never holds transaction.flock.
  let preparedAuthor: { validated: ValidatedNewAuthor; artText: string } | null = null;
  if (Object.hasOwn(value, "addAuthor")) {
    const parsedAuthor = panelAuthor(value.addAuthor);
    if ("error" in parsedAuthor) {
      console.error(`omastoic: ${parsedAuthor.error}`);
      return 1;
    }
    const checked = await validateNewAuthorInput(parsedAuthor.input);
    if (!checked.ok) {
      console.error(`omastoic: ${checked.error}`);
      return 1;
    }
    const preRoster = await authors();
    if (preRoster.has(checked.value.author.slug)) {
      console.error(`omastoic: "${checked.value.author.slug}" already exists. Use Edit on that author to update it.`);
      return 1;
    }
    if (Object.hasOwn(value, "authors")) {
      if (!Array.isArray(value.authors) || !value.authors.every((slug) => typeof slug === "string")) {
        console.error("omastoic: panel authors must be a list of author slugs — an empty list means all");
        return 1;
      }
      const allowed = [...preRoster.keys(), checked.value.author.slug];
      if ((value.authors as string[]).some((slug) => !allowed.includes(slug))) {
        console.error("omastoic: Unknown author. Pick a name from the list.");
        return 1;
      }
    }
    let artText: string;
    try {
      artText = await transcodePortrait(checked.value.image);
    } catch (error) {
      console.error(`omastoic: ${(error as Error).message}`);
      return 1;
    }
    preparedAuthor = { validated: checked.value, artText };
  }

  let preparedReplace: { validated: ValidatedReplaceAuthor; artText: string | null } | null = null;
  if (Object.hasOwn(value, "replaceAuthor")) {
    const parsedReplace = panelReplaceAuthor(value.replaceAuthor);
    if ("error" in parsedReplace) {
      console.error(`omastoic: ${parsedReplace.error}`);
      return 1;
    }
    const checked = await validateReplaceAuthorInput(parsedReplace.input, "panel");
    if (!checked.ok) {
      console.error(`omastoic: ${checked.error}`);
      return 1;
    }
    const preRoster = await authors();
    if (Object.hasOwn(value, "authors")) {
      if (!Array.isArray(value.authors) || !value.authors.every((slug) => typeof slug === "string")) {
        console.error("omastoic: panel authors must be a list of author slugs — an empty list means all");
        return 1;
      }
      const allowed = [...preRoster.keys()];
      if ((value.authors as string[]).some((slug) => !allowed.includes(slug))) {
        console.error("omastoic: Unknown author. Pick a name from the list.");
        return 1;
      }
    }
    let artText: string | null = null;
    if (checked.value.image !== undefined) {
      try {
        artText = await transcodePortrait(checked.value.image);
      } catch (error) {
        console.error(`omastoic: ${(error as Error).message}`);
        return 1;
      }
    }
    preparedReplace = { validated: checked.value, artText };
  }

  let pendingRemoveAuthorSlug: string | null = null;
  if (Object.hasOwn(value, "removeAuthor")) {
    if (typeof value.removeAuthor !== "string") {
      console.error("omastoic: removeAuthor expects an author slug");
      return 1;
    }
    const checkedSlug = await checkEditableCustomSlug(value.removeAuthor, "removed");
    if (!checkedSlug.ok) {
      console.error(`omastoic: ${checkedSlug.error}`);
      return 1;
    }
    if (Object.hasOwn(value, "authors")) {
      if (!Array.isArray(value.authors) || !value.authors.every((slug) => typeof slug === "string")) {
        console.error("omastoic: panel authors must be a list of author slugs — an empty list means all");
        return 1;
      }
      const preRoster = await authors();
      const allowed = [...preRoster.keys()].filter((slug) => slug !== checkedSlug.slug);
      if ((value.authors as string[]).some((slug) => !allowed.includes(slug))) {
        console.error("omastoic: Unknown author. Pick a name from the list.");
        return 1;
      }
    }
    pendingRemoveAuthorSlug = checkedSlug.slug;
  }

  return locked(STATE, async () => {
    let roster = await authors();
    let slugs = [...roster.keys()];
    const bundled = await bundledBook();
    let custom = await indexedCustom();
    let catalog = [...choicesOf(bundled), ...choicesOf(custom.quotes)];
    let next: Settings;
    try { next = { ...(await loadSettings()) }; }
    catch (error) {
      console.error(`omastoic: ${(error as Error).message}`);
      return 1;
    }
    const beforeRotation = await daemonRotationDigest(bundled);
    const savedBefore = compactSettings(next, slugs, catalog, custom.readable);

    if (Object.hasOwn(value, "interval")) {
      const seconds =
        typeof value.interval === "number" || typeof value.interval === "string" ? parseInterval(String(value.interval)) : null;
      if (seconds == null) {
        console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
        return 1;
      }
      next.interval = seconds;
    }

    const allowedSlugs = preparedAuthor && !slugs.includes(preparedAuthor.validated.author.slug)
      ? [...slugs, preparedAuthor.validated.author.slug]
      : pendingRemoveAuthorSlug
        ? slugs.filter((slug) => slug !== pendingRemoveAuthorSlug)
        : slugs;

    let requestedAuthors: string[] | undefined;
    if (Object.hasOwn(value, "authors")) {
      if (!Array.isArray(value.authors) || !value.authors.every((slug) => typeof slug === "string")) {
        console.error("omastoic: panel authors must be a list of author slugs — an empty list means all");
        return 1;
      }
      const wanted = [...new Set(value.authors as string[])];
      const unknown = wanted.find((slug) => !allowedSlugs.includes(slug));
      if (unknown) {
        console.error("omastoic: Unknown author. Pick a name from the list.");
        return 1;
      }
      requestedAuthors = wanted;
      next.authors = wanted;
    }

    let authorMutated = false;
    let selectionTouched = false;
    let replaceRollback: (() => void) | null = null;
    let removeRollback: (() => void) | null = null;

    if (preparedAuthor) {
      const created = await commitNewAuthor(preparedAuthor.validated, preparedAuthor.artText, true, "panel");
      if (!created.ok) {
        console.error(`omastoic: ${created.error}`);
        return 1;
      }
      authorMutated = true;
      roster = await authors();
      slugs = [...roster.keys()];
      custom = await indexedCustom();
      catalog = [...choicesOf(bundled), ...choicesOf(custom.quotes)];
    }

    if (preparedReplace) {
      const replaced = await commitReplaceAuthor(preparedReplace.validated, preparedReplace.artText, next, true);
      if (!replaced.ok) {
        console.error(`omastoic: ${replaced.error}`);
        return 1;
      }
      authorMutated = true;
      next = replaced.nextSettings;
      if (replaced.settingsRemapped) selectionTouched = true;
      replaceRollback = replaced.rollback;
      roster = await authors();
      slugs = [...roster.keys()];
      custom = await indexedCustom();
      catalog = [...choicesOf(bundled), ...choicesOf(custom.quotes)];
    }

    let panelNotice = "";
    if (pendingRemoveAuthorSlug) {
      if (!slugs.includes(pendingRemoveAuthorSlug)) {
        console.error(`omastoic: author "${pendingRemoveAuthorSlug}" is not a custom author`);
        return 1;
      }
      const removed = await commitRemoveAuthor(
        pendingRemoveAuthorSlug,
        next,
        bundled,
        true,
        requestedAuthors !== undefined ? { authors: requestedAuthors } : undefined,
      );
      if (!removed.ok) {
        console.error(`omastoic: ${removed.error}`);
        return 1;
      }
      authorMutated = true;
      next = removed.nextSettings;
      removeRollback = removed.rollback;
      if (removed.fallbackAuthor) {
        panelNotice = `Removed ${removed.author.name}. Rotation is now ${removed.fallbackAuthor.name}.`;
      }
      roster = await authors();
      slugs = [...roster.keys()];
      custom = await indexedCustom();
      catalog = [...choicesOf(bundled), ...choicesOf(custom.quotes)];
    }

    let added: Quote | null = null;
    if (Object.hasOwn(value, "addQuote")) {
      const quote = panelQuote(value.addQuote);
      if ("error" in quote) {
        console.error(`omastoic: ${quote.error}`);
        return 1;
      }
      if (!slugs.includes(quote.quote.author)) {
        console.error("omastoic: Unknown author. Pick a name from the list.");
        return 1;
      }
      added = quote.quote;
    }

    let removedId = "";
    let pendingQuoteFile: { path: string; body: string } | null = null;
    if (Object.hasOwn(value, "removeQuote")) {
      if (typeof value.removeQuote !== "string") {
        console.error("omastoic: Only a quote you added can be removed.");
        return 1;
      }
      const gone = withoutCustomQuote(custom.quotes, value.removeQuote);
      if ("error" in gone) {
        console.error(`omastoic: ${gone.error}`);
        return 1;
      }
      removedId = value.removeQuote.trim().toLowerCase();
      const path = join(USER_CONFIG, "quotes.tsv");
      const read = readExisting(path);
      if (read.missing) {
        console.error("omastoic: That quote is not one of yours.");
        return 1;
      }
      let dropped = false;
      const body = read.text.split("\n").filter((line) => {
        if (dropped || !line.trim() || line.startsWith("#")) return true;
        const [author, citation, ...rest] = line.split("\t");
        const same = author?.trim() === gone.removed.author && citation?.trim() === gone.removed.citation && rest.join(" ").trim() === gone.removed.text;
        if (same) { dropped = true; return false; }
        return true;
      }).join("\n");
      if (!dropped) {
        console.error("omastoic: That quote is not one of yours.");
        return 1;
      }
      // Settings are saved before this write. A failed save leaves the quote file intact.
      pendingQuoteFile = { path, body: body.endsWith("\n") || body === "" ? body : `${body}\n` };
      next = remapRemovedQuote(next, custom.quotes, canonicalQuoteId(removedId) ?? removedId);
      catalog = [...choicesOf(bundled), ...choicesOf(indexCustom(gone.quotes))];
    }

    if (added && pendingQuoteFile) {
      console.error("omastoic: Add or remove one quote at a time.");
      return 1;
    }
    if (added) {
      const code = await appendQuotes([quoteRow(added)], true);
      if (code !== 0) return code;
      const customNow = indexCustom(await customQuotes());
      catalog = [...choicesOf(bundled), ...choicesOf(customNow)];
      const remembered = rememberAddedQuote(next, customNow, added);
      if (remembered !== next) {
        next = remembered;
        selectionTouched = true;
      }
    }

    const after = compactSettings(next, slugs, catalog, custom.readable);
    const settingsChanged = JSON.stringify(savedBefore) !== JSON.stringify(after) || selectionTouched;
    if (settingsChanged && (!pendingRemoveAuthorSlug || requestedAuthors !== undefined || Object.hasOwn(value, "interval"))) {
      try {
        await saveSettings(next, slugs, catalog, custom.readable);
      } catch (error) {
        replaceRollback?.();
        removeRollback?.();
        throw error;
      }
    }
    if (pendingQuoteFile) atomicWrite(pendingQuoteFile.path, pendingQuoteFile.body);
    if ((settingsChanged || added || authorMutated || removedId) && (await daemonRotationDigest(bundled)) !== beforeRotation) {
      await restartDaemon();
    }
    console.log(await panelState(panelNotice));
    return 0;
  });
}

function useTerminalStyle(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

function styleBold(text: string, styled: boolean): string {
  return styled ? `\x1b[1m${text}\x1b[0m` : text;
}

function styleDim(text: string, styled: boolean): string {
  return styled ? `\x1b[2m${text}\x1b[0m` : text;
}

function formatTwoColumn(rows: ReadonlyArray<readonly [string, string]>, colWidth: number): string[] {
  return rows.map(([left, right]) => `  ${left.padEnd(colWidth)}${right}`);
}

async function status(opts: { verbose?: boolean } = {}): Promise<number> {
  const verbose = Boolean(opts.verbose);
  const styled = useTerminalStyle();
  const quotes = await quoteBook();
  const byAuthor = new Map<string, number>();
  for (const q of quotes) byAuthor.set(q.author, (byAuthor.get(q.author) ?? 0) + 1);

  const names = await authors();
  const cfg = await config();
  const catalog = [...choicesOf(await bundledBook()), ...choicesOf((await indexedCustom()).quotes)];
  const summarySettings = describeSettings(cfg, names, catalog);

  const unit = querySystemctl(["is-active", "omastoic.service"]);
  const on = enabled();
  const ours = on && ownsBranding();
  const stateLabel = on ? (ours ? "on" : "stood aside") : "off";
  const backend = await installedBackend();
  const backendLine = backend === "native"
    ? "native, one quote when the screensaver starts"
    : backend === "terminal"
      ? "terminal (ttfx), a new quote on the interval while it is up"
      : "not found";

  const summaryLine = `Stoics: ${stateLabel} · ${summarySettings}`;
  const labelWidth = verbose ? 14 : 10;
  const field = (label: string, value: string) => `${styleDim(label.padEnd(labelWidth), styled)}${value}`;

  const metaLines = [
    field("version:", manifestVersion()),
    field("backend:", backendLine),
    field("service:", unit.stdout.trim() || "not installed"),
  ];
  if (verbose) {
    const size = await screensaverSize();
    metaLines.push(field("grid:", `${size.cols}x${size.rows} cells (${size.source}, ${size.cell.width.toFixed(1)}×${size.cell.height.toFixed(1)}px)`));
    metaLines.push(field("canvas file:", BRANDING));
  }

  const quoteLabel = quotes.length === 1 ? "1 quote:" : `${quotes.length} quotes:`;
  const bookLines = [styleDim(quoteLabel, styled)];
  for (const [slug, count] of [...byAuthor].sort((a, b) => b[1] - a[1])) {
    const art = (await loadPortrait(slug)) ? "portrait" : "no portrait";
    bookLines.push(`  ${(names.get(slug)?.name ?? slug).padEnd(18)} ${String(count).padStart(3)}  ${styleDim(art, styled)}`);
  }

  console.log([styleBold(summaryLine, styled), "", ...metaLines, "", ...bookLines].join("\n"));
  return 0;
}

async function requireOn(): Promise<boolean> {
  if (enabled()) return true;
  console.error("omastoic: the Stoics are off — turn them on with: omastoic toggle");
  return false;
}

function usage(styled = false): string {
  const colWidth = 20;
  const commands = formatTwoColumn([
    ["omastoic toggle", "Hand the screensaver to the Stoics, or give it back"],
    ["omastoic next", "Write another quote if the Stoics still own the slot"],
    ["omastoic preview", "Write a new canvas and start the screensaver now"],
    ["omastoic show", "Print a canvas as text (--cols, --rows); no writes"],
    ["omastoic config", "Choose authors, quotes, and seconds, or edit custom ones"],
    ["omastoic ui", "Open the settings panel in the Omarchy shell"],
    ["omastoic status", "Show status, backend, and quote book (--verbose for details)"],
    ["omastoic version", "Print the version from manifest.json"],
    ["omastoic --version", "Same"],
    ["omastoic uninstall", "Remove the service, menu row, and plugin (--purge for data)"],
  ], colWidth);
  const helpRows = formatTwoColumn([
    ["omastoic --help", "Print this help and do nothing"],
    ["omastoic <cmd> -h", "Print help for one command (--help works too)"],
  ], colWidth);

  return [
    styleBold("omastoic: the Stoics on your Omarchy screensaver", styled),
    "",
    ...commands,
    "",
    ...helpRows,
    "",
    `${styleDim("Install:", styled)}  omarchy plugin add https://github.com/rastermanden/omastoic.git --enable`,
    `${styleDim("Remove:", styled)}   omastoic uninstall`,
    `          omarchy plugin remove ${PLUGIN_ID}`,
    "",
    "Appearance → Branding → Screensaver → Stoics is the same toggle.",
    "Edit Text, Set From Image, and Restore Default stay Omarchy's. If they",
    "write the slot, the Stoics stand aside.",
    "",
    "The native screensaver reads the canvas once per start, and the next",
    "quote is written when that start ends. The older terminal screensaver",
    "changes quotes on the interval while it is up. Omarchy's launcher",
    "starts the native program, which is not on PATH.",
    "",
    `${styleDim("Authors:", styled)}  ${USER_AUTHORS_FILE}`,
    `${styleDim("Quotes:", styled)}   ${join(USER_CONFIG, "quotes.tsv")}`,
    `${styleDim("Settings:", styled)} ${join(USER_CONFIG, "config.json")}`,
  ].join("\n");
}

function commandUsage(rawCommand: string, styled = false): string | null {
  const command = rawCommand === "configure" ? "config" : rawCommand;
  const heading = (line: string) => styleBold(line, styled);
  const section = (label: string) => styleDim(label, styled);

  switch (command) {
    case "toggle":
      return [
        heading("omastoic toggle"),
        "",
        "Hand the screensaver slot to the Stoics, or restore what was there",
        "before. Appearance → Branding → Screensaver → Stoics runs the same",
        "command.",
      ].join("\n");
    case "on":
      return [
        heading("omastoic on"),
        "",
        "Hand the screensaver slot to the Stoics, back up existing branding,",
        "write a canvas, and start the rotation service.",
      ].join("\n");
    case "off":
      return [
        heading("omastoic off"),
        "",
        "Stop the rotation service and restore the screensaver branding that",
        "was in the slot before Omastoic took it.",
      ].join("\n");
    case "next":
      return [
        heading("omastoic next"),
        "",
        "Write a fresh quote canvas if the Stoics still own the screensaver",
        "slot. On the native screensaver, the new quote appears on the next",
        "start.",
      ].join("\n");
    case "preview":
      return [
        heading("omastoic preview [--quote <id>]"),
        "",
        "Write a fresh canvas and start the screensaver now. On the native",
        "backend, passes --input and a calm --include-effects list.",
        "",
        section("Options:"),
        ...formatTwoColumn([
          ["--quote <id>", "Render one specific quote id (such as q01 or c01)"],
        ], 16),
      ].join("\n");
    case "show":
      return [
        heading("omastoic show [--cols <n>] [--rows <n>]"),
        "",
        "Print one rendered canvas to stdout without writing desktop or state",
        "files.",
        "",
        section("Options:"),
        ...formatTwoColumn([
          ["--cols <n>", "Grid width in terminal cells (default: tty width or 92)"],
          ["--rows <n>", "Grid height in terminal rows (default: tty height or 25)"],
        ], 14),
      ].join("\n");
    case "config":
      return [
        heading("omastoic config [options]"),
        "",
        "Choose which authors and quotes appear, set the rotation interval,",
        "or manage custom quotes and authors. Run with no flags for the",
        "interactive picker.",
        "",
        section("Options:"),
        ...formatTwoColumn([
          ["--authors <list>", "Comma-separated author slugs, or all"],
          ["--interval <n>", "Seconds between quotes (1 to 3600)"],
          ["--quotes <spec>", "Filter quotes: slug=q01,q02, slug=all, slug=none, or all"],
          ["--add [tsv]", "Add a custom quote (prompted, or slug\\tcitation\\ttext)"],
          ["--add-author [slug]", "Add a custom author with a JPEG/PNG portrait and quote"],
          ["--replace-author <slug>", "Update a custom author's portrait, details, or quotes"],
          ["--remove-author <slug>", "Remove a custom author, their portrait, and their quotes"],
          ["--name <text>", "Display name for --add-author or --replace-author"],
          ["--dates <text>", "Optional dates for --add-author or --replace-author"],
          ["--image <path>", "Portrait JPEG or PNG for --add-author or --replace-author"],
          ["--citation <text>", "Quote citation for --add-author or --replace-author"],
          ["--text <text>", "Quote text for --add-author or --replace-author"],
          ["--list", "List bundled and custom quote ids"],
          ["--plain", "Use numbered prompts instead of key navigation"],
        ], 26),
        "",
        "Pass single-value options only once: --authors, --interval, --name,",
        "--dates, --image, --citation, --text, --add-author, --replace-author,",
        "and --remove-author. You can repeat --quotes and --add.",
      ].join("\n");
    case "ui":
      return [
        heading("omastoic ui"),
        "",
        "Toggle the Omastoic settings panel inside the running Omarchy shell.",
      ].join("\n");
    case "status":
      return [
        heading("omastoic status [--verbose]"),
        "",
        "Show whether the Stoics own the screensaver, active settings,",
        "backend, and the quote book.",
        "",
        section("Options:"),
        ...formatTwoColumn([
          ["--verbose, -v", "Also show grid size, cell metrics, and canvas file path"],
        ], 16),
      ].join("\n");
    case "version":
      return [
        heading("omastoic version | omastoic --version"),
        "",
        "Print the installed version from manifest.json without writing",
        "state or screensaver files.",
      ].join("\n");
    case "uninstall":
      return [
        heading("omastoic uninstall [--purge]"),
        "",
        "Restore displaced branding and remove the rotation service, menu",
        "row, shell completions, and launcher.",
        "",
        section("Options:"),
        ...formatTwoColumn([
          ["--purge", "Also delete saved settings, custom quotes, authors, and portraits"],
        ], 12),
      ].join("\n");
    case "setup":
      return [
        heading("omastoic setup [--on-first] [--quiet]"),
        "",
        "Install or refresh the launcher, menu row, completions, and user",
        "systemd units.",
        "",
        section("Options:"),
        ...formatTwoColumn([
          ["--on-first", "Hand the screensaver slot to the Stoics on first install"],
          ["--quiet", "Suppress status output"],
        ], 14),
      ].join("\n");
    case "install":
      return [
        heading("omastoic install"),
        "",
        "Run setup and hand the screensaver slot to the Stoics.",
      ].join("\n");
    case "daemon":
      return [
        heading("omastoic daemon"),
        "",
        "Run the background quote rotation loop used by omastoic.service.",
      ].join("\n");
    case "panel":
      return [
        heading("omastoic panel state | omastoic panel apply '<json>' | omastoic panel size '<json>' | omastoic panel pick-image"),
        "",
        "Read or update settings, save panel size, or pick a portrait image for the",
        "Quickshell settings panel. Reads JSON from the argument or stdin on apply or size.",
      ].join("\n");
    case "render-png":
      return [
        heading("omastoic render-png <canvas.txt> [out.png]"),
        "",
        "Render a text canvas file to a PNG image using the current theme",
        "foreground colour.",
      ].join("\n");
    default:
      return null;
  }
}

function helpRequested(argv: string[]): boolean {
  if (argv.length === 0 || argv[0] === "help") return true;
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

function helpOutput(argv: string[]): string {
  const styled = useTerminalStyle();
  if (argv.length === 0) return usage(styled);
  if (argv[0] === "help") {
    return (argv[1] ? commandUsage(argv[1], styled) : null) ?? usage(styled);
  }
  const first = argv[0];
  if (first && !first.startsWith("-")) {
    return commandUsage(first, styled) ?? usage(styled);
  }
  return usage(styled);
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
      console.log(await render({ cols: cols ?? 92, rows: rows ?? 25 }, false));
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
      if (!(await writeBranding())) return 1;
      if ((await installedBackend()) === "native" && screensaverIsRunning()) {
        console.log("→ the running screensaver already read its quote; this one shows the next time it starts");
      }
      return 0;
    case "preview": {
      let forced: Quote | undefined;
      if (rest[0] === "--quote") {
        const id = canonicalQuoteId(rest[1] ?? "");
        const found = id ? [...(await bundledBook()), ...(await indexedCustom()).quotes].find((quote) => quote.id === id) : undefined;
        if (!found) {
          console.error("omastoic: That quote is not in the book.");
          return 1;
        }
        forced = found;
      }
      const wasEnabled = enabled();
      let shownQuote: Quote | null = null;
      if (!wasEnabled) {
        const activated = await activate(forced);
        if (activated.code) return activated.code;
        shownQuote = activated.quote;
      } else {
        shownQuote = await writeBranding(false, forced);
        if (!shownQuote) return 1;
      }
      const backend = await installedBackend();
      if (backend === "missing") {
        console.error("omastoic: no screensaver backend — install omarchy-screensaver, or ttfx for the older terminal saver (omarchy pkg add ttfx)");
        return 1;
      }
      // The running overlay already has its text. Launching again exits
      // immediately and would look like a preview that did nothing.
      if (backend === "native" && screensaverIsRunning()) {
        console.log("→ a screensaver is already up, still showing the quote it started with");
        console.log("→ this canvas is what the next start will read");
        return 0;
      }
      const effects = previewEffects(shownQuote ? [...shownQuote.text].length : undefined);
      const code = await launchScreensaver(backend, effects);
      if (backend === "terminal") {
        await waitForLiveGrid();
        if (!(await writeBranding(false, forced))) return 1;
      }
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
    case "version":
    case "--version":
      console.log(manifestVersion());
      return 0;
    case "status":
      return status({ verbose: rest.includes("--verbose") || rest.includes("-v") });
    case "config":
    case "configure":
      return configure(rest);
    case "panel": {
      const action = rest[0];
      if (action === "state") {
        console.log(await panelState());
        return 0;
      }
      if (action === "apply") {
        const raw = rest[1] ?? (process.stdin.isTTY ? "" : await Bun.stdin.text());
        if (!raw.trim()) {
          console.error("omastoic: panel apply expects a JSON object as an argument or on stdin");
          return 1;
        }
        return panelApply(raw);
      }
      if (action === "size") {
        const raw = rest[1] ?? (process.stdin.isTTY ? "" : await Bun.stdin.text());
        if (!raw.trim()) {
          console.error("omastoic: panel size expects a JSON object as an argument or on stdin");
          return 1;
        }
        const parsed = parsePanelSizeCommand(raw);
        if (!parsed.ok) {
          console.error(`omastoic: ${parsed.error}`);
          return 1;
        }
        writePanelSize(PANEL_SIZE_FILE, parsed.size);
        console.log(JSON.stringify(parsed.size));
        return 0;
      }
      if (action === "pick-image") {
        const picked = await pickPortraitImage({
          home: HOME,
          watchStdin: rest.includes("--watch-stdin"),
        });
        if (picked.status === "picked") {
          process.stdout.write(`${picked.path}\n`);
          return PORTRAIT_PICKER_EXIT.PICKED;
        }
        if (picked.status === "cancelled") {
          return PORTRAIT_PICKER_EXIT.CANCELLED;
        }
        if (picked.status === "unsupported") {
          console.error(`omastoic: ${picked.reason}`);
          return PORTRAIT_PICKER_EXIT.UNSUPPORTED;
        }
        console.error(`omastoic: ${picked.reason}`);
        return PORTRAIT_PICKER_EXIT.UNAVAILABLE;
      }
      console.error("usage: omastoic panel state | omastoic panel apply '<json>' | omastoic panel size '<json>' | omastoic panel pick-image");
      return 1;
    }
    case "ui": {
      const shell = Bun.which("omarchy-shell");
      const toggled = shell ? Bun.spawnSync([shell, "shell", "toggle", PLUGIN_ID], { stdout: "ignore", stderr: "ignore" }) : null;
      if (toggled?.exitCode !== 0) {
        console.error("omastoic: could not reach the Omarchy shell — is omarchy-shell running?");
        console.error(`          otherwise: omarchy-shell shell toggle ${PLUGIN_ID}`);
        return 1;
      }
      return 0;
    }
    default:
      console.log(usage(useTerminalStyle()));
      return 1;
  }
}

try {
  const argv = Bun.argv.slice(2);
  if (helpRequested(argv)) {
    console.log(helpOutput(argv));
    process.exit(0);
  }
  const command = argv[0];
  // `config` and `panel apply` acquire `locked(STATE, ...)` themselves after
  // any portrait image conversion or interactive prompt completes.
  const mutating = ["on", "off", "toggle", "next", "preview", "setup", "install", "uninstall"].includes(command);
  process.exit(await (mutating ? locked(STATE, main) : main()));
} catch (error) {
  console.error(`omastoic: ${(error as Error).message}`);
  process.exit(1);
}
