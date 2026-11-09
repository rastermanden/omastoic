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
   demand and injects `shell`, `manifest`, `open(payload)` and `close()`. The
   item is a `PanelWindow` overlay: scrim, `Esc` and scrim-click to dismiss, one
   card in the middle. There is no bar-widget entry point, so nothing has to be
   added to the bar layout in `shell.json`.

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
- [ ] `omastoic panel state` / `panel apply` in `src/cli.ts`, with Bun tests in
      `tests/panel.test.ts` that assert the saved JSON equals what
      `omastoic config --authors … --interval …` writes.
- [ ] `omastoic ui` summon command, with the `omarchy-shell` stub in tests.
- [ ] `ui/Panel.qml` plus manifest wiring.
- [ ] `scripts/check-qml.ts`: rewrites the `qs.` imports against the host shell
      directory and runs `qmllint`, so the QML is machine-checked instead of
      eyeballed.
- [ ] `STATUS.md`: what works, how to open it, what is missing.

## Non-goals

Per-quote checklists and the full author/quote pickers stay in `omastoic config`
in a terminal. Editing or removing an existing custom quote is out of scope for
the first version; the panel only adds.
