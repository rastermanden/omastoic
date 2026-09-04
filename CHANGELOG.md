# Changelog

All notable changes to Omastoic are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`manifest.json` and `package.json` carry the same version.

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
