# Quickshell settings panel

A small QML panel for the settings that `omastoic config` already owns: which
Stoics are in rotation, how many seconds each quote stays up, your own authors
and quotes, and each quote's switch. It reads and writes the same
`~/.config/omastoic/config.json`, `quotes.tsv` and `authors.tsv` through the
CLI, so there is one validator, one lock and one daemon-restart path — never a
second writer with its own idea of the format.

## Shape

1. **CLI bridge, not file access from QML.** Two new subcommands:
   - `omastoic panel state` prints the normalized settings plus the roster as
     JSON on stdout. Read-only: it takes no lock and writes nothing.
   - `omastoic panel apply <json>` (or the same JSON on stdin) validates the
     payload, appends a custom quote through the existing `appendQuotes`, saves
     atomically and restarts an enabled daemon. It prints the new state, so the
     panel needs one round trip per change and renders only saved values.

   Payload kinds: `interval`, `authors`, `mineOnly`, `keep`, `portrait`,
   `addQuote`, `editQuote`, `deleteQuote`, `addAuthor`, `removeAuthor`.

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
   whatever the file contained — a bare `Item {}` and a renamed file failed the
   same way, while the identical file in another plugin directory loaded. The
   message comes from Qt's type loader (`QQmlTypeLoader::loadThread`); a
   standalone Quickshell with the same file and path did not reproduce it, so
   the exact cause is not known. The same file one directory down loads, so the
   entry point stays in `ui/`.

   `bin/omastoic` is found through the manifest's `__sourceDir` — the host keeps
   that field on the manifest it hands a third-party plugin — so the panel does
   not assume where the plugin is installed. A bare `Panel` outside the host
   (the smoke harness) falls back to the file's own directory.

3. **Host components reused** from `/usr/share/omarchy/shell`:
   `qs.Ui.Button` (the Stoic and author chips), `qs.Ui.ButtonGroup` (the list
   filters), `qs.Ui.NumberField` (seconds per quote), `qs.Ui.TextField` (quote,
   source, author names), `qs.Ui.ToggleSwitch` (each quote's switch),
   `qs.Ui.PanelSectionHeader`, `qs.Ui.PanelSeparator`, `qs.Ui.Caption`, and
   `qs.Commons.Style` / `Commons.Color` for every color, size and font. The
   `qs.Ui.Panel` base is *not* reused: it is the bar-widget popup base and needs
   a live bar instance plus an anchor item, and a summoned overlay has neither.

4. **Every change saves at once.** Stoic chips, the Yours chip, each quote's
   switch, the seconds field (after it stops changing), the add form and the
   editor each send one `panel apply`; writes queue one at a time, the row flips
   first and the state the CLI echoes back is what stays on screen. No Stoic
   picked is saved as `mineOnly`, never as an empty list (which means every
   Stoic).

   Adding a quote starts with its author. The add form lists the six Stoics and
   your own authors as chips, plus **+ New author** (name, optional dates,
   optional picture through Omarchy's image grid). Creating an author writes
   `~/.config/omastoic/authors.tsv` and the portrait, then selects them, so the
   quote that follows attaches to that author. Quotes by an author the roster
   does not know always rotate, whatever the Stoic picks are.

   Your own quotes open for editing when clicked: quote, source and author are
   editable, the author's portrait can be added, changed or removed, and Delete
   asks once before it writes. Comments and other lines in `quotes.tsv` are kept
   exactly; the per-quote switches are renumbered when a quote is deleted.

   Earlier note, kept for history: **Save refuses what the CLI would misread.** An empty pick means "every
   Stoic" to the CLI, so the panel never sends one: with the toggle off and
   nobody picked, Save is disabled and a hint says why. A quote with a citation
   or text but a missing field also disables Save and keeps what was typed. CLI
   stderr is shown only when the command failed; a successful run may still
   warn there.

5. **Opening.** `omastoic ui` runs `omarchy-shell shell toggle <plugin id>`, so a
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

## Non-goals and limits

- Per-quote checklists and the full author/quote pickers stay in
  `omastoic config` in a terminal.
- Removing an author of your own is CLI-only (`omastoic author remove <name>`),
  and refuses while any quote still uses them.
- No bar-widget entry point and no installed keybind: the panel opens by
  command. Bind `omastoic ui` in `~/.config/hypr/bindings.conf` for a key.
- Strings are English literals; the host kit's `I18n` is not used yet.
- `check-qml.ts` lints against `$OMARCHY_TEST_ROOT` or `/usr/share/omarchy`
  only; another Omarchy version may name the same components differently.
