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
import { lstatSync, mkdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { compose, loadArt, parseAuthors, parseQuotes, pick, type Quote } from "./canvas.ts";
import { screensaverSize, screensaverWindowEvents } from "./hyprland.ts";
import { hasBlock, withBlock, withoutBlock } from "./menu.ts";

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

// Omarchy keeps feature flags as files under ~/.local/state/omarchy/toggles.
// Using its own commands means `checked` and `when` conditions in the menu read
// the same state omastoic writes.
const TOGGLE = "omastoic";
const GLYPH = "󱄄";

const DEFAULT_INTERVAL = 20;

type Config = { interval?: number; authors?: string[] };

async function config(): Promise<Config> {
  const file = Bun.file(join(USER_CONFIG, "config.json"));
  if (!(await file.exists())) return {};
  try {
    return await file.json();
  } catch {
    console.error(`omastoic: ignoring unreadable ${join(USER_CONFIG, "config.json")}`);
    return {};
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
  return compose(chosen.quote, (await authors()).get(chosen.quote.author), { ...grid, art });
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

/** Keep whatever art is in the slot now, so `omastoic off` can put it back. */
async function setAside(): Promise<void> {
  const current = Bun.file(BRANDING);
  if (!(await current.exists()) || (await ownsBranding())) return;
  await Bun.write(BACKUP, current);
  console.log(`→ kept your screensaver art at ${BACKUP}`);
}

// --- on, off, and standing aside --------------------------------------------

async function on(): Promise<number> {
  await setAside();
  setEnabled(true);
  await writeBranding();

  if (await Bun.file(UNIT).exists()) await run(["systemctl", "--user", "start", "omastoic.service"]);
  else console.log("→ not installed as a service yet; run: omastoic install");

  console.log("→ the Stoics have the screensaver");
  notify("Screensaver: the Stoics");
  return 0;
}

async function off(): Promise<number> {
  setEnabled(false);
  if (await Bun.file(UNIT).exists()) await run(["systemctl", "--user", "stop", "omastoic.service"]);

  const backup = Bun.file(BACKUP);
  if (await backup.exists()) {
    const art = await backup.text();
    await Bun.write(BRANDING, art);
    await rememberWrite(art); // the slot is no longer ours, but nor is it a foreign edit
    console.log("→ put your previous screensaver art back");
  }

  console.log("→ the Stoics have stood down");
  notify("Screensaver: Stoics off");
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

async function addMenuRows(): Promise<void> {
  const file = Bun.file(MENU);
  const source = (await file.exists()) ? await file.text() : "{\n}\n";
  const next = withBlock(source);
  if (next === source) return;
  mkdirSync(dirname(MENU), { recursive: true });
  await Bun.write(MENU, next);
  console.log(`→ added a Stoics row under Style → Screensaver in the Omarchy menu`);
}

async function removeMenuRows(): Promise<void> {
  const file = Bun.file(MENU);
  if (!(await file.exists())) return;
  const source = await file.text();
  if (!hasBlock(source)) return;
  await Bun.write(MENU, withoutBlock(source));
  console.log("→ removed the Stoics row from the Omarchy menu");
}

function linkLauncher(): void {
  try {
    mkdirSync(dirname(LAUNCHER), { recursive: true });
    try {
      lstatSync(LAUNCHER);
      unlinkSync(LAUNCHER);
    } catch {
      // nothing there yet
    }
    symlinkSync(join(ROOT, "bin/omastoic"), LAUNCHER);
    console.log(`→ ${LAUNCHER}`);
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

async function install(): Promise<number> {
  if (!Bun.which("omarchy")) {
    console.error("omastoic: omarchy is not on PATH — this needs Omarchy 4+");
    return 1;
  }
  if (!Bun.which("ttfx")) {
    console.error("omastoic: ttfx is missing, so the Omarchy screensaver cannot run");
    console.error("          install it with: omarchy pkg add ttfx");
    return 1;
  }

  linkLauncher();
  await addMenuRows();

  const interval = (await config()).interval ?? DEFAULT_INTERVAL;
  mkdirSync(dirname(UNIT), { recursive: true });
  await Bun.write(
    UNIT,
    `[Unit]
Description=Rotate the Stoic quote on the Omarchy screensaver
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=${join(ROOT, "bin/omastoic")} daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
`,
  );
  console.log(`→ ${UNIT}`);

  await run(["systemctl", "--user", "daemon-reload"]);
  await run(["systemctl", "--user", "enable", "omastoic.service"]);

  await on();
  console.log(`→ a new quote every ${interval}s while the screensaver is up`);
  console.log("\nTry it now:  omastoic preview");
  console.log("Switch back: omastoic off  (or Style → Screensaver → Stoics in the menu)");
  return 0;
}

async function uninstall(): Promise<number> {
  await off();

  if (await Bun.file(UNIT).exists()) {
    await run(["systemctl", "--user", "disable", "omastoic.service"]);
    await Bun.file(UNIT).delete();
    await run(["systemctl", "--user", "daemon-reload"]);
    console.log(`→ removed ${UNIT}`);
  }

  await removeMenuRows();
  unlinkLauncher();

  const backup = Bun.file(BACKUP);
  if (await backup.exists()) await backup.delete();
  return 0;
}

// --- the rotation service -----------------------------------------------------

async function daemon(): Promise<number> {
  if (!enabled()) {
    console.log("omastoic: parked (omastoic on to bring the Stoics back)");
    return 0;
  }

  const interval = ((await config()).interval ?? DEFAULT_INTERVAL) * 1000;
  const open = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopRotating = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const rotate = async () => {
    if (!enabled()) return stopRotating();
    if (!(await ownsBranding())) {
      standAside();
      return stopRotating();
    }
    await writeBranding().catch((err) => console.error(`omastoic: ${err.message}`));
  };

  // Leave a fresh quote sitting in the file so the very first frame of the next
  // screensaver is already new, without racing the ttfx that is about to read it.
  await rotate();

  for await (const event of screensaverWindowEvents()) {
    if (event.kind === "open") {
      open.add(event.address);
      if (enabled()) timer ??= setInterval(rotate, interval);
    } else if (open.delete(event.address) && open.size === 0) {
      stopRotating();
      await rotate();
    }
  }
  return 0;
}

// --- reporting ----------------------------------------------------------------

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

  console.log(`
screensaver:      ${on ? "the Stoics" : "whatever art was there before"}`);
  // Only meaningful while the Stoics are on: off, the slot is the user's by
  // design, and saying omastoic holds it would read as a bug.
  if (on && !(await ownsBranding())) {
    console.log("                  (something else has written the slot since)");
  }
  console.log(`grid:             ${size.cols}x${size.rows} cells
canvas file:      ${BRANDING}
rotation service: ${unit.stdout.toString().trim() || "not installed"}`);
  return 0;
}

async function requireOn(): Promise<boolean> {
  if (enabled()) return true;
  console.error("omastoic: the Stoics are off — turn them on with: omastoic on");
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
    case "next":
      if (!(await requireOn())) return 1;
      await writeBranding();
      return 0;
    case "preview":
      if (!(await requireOn())) return 1;
      await writeBranding();
      return run(["omarchy-launch-screensaver", "force"]);
    case "daemon":
      return daemon();
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    case "status":
      return status();
    default:
      console.log(`omastoic — the Stoics on your Omarchy screensaver

  omastoic on           hand the screensaver to the Stoics
  omastoic off          give it back to whatever art was there before
  omastoic toggle       whichever of the two you are not on
  omastoic preview      write a new canvas and start the screensaver now
  omastoic status       who has the screensaver, and what is in the quote book

  omastoic install      set up the rotation service and the menu row
  omastoic uninstall    take all of it back out
  omastoic show         print one canvas at this terminal's size
  omastoic next         put a new canvas in the screensaver file
  omastoic daemon       rotate quotes while the screensaver is up (the service)

Switching is also in the Omarchy menu, under Style → Screensaver → Stoics.
Omarchy's own branding commands win: set the art with \`omarchy branding
screensaver image\` and the Stoics stand aside on their own.

Add your own quotes in ${join(USER_CONFIG, "quotes.tsv")}
(author-slug, citation, text — tab separated), and set the rotation
interval or narrow the roster in ${join(USER_CONFIG, "config.json")}.`);
      return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
}

process.exit(await main());
