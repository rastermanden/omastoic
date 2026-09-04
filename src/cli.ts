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

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { compose, loadArt, parseAuthors, parseQuotes, pick, type Quote } from "./canvas.ts";
import { screensaverSize, screensaverWindowEvents, waitForLiveGrid } from "./hyprland.ts";
import { hasBlock, withBlock, withoutBlock } from "./menu.ts";
import { renderCanvasPng, themeForeground } from "./png.ts";
import {
  compactSettings,
  DEFAULT_INTERVAL,
  describeSettings,
  parseAuthorList,
  parseInterval,
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
const PLUGIN_HOME = join(CONFIG_HOME, "omarchy/plugins/omastoic");
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(HOME, ".local/share");
const BASH_COMPLETION = join(DATA_HOME, "bash-completion/completions/omastoic");
const FISH_COMPLETION = join(DATA_HOME, "fish/vendor_completions.d/omastoic.fish");
const PRUNE_SCRIPT = join(HOME, ".local/lib/omastoic/prune.sh");
const PRUNE_UNIT = join(CONFIG_HOME, "systemd/user/omastoic-prune.service");
const PRUNE_PATH = join(CONFIG_HOME, "systemd/user/omastoic-prune.path");
const PLUGINS_DIR = join(CONFIG_HOME, "omarchy/plugins");

const SETTINGS_FILE = join(USER_CONFIG, "config.json");

async function config(): Promise<Settings> {
  const file = Bun.file(SETTINGS_FILE);
  if (!(await file.exists())) return {};
  try {
    return await file.json();
  } catch {
    console.error(`omastoic: ignoring unreadable ${SETTINGS_FILE}`);
    return {};
  }
}

async function saveSettings(settings: Settings, roster: string[]): Promise<void> {
  mkdirSync(USER_CONFIG, { recursive: true });
  const next = compactSettings(settings, roster);
  await Bun.write(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

async function restartDaemon(): Promise<void> {
  if (enabled() && (await Bun.file(UNIT).exists())) {
    await run(["systemctl", "--user", "restart", "omastoic.service"]);
  }
}

async function quoteBook(): Promise<Quote[]> {
  const cfg = await config();
  let quotes = parseQuotes(await Bun.file(join(ROOT, "data/quotes.tsv")).text());

  // Anything the user drops in is added to the book rather than replacing it.
  const extra = Bun.file(join(USER_CONFIG, "quotes.tsv"));
  if (await extra.exists()) quotes = [...quotes, ...parseQuotes(await extra.text())];

  if (cfg.authors?.length) {
    const wanted = new Set(cfg.authors);
    const filtered = quotes.filter((q) => wanted.has(q.author));
    if (filtered.length) return filtered;
    console.error("omastoic: config authors matched no quotes; using the whole book");
  }
  return quotes;
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

const setEnabled = (on: boolean) => quiet(["omarchy-toggle", TOGGLE, on ? "on" : "off"]);

const notify = (message: string) =>
  quiet(["omarchy-notification-send", "-g", GLYPH, message]);

// --- who owns the screensaver slot ------------------------------------------

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function rememberWrite(canvas: string): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  await Bun.write(WRITTEN, digest(canvas));
}

/** True when the branding file still holds exactly what omastoic last put there. */
async function ownsBranding(): Promise<boolean> {
  const current = Bun.file(BRANDING);
  if (!(await current.exists())) return true; // nothing to trample

  const written = Bun.file(WRITTEN);
  if (!(await written.exists())) {
    // Installs from before omastoic tracked what it wrote left no hash. A backup
    // means it had already taken the slot, so the canvas sitting there is ours —
    // without this, the first `on` would back omastoic's own art up as if it
    // were the user's, and lose the real thing.
    return await Bun.file(BACKUP).exists();
  }

  try {
    return digest(await current.text()) === (await written.text()).trim();
  } catch {
    return false;
  }
}

async function render(size?: { cols: number; rows: number }): Promise<string> {
  const quotes = await quoteBook();
  if (!quotes.length) throw new Error("the quote book is empty");

  const chosen = pick(quotes, await recent());
  mkdirSync(STATE, { recursive: true });
  await Bun.write(join(STATE, "recent.json"), JSON.stringify(chosen.recent));

  const grid = size ?? (await screensaverSize());
  const art = await loadArt(join(ROOT, "art"), chosen.quote.author);
  return compose(chosen.quote, (await authors()).get(chosen.quote.author), {
    cols: grid.cols,
    rows: grid.rows,
    art,
  });
}

/** Replace the branding file in one step, so a running ttfx never reads a half-written canvas. */
async function writeBranding(): Promise<void> {
  const canvas = `${await render()}\n`;
  mkdirSync(dirname(BRANDING), { recursive: true });
  const temp = `${BRANDING}.omastoic-tmp`;
  await Bun.write(temp, canvas);
  renameSync(temp, BRANDING);
  await rememberWrite(canvas);
}

/**
 * Keep the art we are about to cover so `off` can put it back. Always the last
 * non-omastoic canvas — Omarchy's branding commands are the way you set art,
 * and toggling the Stoics off should return whatever they displaced.
 */
async function preserveDisplaced(): Promise<void> {
  const current = Bun.file(BRANDING);
  if (!(await current.exists()) || (await ownsBranding())) return;
  await Bun.write(BACKUP, await current.text());
}

async function restoreSlot(): Promise<void> {
  const backup = Bun.file(BACKUP);
  if (await backup.exists()) {
    await Bun.write(BRANDING, await backup.text());
  } else {
    const logo = Bun.file(LOGO);
    if (await logo.exists()) await Bun.write(BRANDING, await logo.text());
  }
  await Bun.file(WRITTEN).delete().catch(() => {});
}

async function stopDaemon(): Promise<void> {
  if (await Bun.file(UNIT).exists()) await run(["systemctl", "--user", "stop", "omastoic.service"]);
}

async function on(): Promise<number> {
  await preserveDisplaced();
  setEnabled(true);
  await writeBranding();

  if (await Bun.file(UNIT).exists()) await run(["systemctl", "--user", "start", "omastoic.service"]);
  else console.log("→ not installed as a service yet; run: omastoic setup");

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
  await Bun.write(MENU, next);
  if (!quiet) console.log(`→ added a Stoics row under Style → Screensaver in the Omarchy menu`);
}

async function removeMenuRows(): Promise<void> {
  const file = Bun.file(MENU);
  if (!(await file.exists())) return;
  const source = await file.text();
  if (!hasBlock(source)) return;
  await Bun.write(MENU, withoutBlock(source));
  console.log("→ removed the Stoics row from the Omarchy menu");
}

function linkLauncher(quiet = false): void {
  const target = join(ROOT, "bin/omastoic");
  try {
    mkdirSync(dirname(LAUNCHER), { recursive: true });
    try {
      if (readlinkSync(LAUNCHER) === target) return;
      unlinkSync(LAUNCHER);
    } catch {
      try {
        lstatSync(LAUNCHER);
        unlinkSync(LAUNCHER);
      } catch {
        // nothing there yet
      }
    }
    symlinkSync(target, LAUNCHER);
    if (!quiet) console.log(`→ ${LAUNCHER}`);
  } catch (err) {
    console.error(`omastoic: could not link ${LAUNCHER}: ${(err as Error).message}`);
  }
}

function unlinkLauncher(): void {
  try {
    if (lstatSync(LAUNCHER).isSymbolicLink()) unlinkSync(LAUNCHER);
  } catch {
    // not ours, or not there
  }
}

function installCompletion(quiet = false): void {
  const copies: [string, string][] = [
    [join(ROOT, "completions/omastoic.bash"), BASH_COMPLETION],
    [join(ROOT, "completions/omastoic.fish"), FISH_COMPLETION],
  ];
  for (const [src, dest] of copies) {
    if (!existsSync(src)) continue;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      if (!quiet) console.log(`→ ${dest}`);
    } catch (err) {
      console.error(`omastoic: could not install completion ${dest}: ${(err as Error).message}`);
    }
  }
}

function uninstallCompletion(): void {
  for (const dest of [BASH_COMPLETION, FISH_COMPLETION]) {
    try {
      unlinkSync(dest);
    } catch {
      // not ours, or not there
    }
  }
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

[Service]
Type=oneshot
ExecStart=${PRUNE_SCRIPT}
`;
}

function prunePathBody(): string {
  return `[Unit]
Description=Watch for omastoic plugin removal

[Path]
PathChanged=${PLUGINS_DIR}
Unit=omastoic-prune.service

[Install]
WantedBy=default.target
`;
}

function installPrune(quiet = false): void {
  const src = join(ROOT, "scripts/prune.sh");
  if (!existsSync(src)) return;
  try {
    mkdirSync(dirname(PRUNE_SCRIPT), { recursive: true });
    copyFileSync(src, PRUNE_SCRIPT);
    chmodSync(PRUNE_SCRIPT, 0o755);
    if (!quiet) console.log(`→ ${PRUNE_SCRIPT}`);
  } catch (err) {
    console.error(`omastoic: could not install prune script: ${(err as Error).message}`);
  }
}

async function removePrune(): Promise<void> {
  const had = await Bun.file(PRUNE_PATH).exists();
  if (had) await run(["systemctl", "--user", "disable", "--now", "omastoic-prune.path"]);
  await Bun.file(PRUNE_PATH).delete().catch(() => {});
  await Bun.file(PRUNE_UNIT).delete().catch(() => {});
  rmSync(dirname(PRUNE_SCRIPT), { recursive: true, force: true });
  if (had) await run(["systemctl", "--user", "daemon-reload"]);
}

async function requireOmarchy(): Promise<number> {
  if (!Bun.which("omarchy")) {
    console.error("omastoic: omarchy is not on PATH — this needs Omarchy 4+");
    return 1;
  }
  if (!Bun.which("ttfx")) {
    console.error("omastoic: ttfx is missing, so the Omarchy screensaver cannot run");
    console.error("          install it with: omarchy pkg add ttfx");
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

  const first = !(await Bun.file(INSTALLED).exists());
  linkLauncher(opts.quiet);
  installCompletion(opts.quiet);
  installPrune(opts.quiet);
  await addMenuRows(opts.quiet);

  const next = unitBody();
  const prev = await Bun.file(UNIT).text().catch(() => "");
  mkdirSync(dirname(UNIT), { recursive: true });
  let unitsChanged = prev !== next;
  if (unitsChanged) {
    await Bun.write(UNIT, next);
    say(`→ ${UNIT}`);
  }

  const pruneService = pruneUnitBody();
  const prunePath = prunePathBody();
  const prevPruneService = await Bun.file(PRUNE_UNIT).text().catch(() => "");
  const prevPrunePath = await Bun.file(PRUNE_PATH).text().catch(() => "");
  if (prevPruneService !== pruneService) {
    await Bun.write(PRUNE_UNIT, pruneService);
    unitsChanged = true;
  }
  if (prevPrunePath !== prunePath) {
    await Bun.write(PRUNE_PATH, prunePath);
    unitsChanged = true;
    say(`→ ${PRUNE_PATH}`);
  }

  if (unitsChanged) await run(["systemctl", "--user", "daemon-reload"]);

  await run(["systemctl", "--user", "enable", "omastoic.service"]);
  await run(["systemctl", "--user", "enable", "--now", "omastoic-prune.path"]);

  mkdirSync(STATE, { recursive: true });
  await Bun.write(INSTALLED, ROOT);

  if (opts.onFirst && first) return on();
  if (enabled() && prev !== next) await run(["systemctl", "--user", "restart", "omastoic.service"]);

  const interval = (await config()).interval ?? DEFAULT_INTERVAL;
  say(`→ a new quote every ${interval}s while the screensaver is up`);
  return 0;
}

async function install(): Promise<number> {
  const code = await setup();
  if (code) return code;
  await on();
  console.log("\nTry it now:    omastoic preview");
  console.log("Switch away:   Style → Screensaver → Stoics, or omastoic toggle");
  return 0;
}

async function uninstall(opts: { purge?: boolean } = {}): Promise<number> {
  await off();

  if (await Bun.file(UNIT).exists()) {
    await run(["systemctl", "--user", "disable", "omastoic.service"]);
    await Bun.file(UNIT).delete();
    await run(["systemctl", "--user", "daemon-reload"]);
    console.log(`→ removed ${UNIT}`);
  }

  await removeMenuRows();
  unlinkLauncher();
  uninstallCompletion();
  await removePrune();

  const backup = Bun.file(BACKUP);
  if (await backup.exists()) await backup.delete();
  await Bun.file(INSTALLED).delete().catch(() => {});

  if (opts.purge) {
    rmSync(USER_CONFIG, { recursive: true, force: true });
    rmSync(STATE, { recursive: true, force: true });
    rmSync(PREVIEWS, { recursive: true, force: true });
    console.log(`→ removed ${USER_CONFIG}`);
  }

  // The plugin folder is what `omarchy plugin add` keys on. Leaving it behind
  // after teardown makes the next add fail with "id already used", and the
  // still-enabled service would set the Stoics up again on the next shell start.
  if (await Bun.file(join(PLUGIN_HOME, "manifest.json")).exists()) {
    const code = await run(["omarchy", "plugin", "remove", "omastoic", "--yes"]);
    if (code !== 0) {
      console.error("omastoic: plugin folder still there — remove it with:");
      console.error("          omarchy plugin remove omastoic --yes");
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
    if (!enabled()) {
      stopRotating();
      return false;
    }
    if (!(await ownsBranding())) {
      standAside();
      stopRotating();
      return false;
    }
    await writeBranding().catch((err) => console.error(`omastoic: ${err.message}`));
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
    if (event.kind === "open") {
      open.add(event.address);
      if (enabled()) {
        // ttfx measures the tty at start; wait until it has left 80x24, then
        // write a canvas that matches the real grid before the first effect.
        await waitForLiveGrid();
        await rotate();
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

async function gumText(args: string[]): Promise<string | null> {
  if (!Bun.which("gum")) return null;
  const proc = Bun.spawn(["gum", ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;
  if (code !== 0) return null;
  return out;
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

function printSettings(settings: Settings, names: Map<string, { name: string }>): void {
  console.log(`→ ${describeSettings(settings, names)}`);
}

async function configure(rest: string[]): Promise<number> {
  const roster = await authors();
  const slugs = [...roster.keys()];
  const current = await config();
  const authorsFlag = stringFlag(rest, "authors");
  const intervalFlag = stringFlag(rest, "interval");
  const interactive = authorsFlag == null && intervalFlag == null;

  if (interactive && !process.stdin.isTTY) {
    printSettings(current, roster);
    console.log(`  omastoic config --authors marcus,seneca --interval 15`);
    console.log(`  omastoic config --authors all`);
    return 0;
  }

  let next: Settings = { ...current };

  if (interactive) {
    if (!Bun.which("gum")) {
      console.error("omastoic: gum is missing — set authors and seconds from the command line:");
      console.error("          omastoic config --authors marcus,seneca --interval 15");
      return 1;
    }
    const picked = await pickAuthors(roster, current.authors ?? []);
    if (picked == null) return 0;
    next.authors = picked;
    const seconds = await pickInterval(current.interval ?? DEFAULT_INTERVAL);
    if (seconds == null) return 0;
    next.interval = seconds;
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
  }

  await saveSettings(next, slugs);
  await restartDaemon();
  printSettings(await config(), roster);
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
settings:         ${describeSettings(await config(), names)}
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
      console.log(await render(cols && rows ? { cols, rows } : undefined));
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
      console.error("omastoic: the screensaver slot is Omarchy's — Style → Screensaver");
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
      await writeBranding();
      return 0;
    case "preview":
      if (!enabled()) {
        const code = await on();
        if (code) return code;
      } else {
        await writeBranding();
      }
      {
        const code = await launchScreensaver();
        await waitForLiveGrid();
        await writeBranding();
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
  omastoic config      choose which Stoics appear, and seconds between quotes
  omastoic status      who has the screensaver, and what is in the quote book
  omastoic uninstall   take the service, menu row and plugin back out

Install:  omarchy plugin add https://github.com/rastermanden/omastoic.git --enable
Remove:   omastoic uninstall

Style → Screensaver → Stoics is the same toggle. Edit Text, Set From Image
and Restore Default stay Omarchy's; if they write the slot, the Stoics
stand aside.

Quotes:   ${join(USER_CONFIG, "quotes.tsv")}
Settings: ${join(USER_CONFIG, "config.json")}`);
      return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
}

process.exit(await main());
