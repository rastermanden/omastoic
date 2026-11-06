# Terminal-backend lifecycle

This is the maintained terminal/ttfx implementation, not a native renderer port.
Omarchy owns saver launch, effects, dismissal and locking. Omastoic only writes
`omarchy/branding/screensaver.txt` under XDG config.

## Setup and ownership

`Service.qml` is a headless item inside the host shell. Its first load calls
`setup --on-first`; subsequent loads refresh plumbing but respect the source
toggle. Setup preflights dependencies, the menu document and artifact conflicts.
Only after all systemctl calls and activation succeed is `state/omastoic/installed`
written. Failure disables the units, restores owned branding, and leaves owned
plumbing available for retry/uninstall. A content fingerprint of code, data,
art and manifest restarts a selected daemon after updates, even if unit text
has not changed.

A kernel `flock` on a persistent file in XDG state serializes setup, config,
toggle, branding writers and cleanup. The daemon locks each rotation, not its
entire lifetime. Locks are released on process exit; waits are bounded. Unique
temporary files and atomic renames avoid partial reads. Menu writes additionally compare the source
again before replacement. External editors do not participate in this lock;
comparison detects changes during asynchronous work, but cannot provide a
filesystem-wide compare-and-swap against arbitrary external writers.

Generated files have SHA-256 ownership records in `state/omastoic/owned/`;
the CLI symlink has a recorded target. Conflicts fail closed. Cleanup removes
only unchanged owned files. Known 2.1 plumbing is adopted on upgrade; a backup
is not by itself proof that branding belongs to Omastoic. Displaced art records
whether the slot was absent, so teardown can restore absence as well as text.

The menu editor inserts one trailing-comma row **first** inside the outer object
(or its `items` envelope). It never needs to modify a user's last separator.
It validates the host's whole-line-comment/trailing-comma grammar, preserves
neighbouring bytes, and migrates legacy rows only inside our marked block.

## Disable, removal and branding reset

`omastoic.service` runs only when the Stoics source is selected. `off` disables
and stops it. The independent `omastoic-prune.path` watches the plugin directory,
host `shell.json`, and branding file. Its installed Bash reconciler survives
plugin removal without Bun. QML destruction also requests that reconciler.

The reconciler checks **durable host config**, not merely whether a QML item
was destroyed. If the plugin is still enabled and branding is owned, hot reload
is a no-op. On confirmed disable it stops/disables rotation and restores owned
art, keeping plumbing for re-enable. On removal it also removes the owned menu,
launcher, completions, units and install marker. Invalid/transient host config
or an existing checkout without a manifest is not evidence of removal. Branding
replacement (including Restore Default) turns the source off without touching
the replacement. The 2-second settle period and shared lock avoid treating our
own atomic branding writes as external replacement.

## Rotation

The daemon subscribes to the Hyprland UNIX stream **before** taking a clients
snapshot, then replays buffered events. Reconnect replaces stale window state.
The streaming UTF-8 decoder retains fragmented records; record and queue caps
force reconnect/reconciliation rather than unbounded memory growth.

There is no periodic rotation timer while no saver windows are open. The
configurable timer defaults to 60 seconds; another monitor opening does not
interrupt a quote already being read. Each rotation reads `config.json` and
`quotes.tsv`. Omitting `quotes` keeps every bundled line for the selected
authors. A per-author id list keeps only those bundled lines. Lines in
`quotes.tsv` are added too, unless `addedOff` names that line. When a filter
matches nothing, rotation uses the fallback in the README settings section.
PTY/monitor sizing is shared across outputs, with quote-only fallback. The
host rereads branding between effects, so file cadence and visible effect
cadence are distinct.

`show --cols … --rows …` is a non-mutating text export. `preview` is deliberately
mutating: it selects the source and launches Omarchy's saver. Tests stub that
external boundary; neither command is used to preview on the maintainer's real
desktop during automated validation.
