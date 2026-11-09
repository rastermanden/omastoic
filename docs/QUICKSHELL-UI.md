# Quickshell settings panel

A small QML panel for the settings that `omastoic config` already owns: which
Stoics are in rotation, how many seconds each quote stays up, and adding one of
your own quotes. It reads and writes the same
`~/.config/omastoic/config.json` and `quotes.tsv` through the CLI, so there is
one validator, one lock and one daemon-restart path — never a second writer
with its own idea of the format.

## Shape

1. **CLI bridge, not file access from QML.** Two new subcommands:
   - `omastoic panel state` prints the normalized settings plus the roster as
     JSON on stdout. Read-only: it takes no lock and writes nothing.
   - `omastoic panel apply <json>` (or the same JSON on stdin) validates the
     payload, appends a custom quote through the existing `appendQuotes`, saves
     atomically and restarts an enabled daemon. It prints the new state, so the
     panel needs one round trip per change and renders only saved values.

   Both reuse the `src/cli.ts` helpers (`parseInterval`, `normalizeSettings`,
   `compactSettings`, `appendQuotes`, `saveSettings`), so a panel write cannot
   reach a state that `omastoic config` would refuse. QML never parses or
   writes `config.json` itself.

2. **`ui/Panel.qml`, a `panel`-kind entry point.** The manifest gains
   `kinds: ["service", "panel"]` and `entryPoints.panel`. The host loads it on
   demand and injects `shell`, `manifest` (with `__sourceDir`), `open(payload)`
   and `close()`. The item is a `PanelWindow` overlay: scrim, `Esc` and
   scrim-click to dismiss, one card in the middle. There is no bar-widget entry
   point, so nothing has to be added to the bar layout in `shell.json`.

   The panel lives in `ui/` rather than at the plugin root because the host
   would not load it from there: every attempt answered with Qt's
   `File name case mismatch` (`Panel.qml[-1:-1]`), for that path only and
   whatever the file contained. The same file one directory down loads, so the
   entry point stays in `ui/`.

   `bin/omastoic` is found through the manifest's `__sourceDir` — the host keeps
   that field on the manifest it hands a third-party plugin — so the panel does
   not assume where the plugin is installed. A bare `Panel` outside the host
   (the smoke harness) falls back to the file's own directory.

3. **Host components reused** from `/usr/share/omarchy/shell`:
   `qs.Ui.MultiSelect` (the Stoic roster), `qs.Ui.Toggle` (all six on/off),
   `qs.Ui.NumberField` (seconds per quote), `qs.Ui.TextField` (author,
   citation, quote text), `qs.Ui.Button`, `qs.Ui.PanelHero`,
   `qs.Ui.PanelSectionHeader`, and `qs.Commons.Style` / `Commons.Color` for
   every color, size and font. The `qs.Ui.Panel` base is *not* reused: it is the
   bar-widget popup base and needs a live bar instance plus an anchor item, and a
   summoned overlay has neither.

4. **Opening.** `omastoic ui` runs `omarchy-shell shell toggle <plugin id>`, so a
   Hyprland keybind or a terminal can open and close the panel. The same works
   with `omarchy-shell shell toggle io.github.rastermanden.omastoic` directly.

## Steps

- [x] Plan (this file).
- [x] `omastoic panel state` / `panel apply` in `src/cli.ts`, with Bun tests in
      `tests/panel.test.ts` that assert the saved JSON equals what
      `omastoic config --authors … --interval …` writes.
- [x] `omastoic ui` summon command, with the `omarchy-shell` stub in tests.
- [x] `ui/Panel.qml` plus manifest wiring.
- [x] `scripts/check-qml.ts`: rewrites the `qs.` imports against the host shell
      directory and runs `qmllint`, so the QML is machine-checked instead of
      eyeballed. `bun run qml`, and `tests/qml.test.ts` fails on a real problem.
- [x] `scripts/qml-smoke.ts`: loads the panel in a throwaway Quickshell config
      against the host kit and a fake CLI, so open/read/edit/save is exercised
      end to end (`bun scripts/qml-smoke.ts`; opt-in, it needs a Wayland
      session).
- [x] `STATUS.md`: what works, how to open it, what is missing.

## Loading it in the host shell

The shell keeps the QML it has compiled for the life of the process, and the
`Qt.clearComponentCache()` call it makes on a plugin reload does not exist in
the Qt 6.12 build shipped here, so an edited panel keeps running its first
version. After changing panel code:

1. `rsync -a --exclude .git --exclude node_modules <worktree>/ \
    ~/.config/omarchy/plugins/io.github.rastermanden.omastoic/`
2. `omarchy-restart-shell`
3. `omarchy-shell shell toggle io.github.rastermanden.omastoic`

A plugin reload on its own re-creates the panel's `Loader`, which closes an open
panel and picks up a *new* entry-point URL, but it does not recompile a file
whose URL the engine already knows.

## Non-goals

Per-quote checklists and the full author/quote pickers stay in `omastoic config`
in a terminal. Editing or removing an existing custom quote is out of scope for
the first version; the panel only adds.
