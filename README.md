# Omastoic

**The Stoics on your Omarchy screensaver.** One braille portrait, one thought,
and a quiet label with its source. Six Stoics and 64 entries from public-domain
US translations, reviewed against the editions in [CREDITS.md](CREDITS.md).

![Omastoic on the Omarchy screensaver](https://github.com/rastermanden/omastoic/releases/latest/download/preview.gif)

[Longer clip](https://github.com/rastermanden/omastoic/releases/latest/download/demo.mp4)

## Compatibility

This correctness release supports **Omarchy's terminal/ttfx screensaver**,
audited on Omarchy **4.5.0rc3**, with these regression tests run against the
installed **4.5.0** host parser/branding CLI. This is sandboxed integration
evidence, not a live compositor/display matrix. It still requires
[Bun](https://bun.sh) (tested with **1.4.4**, `omarchy pkg add bun`), plus the host's `ttfx`, systemd,
`jq` and Python 3. No network is used at runtime.

**The newer native `omarchy-screensaver` backend is not supported.** It reads
its input once and has no terminal window events. Setup detects the known
native launcher and refuses installation, rather than promising rotation that
cannot work. Native integration, runtime removal and historical portrait
replacement are separate follow-ups, not features of this release.

## Install and update

```bash
omarchy plugin add https://github.com/rastermanden/omastoic.git --enable
omarchy plugin update io.github.rastermanden.omastoic
```

Enabling the plugin runs setup inside the existing Omarchy shell. On first
successful setup it preserves your branding, writes a canvas, links the
`omastoic` **terminal command**, installs completions and user units, and adds
exactly one menu row:

**Appearance → Branding → Screensaver → Stoics**

The row toggles Stoics on/off and is checked while selected. There is no app
launcher/.desktop entry and no Configure menu row. Old plugin-owned
`style.screensaver.*` rows are migrated within our marked block only. Text,
Image and Restore Default remain Omarchy's commands.

Defaults are **all six authors and 60 seconds per quote**, with no setup wizard.
While the saver is active, the service keeps each composed canvas in the
branding file for 60 seconds before choosing another. `ttfx` rereads the file
at its next effect boundary: the host controls transitions, so this is not a
guarantee of exactly 60 uninterrupted, fully legible seconds on screen.

Setup failures return a non-zero status and leave no successful-install marker.
Fix the reported dependency/user-session error, then retry `omastoic setup`.
An unchanged setup is idempotent; code/data updates restart an enabled daemon.
Setup does not steal the slot back after `off` or plugin disable.

For a manual copy from a checkout:

```bash
./install.sh
```

This preflights dependencies before copying. **Manual copies are not Git
checkouts:** update your source checkout and rerun `./install.sh`; `omarchy
plugin update` only updates Git-managed installs. The installer refuses to
copy over a linked or Git-managed plugin. Coming from 1.x, uninstall the old
`omastoic` plugin ID before adding the current one.

## Use

```bash
omastoic toggle                # select Stoics, or restore displaced art
omastoic next                  # another quote, only if we still own the slot
omastoic preview               # MUTATING: select Stoics and launch the saver
omastoic show --cols 92 --rows 25  # read-only text export; no desktop/state writes
omastoic status
omastoic config                # terminal author/interval picker (gum)
omastoic config --authors marcus,seneca --interval 90
omastoic config --authors all --interval 60
```

**Omarchy's branding commands win.** Edit Text, Set From Image and Restore
Default hand the slot back, including while idle. The reconciler turns Stoics
off without overwriting the new art. Select Stoics again to opt back in; turning
them off then restores that newly displaced art.

Disabling the shell plugin stops **and disables** its rotation service and
restores branding only if it is still ours. QML hot reload does not count as a
disable. Re-enable the plugin, then select Stoics again when wanted.

### Settings and custom quotes

Settings are in `~/.config/omastoic/config.json` (or `$XDG_CONFIG_HOME/omastoic/`):

```json
{
  "interval": 60,
  "authors": ["marcus", "epictetus"]
}
```

`interval` is a whole number of seconds from **1 to 3600**. Omit `authors` for
all six. Invalid/null/type-wrong hand-edited settings fall back to defaults;
the next interval is read from the file at each rotation. `omastoic config`
validates and saves the same settings, restarting the daemon if selected.

Your own `quotes.tsv` in that directory adds entries to the bundled book:
**author slug, citation, text**, separated by tabs. Slugs contain letters,
digits, `_` or `-` (64 characters maximum). Custom files are limited to 1 MiB,
citations to 256 characters and quote text to 4096; terminal control escapes
are rejected. An unknown author renders without a portrait.

The shared canvas uses the smallest measured terminal/monitor grid. Portraits
are hidden when either dimension cannot fit. Wrapping accounts for CJK,
combining marks, emoji and long words. All bundled entries fit **40×24** and
the audit's larger grids. In a **20×8** reading area, an entry that cannot fit
in full shows **“Resize to read quote” plus its citation**, never a truncated
quotation. Grids too small even for that return a clear error.

The portraits in this release remain **AI-imagined illustrations**, not
historical photographs. Rebuild details are in [docs/ART.md](docs/ART.md).

## Remove

```bash
omastoic uninstall
# Or use Omarchy's normal removal:
omarchy plugin remove io.github.rastermanden.omastoic
```

CLI uninstall stops/disables the service, restores owned branding, removes its
menu block and owned plumbing, and asks Omarchy to remove the plugin. Host
removal also triggers the independent Bash cleanup watcher. Quotes/settings
remain; `omastoic uninstall --purge` removes those too. Changed/unrelated
launchers, completions, unit files and art are not overwritten or deleted.
Conflicts are reported instead of hidden. A failed/partial setup can be retried
or removed with the same commands (or `./uninstall.sh` from the checkout).

Implementation details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

```bash
bun test tests
omarchy plugin validate .
```

Tests require the real Omarchy host parser, defaults and branding reset command.
On an Omarchy desktop they are read from `/usr/share/omarchy`; elsewhere set
`OMARCHY_TEST_ROOT` to a checkout of the audited host revision
`5eb922f137422ff32a90869a9ba47525a428792d`. GitHub Actions uses that pinned host,
Bun 1.4.4, sandboxed HOME/XDG directories, the Bun suite, Bash syntax checks and
`omarchy plugin validate`. No test launches a real saver or changes installed
plugins, shell config, services or branding.

Coverage includes the actual host menu parser/parent graph, migration and
comment-preserving round trips, every quote across the audit size grid,
config/file ownership, setup failure/retry, concurrent writes, host disable and
remove/re-add, Restore Default, fragmented socket events and reconnect snapshots.
The offline source-ledger checks protect the reviewed citations and wording;
they are not a claim that software can verify ancient authorship.

MIT licensed code. Translation editions and artwork provenance:
[CREDITS.md](CREDITS.md). Release history: [CHANGELOG.md](CHANGELOG.md).
