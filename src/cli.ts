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
import { screensaverSize, screensaverWindowEvents, waitForLiveGrid } from "./hyprland.ts";
import { authorCompletionList, renderCompletion } from "./completions.ts";
import { hasBlock, withBlock, withoutBlock } from "./menu.ts";
import { ChunkSource, pickAuthors } from "./author-picker.ts";
import { pickQuotes, type QuoteRow } from "./quote-picker.ts";
import { askConfirm, askLine, askText } from "./line-prompt.ts";
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

async function render(size?: { cols: number; rows: number }, remember = true): Promise<string> {
  const quotes = await quoteBook();
  if (!quotes.length) throw new Error("the quote book is empty");

  const chosen = pick(quotes, await recent());
  if (remember) atomicWrite(join(STATE, "recent.json"), JSON.stringify(chosen.recent));

  const grid = size ?? (await screensaverSize());
  const art = await loadArt(join(ROOT, "art"), chosen.quote.author);
  return compose(chosen.quote, (await authors()).get(chosen.quote.author), {
    cols: grid.cols,
    rows: grid.rows,
    art,
  });
}

/** Replace the branding file in one step, so a running ttfx never reads a half-written canvas. */
async function writeBranding(takeSlot = false): Promise<boolean> {
  // Recheck after rendering too: a user's branding command may run while we
  // measure terminals. All our writers hold the transaction lock.
  const before = await Bun.file(BRANDING).text().catch(() => null);
  if (!takeSlot && !(await ownsBranding())) { standAside(); return false; }
  const canvas = `${await render()}\n`;
  if ((await Bun.file(BRANDING).text().catch(() => null)) !== before) { standAside(); return false; }
  atomicWrite(BRANDING, canvas);
  await rememberWrite(canvas);
  return true;
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
    } else if (enabled()) {
      await checked(["systemctl", "--user", "enable", "omastoic.service"]);
      if (previous !== marker || changed) await checked(["systemctl", "--user", "restart", "omastoic.service"]);
      else await checked(["systemctl", "--user", "start", "omastoic.service"]);
    } else {
      await stopDaemon();
    }
    atomicWrite(INSTALLED, marker); // Only successful setup is an installation.
  } catch (error) {
    // Leave owned plumbing available for retry/uninstall, but fail closed.
    await run(["systemctl", "--user", "disable", "--now", "omastoic.service"]);
    await run(["systemctl", "--user", "disable", "--now", "omastoic-prune.path"]);
    if (existsSync(WRITTEN) && await ownsBranding()) await restoreSlot();
    setEnabled(false);
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

  const stopRotating = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const rotate = async (): Promise<boolean> => {
    await locked(STATE, async () => {
      if (enabled()) await writeBranding();
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
          await rotate();
        }
        await startRotating();
      }
    } else if (open.delete(event.address) && open.size === 0) {
      stopRotating();
      await rotate();
    }
  }
  return 0;
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

type PromptedQuote = { kind: "quote"; quote: Quote } | { kind: "cancel" } | { kind: "invalid" };

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
  // --plain asks for numbers instead of keys for the Stoics and their quotes; the
  // interval and custom-quote prompts read a line either way.
  const plain = rest.includes("--plain");
  const interactive = authorsFlag == null && intervalFlag == null && quoteFlags.length === 0 && addFlags.length === 0 && !list;

  if (interactive && !process.stdin.isTTY && !plain) {
    printSettings(current, roster, catalog);
    console.log(`  omastoic config --authors marcus,seneca --interval 15`);
    console.log(`  omastoic config --quotes marcus=q01,q02`);
    console.log(`  omastoic config --quotes marcus=all`);
    console.log(`  omastoic config --quotes all`);
    console.log(`  omastoic config --add`);
    console.log(`  omastoic config --add $'marcus\\tMeditations IX.1\\tYour line.'`);
    console.log(`  omastoic config --list`);
    console.log(`  omastoic config --plain`);
    return 0;
  }

  let next: Settings = { ...current };
  let quoteLines: string[] | null = null;
  let quoteFailure: number | null = null;

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
        const prompted = await promptCustomQuote(configIo(plain));
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

// --- panel ---------------------------------------------------------------------
// The Quickshell panel (ui/Panel.qml) never reads or writes config.json itself.
// It asks for this state, and sends one JSON object back; every write still goes
// through the same validators, lock and daemon restart as `omastoic config`.

