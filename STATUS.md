# Status: Quickshell settings panel

Branch `feat/quickshell-config-ui`, worktree `/home/mbj/Work/omastoic-wt/quickshell-ui`.
Everything below is committed locally; nothing was pushed.

## What works

The plugin now has a `panel` entry point (`ui/Panel.qml`) next to its `service`
one, so the Omarchy shell can open a settings card for the three things
`omastoic config` already owns:

- **The Stoics in rotation.** A `MultiSelect` over the roster plus an "all six"
  `Toggle`. The roster (slug, name, dates) comes from the CLI, not from QML.
- **Seconds per quote.** A `NumberField`, 1-3600 in steps of 5.
- **One of your own quotes.** Author slug, citation and text; `Save` appends it
  through the existing `appendQuotes` path.

`Save` sends one JSON object to `omastoic panel apply`, and the panel renders the
state that command echoes back, so it never shows a value the CLI refused.
`Reload` re-reads `omastoic panel state`. `Esc` and the scrim dismiss it.

QML never touches `~/.config/omastoic`: reads are `omastoic panel state`, writes
are `omastoic panel apply <json>`, so `config.json` keeps one validator, one
lock and one daemon-restart path.

Verified on this machine:

- `bun test` — 227 tests pass, including `tests/panel.test.ts` (the `panel`
  subcommands write exactly what `config --authors … --interval …` writes) and
  `tests/qml.test.ts` (the entry points compile against the host kit, the panel
  stays a summoned panel, and it only talks to the CLI).
- `bun run qml` (`scripts/check-qml.ts`) — `qmllint` against
  `/usr/share/omarchy/shell`, no real problems; only the kit's
  `Style`/`Commons.Color` "member not found" noise, which is filtered.
- `bun scripts/qml-smoke.ts` — a throwaway Quickshell config with the panel, the
  host kit and a fake CLI: open, render, edit, save, and the exact JSON the panel
  sends.
- In the running shell: `omarchy-shell shell toggle
  io.github.rastermanden.omastoic` opens the card, `hyprctl layers` shows the
  `omastoic-panel` overlay, and the journal is clean (no `File name case
  mismatch`, no failed `panel state`).

## How to open it

```
omarchy-shell shell toggle io.github.rastermanden.omastoic
omastoic ui                      # same thing, one wrapper
```

Bind `omastoic ui` to a key in `~/.config/hypr/bindings.conf` if you want a key.

To run the version from the worktree, sync it into the installed plugin first
(the shell loads QML only from `~/.config/omarchy/plugins/<id>`):

```
rsync -a --exclude .git --exclude node_modules --exclude STATUS.md \
  /home/mbj/Work/omastoic-wt/quickshell-ui/ \
  ~/.config/omarchy/plugins/io.github.rastermanden.omastoic/
omarchy-restart-shell
omarchy-shell shell toggle io.github.rastermanden.omastoic
```

## What was wrong when it would not open

Two separate problems, both host-side; both cost real time, so they are written
down here.

1. **`File name case mismatch` from the plugin root.** With the entry point at
   `Panel.qml` in the plugin root, the shell logged
   `file:///…/io.github.rastermanden.omastoic/Panel.qml[-1:-1]: File name case
   mismatch` and the panel never loaded. It was not the content (a bare
   `Item {}` failed the same way), not the file name (renaming it failed), not
   the manifest (`kinds` and `entryPoints` were right), not the QML cache, and
   the identical file in a *different* plugin directory loaded fine. Moving the
   entry point to `ui/Panel.qml` — a URL the engine had never compiled — fixed
   it, so that is where it lives. The message comes from Qt's type loader
   (`QQmlTypeLoader::loadThread` -> "File name case mismatch"); the case check
   itself could not be reproduced in a standalone Quickshell against the same
   file and path, so the exact reason it fails there is not fully explained.

2. **Compiled QML is kept for the life of the shell process.** After editing the
   panel, the shell kept running the first compiled version (its
   `Qt.clearComponentCache()` call is a no-op: that function does not exist in
   the Qt 6.12 build here). Reading the file from a new URL picks up new code; so
   does `omarchy-restart-shell`. Both are needed to develop against the live
   shell.

Also note `bin/omastoic` is resolved through the manifest's `__sourceDir` (the
host keeps that field for third-party plugins), not relative to the panel file,
because the panel sits one directory down.

## What is missing

- **Editing or removing an existing custom quote.** The panel only adds, like
  the first version of `omastoic config`'s own quote prompt.
- **Per-quote checklists and the full author/quote pickers.** Those stay in the
  terminal `omastoic config`; the panel edits the same fields, not more of them.
- **No bar-widget entry point.** Nothing appears in the bar; the panel is opened
  by command, keybind or `omastoic ui`.
- **No translations.** Strings are English literals; the host kit's `I18n` is not
  used yet.
- **No keybind is installed.** The panel is reachable by the commands above, and
  that is the whole wiring; adding a key is a user choice.
- **The panel is not checked against other Omarchy versions.** `check-qml.ts`
  lints against `$OMARCHY_TEST_ROOT`/`/usr/share/omarchy`; a different kit may
  name the same components differently.
