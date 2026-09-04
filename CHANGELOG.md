# Changelog

All notable changes to Omastoic are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`manifest.json` and `package.json` carry the same version.

## 1.5.1 - 2026-09-04

### Fixed

- Live grid readout missed Ghostty. GTK single-instance reports one pid for
  every window, and `/proc/<pid>/task/<pid>/children` often omits the shell, so
  walking from the Hyprland client never reached a pts. The probe now reads
  `stty` on `omarchy-screensaver` / `ttfx` themselves.
- `omastoic status` no longer sits on the 14.4×33.3 fallback until a screensaver
  has opened: it scales a cell from the open default terminal (18pt, no pad).
- Prune no longer treats a git checkout that briefly unlinks `manifest.json`
  as `plugin remove`. The plugin directory still being there is enough.

## 1.5.0 - 2026-09-04

### Changed

- The canvas grid is read from the screensaver terminal itself (`stty` on the
  live tty) instead of assuming foot's 14.4×33.3 cell. The measured cell is
  remembered so the next canvas, written before the screensaver opens, already
  fits Alacritty, Ghostty, Kitty or Foot. `omastoic status` shows which source
  was used.

## 1.4.1 - 2026-09-04

### Fixed

- `omarchy plugin update` re-runs setup when the plugin tree changes, so the
  menu row, completions and systemd unit follow the new tree without a shell
  restart.
- `omarchy plugin remove` hides the Style → Screensaver rows as soon as the
  plugin folder is gone, and a leftover cleaner takes the launcher,
  completions and unit with it.
- The rotation daemon re-reads `interval` on each tick, so editing
  `~/.config/omastoic/config.json` no longer needs `systemctl --user restart
  omastoic`.
- `setup --quiet` no longer prints when it writes the menu row.

## 1.4.0 - 2026-09-04

### Added

- Tab completion for `omastoic` on bash and fish (`toggle`, `preview`, `config`,
  `--authors`, `--interval`, `--purge`). Installed by setup into
  `~/.local/share/bash-completion/completions/omastoic`.

## 1.3.1 - 2026-09-04

### Fixed

- `omastoic config` multi-select: gum 2 toggles with `x` or `tab`, not space.
  The picker now says so, and `--limit` is set so toggle is actually enabled.

## 1.3.0 - 2026-09-04

### Added

- `omastoic config` chooses which Stoics appear and how many seconds between
  quotes. Style → Screensaver → Configure opens the same picker in a terminal.
  `omastoic config --authors marcus,seneca --interval 15` works without gum.

## 1.2.3 - 2026-09-04

### Fixed

- The user systemd unit does not start if the plugin folder is gone
  (`ConditionPathExists`), so `omarchy plugin remove` without `omastoic
  uninstall` cannot restart-loop on a missing binary.

### Changed

- README matches the Omarchy plugin guide's shape (Install, Usage, Configure,
  Remove) and documents `omarchy plugin validate`.

## 1.2.2 - 2026-09-04

### Fixed

- `omastoic uninstall` now runs `omarchy plugin remove`, so a later
  `omarchy plugin add` is not refused with "plugin id already used". The
  leftover folder also kept the service enabled, which would set the Stoics
  up again on the next shell start.

## 1.2.1 - 2026-09-04

### Fixed

- `omastoic preview` no longer prints Omarchy's `socat … Broken pipe` after
  the screensaver is already up. Real launcher errors still come through.

## 1.2.0 - 2026-09-04

### Changed

- The screensaver slot is Omarchy's again. Style → Screensaver keeps Edit Text,
  Set From Image and Restore Default; Omastoic adds one **Stoics** toggle
  beside them. Toggling off restores the art the Stoics displaced.
- The public CLI is `toggle`, `preview`, `status` and `uninstall`. The old
  picker (`choose` / `use` / `slates`) and the extra on/off/install surface
  are gone from help; branding commands remain the way you set art.

### Removed

- The preview-tile screensaver gallery, user slates under
  `~/.config/omastoic/screensavers/`, and the Previous / Replaced / Omarchy
  named looks. They were a second screensaver product on a slot Omarchy
  already manages.

## 1.1.0 - 2026-09-04

### Added

- Install as an Omarchy plugin: `omarchy plugin add https://github.com/rastermanden/omastoic.git --enable --yes`.
  The checkout lives in `~/.config/omarchy/plugins/omastoic`, so deleting the
  clone you installed from no longer takes the screensaver with it.
- A `service` plugin that runs `omastoic setup --on-first` when enabled, so
  `plugin add --enable` is the whole install — no extra setup step.
- `omastoic setup` for idempotent plumbing (launcher, menu row, systemd unit)
  without touching the screensaver slot.
- `./install.sh` / `./uninstall.sh` for a local checkout.
- `omastoic uninstall --purge` drops quotes, settings and cache as well.

### Changed

- README install path is `omarchy plugin add`. The old `git clone && ./bin/omastoic install` still works from a checkout, but the plugin copy is what the service and launcher now point at.

## 1.0.0 - 2026-08-30

### Added

- Six Stoic portraits and 64 cited public-domain quotes on the Omarchy screensaver.
- Rotation while the screensaver is on screen, driven by Hyprland window events.
- Style → Screensaver menu rows, a preview-tile picker, and on/off that stands
  aside when Omarchy's own branding commands write the slot.
