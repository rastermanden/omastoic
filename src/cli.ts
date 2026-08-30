#!/usr/bin/env bun
// omastoic — the Stoics on your Omarchy screensaver.
//
// Omarchy's screensaver loops `ttfx` over ~/.config/omarchy/branding/screensaver.txt,
// re-reading the file every time round. So omastoic never has to replace, shadow
// or patch anything Omarchy ships: it just keeps a fresh quote in that file, and
// swaps it for another one while the screensaver is actually up.

import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { compose, loadArt, parseAuthors, parseQuotes, pick, type Quote } from "./canvas.ts";
import { screensaverSize, screensaverWindowEvents } from "./hyprland.ts";

const ROOT = dirname(import.meta.dir);
const HOME = process.env.HOME ?? "";
const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(HOME, ".config");
const STATE_HOME = process.env.XDG_STATE_HOME ?? join(HOME, ".local/state");

const BRANDING = join(CONFIG_HOME, "omarchy/branding/screensaver.txt");
const BACKUP = join(CONFIG_HOME, "omarchy/branding/screensaver.txt.pre-omastoic");
const USER_CONFIG = join(CONFIG_HOME, "omastoic");
const STATE = join(STATE_HOME, "omastoic");
const UNIT = join(CONFIG_HOME, "systemd/user/omastoic.service");

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
  const canvas = await render();
  mkdirSync(dirname(BRANDING), { recursive: true });
  const temp = `${BRANDING}.omastoic-tmp`;
  await Bun.write(temp, `${canvas}\n`);
  renameSync(temp, BRANDING);
}

async function backUpOriginal(): Promise<void> {
  if (await Bun.file(BACKUP).exists()) return;
  const current = Bun.file(BRANDING);
  if (!(await current.exists())) return;
  await Bun.write(BACKUP, current);
  console.log(`→ kept your old screensaver art at ${BACKUP}`);
}

const run = (cmd: string[]) =>
  Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" }).exited;

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

  await backUpOriginal();
  await writeBranding();
  console.log(`→ wrote a Stoic canvas to ${BRANDING}`);

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
  await run(["systemctl", "--user", "enable", "--now", "omastoic.service"]);
  console.log(`→ rotating a new quote every ${interval}s while the screensaver is up`);
  console.log("\nTry it now:  omastoic preview");
  return 0;
}

async function uninstall(): Promise<number> {
  if (await Bun.file(UNIT).exists()) {
    await run(["systemctl", "--user", "disable", "--now", "omastoic.service"]);
    await Bun.file(UNIT).delete();
    await run(["systemctl", "--user", "daemon-reload"]);
    console.log(`→ removed ${UNIT}`);
  }

  const backup = Bun.file(BACKUP);
  if (await backup.exists()) {
    await Bun.write(BRANDING, backup);
    await backup.delete();
    console.log("→ put your old screensaver art back");
  } else if (Bun.which("omarchy")) {
    await run(["omarchy", "branding", "screensaver", "reset"]);
  }
  return 0;
}

async function daemon(): Promise<number> {
  const interval = ((await config()).interval ?? DEFAULT_INTERVAL) * 1000;
  const open = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const rotate = () => {
    writeBranding().catch((err) => console.error(`omastoic: ${err.message}`));
  };

  // Leave a fresh quote sitting in the file so the very first frame of the next
  // screensaver is already new, without racing the ttfx that is about to read it.
  rotate();

  for await (const event of screensaverWindowEvents()) {
    if (event.kind === "open") {
      open.add(event.address);
      timer ??= setInterval(rotate, interval);
    } else if (open.delete(event.address) && open.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      rotate();
    }
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
  console.log(`\nscreensaver grid: ${size.cols}x${size.rows} cells`);
  console.log(`canvas file:      ${BRANDING}`);

  const unit = Bun.spawnSync(["systemctl", "--user", "is-active", "omastoic.service"]);
  console.log(`rotation service: ${unit.stdout.toString().trim() || "not installed"}`);
  return 0;
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
      const size = cols && rows ? { cols, rows } : undefined;
      console.log(await render(size));
      return 0;
    }
    case "next":
      await writeBranding();
      return 0;
    case "preview":
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

  omastoic install      hand the screensaver over to the Stoics
  omastoic uninstall    give it back
  omastoic preview      write a new canvas and start the screensaver now
  omastoic show         print one canvas at this terminal's size
  omastoic next         put a new canvas in the screensaver file
  omastoic status       what is installed, and what is in the quote book
  omastoic daemon       rotate quotes while the screensaver is up (the service)

Add your own quotes in ${join(USER_CONFIG, "quotes.tsv")}
(author-slug, citation, text — tab separated), and set the rotation
interval or narrow the roster in ${join(USER_CONFIG, "config.json")}.`);
      return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
}

process.exit(await main());