/** What the panel renders. Read-only: no lock, no writes, no state directory. */
async function panelState(): Promise<string> {
  const roster = await authors();
  const settings = await config();
  const custom = await indexedCustom();
  const catalog = [...choicesOf(await bundledBook()), ...choicesOf(custom.quotes)];
  const selected = settings.authors?.length ? settings.authors : [...roster.keys()];
  return JSON.stringify(
    {
      settings,
      summary: describeSettings(settings, roster, catalog),
      allAuthors: !settings.authors?.length,
      authors: [...roster.values()].map((author) => ({
        slug: author.slug,
        name: author.name,
        dates: author.dates,
        selected: selected.includes(author.slug),
      })),
      customQuotes: custom.quotes.length,
      customList: custom.quotes.map((quote) => ({
        id: quote.id,
        author: quote.author,
        name: roster.get(quote.author)?.name ?? quote.author,
        citation: quote.citation,
        text: quote.text,
      })),
      customQuotesError: custom.error ?? "",
      configPath: SETTINGS_FILE,
      quotesPath: join(USER_CONFIG, "quotes.tsv"),
    },
    null,
    2,
  );
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

/** One JSON object from the panel: the fields `config` owns, plus one quote to add. */
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
  const roster = await authors();
  const slugs = [...roster.keys()];
  const bundled = await bundledBook();
  const custom = await indexedCustom();
  let catalog = [...choicesOf(bundled), ...choicesOf(custom.quotes)];
  let next: Settings = { ...(await config()) };
  let settingsTouched = false;

  if (Object.hasOwn(value, "interval")) {
    const seconds =
      typeof value.interval === "number" || typeof value.interval === "string" ? parseInterval(String(value.interval)) : null;
    if (seconds == null) {
      console.error("omastoic: interval must be a whole number of seconds from 1 to 3600");
      return 1;
    }
    next.interval = seconds;
    settingsTouched = true;
  }

  if (Object.hasOwn(value, "authors")) {
    if (!Array.isArray(value.authors) || !value.authors.every((slug) => typeof slug === "string")) {
      console.error("omastoic: panel authors must be a list of Stoic slugs — an empty list means all six");
      return 1;
    }
    const wanted = [...new Set(value.authors as string[])];
    const unknown = wanted.find((slug) => !slugs.includes(slug));
    if (unknown) {
      console.error(`omastoic: unknown author ${unknown} — try: ${slugs.join(", ")} (or an empty list for all six)`);
      return 1;
    }
    next.authors = wanted;
    settingsTouched = true;
  }

  let added: Quote | null = null;
  if (Object.hasOwn(value, "addQuote")) {
    const quote = panelQuote(value.addQuote);
    if ("error" in quote) {
      console.error(`omastoic: ${quote.error}`);
      return 1;
    }
    added = quote.quote;
  }

  let selectionTouched = false;
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

  if (settingsTouched || selectionTouched) await saveSettings(next, slugs, catalog, custom.readable);
  if (settingsTouched || added) await restartDaemon();
  console.log(await panelState());
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
grid:             ${size.cols}x${size.rows} cells (${size.source}, ${size.cell.width.toFixed(1)}×${size.cell.height.toFixed(1)}px)
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
      return await writeBranding() ? 0 : 1;
    case "preview":
      if (!enabled()) {
        const code = await on();
        if (code) return code;
      } else if (!(await writeBranding())) return 1;
      {
        const code = await launchScreensaver();
        await waitForLiveGrid();
        if (!(await writeBranding())) return 1;
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
      console.error("usage: omastoic panel state | omastoic panel apply '<json>'");
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
      console.log(`omastoic — the Stoics on your Omarchy screensaver

  omastoic toggle      hand the screensaver to the Stoics, or give it back
  omastoic next        write another quote, only if the Stoics still own the slot
  omastoic preview     write a new canvas and start the screensaver now
  omastoic show --cols 92 --rows 25  read-only text export; no desktop/state writes
  omastoic config      choose Stoics, their quotes, and seconds, or add a quote
                       (--plain asks for numbers instead of keys)
  omastoic ui          open the settings panel in the Omarchy shell
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
  const mutating = ["on", "off", "toggle", "next", "preview", "setup", "install", "uninstall", "config", "configure"].includes(command)
    || (command === "panel" && Bun.argv[3] === "apply");
  process.exit(await (mutating ? locked(STATE, main) : main()));
} catch (error) {
  console.error(`omastoic: ${(error as Error).message}`);
  process.exit(1);
}
