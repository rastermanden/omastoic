# Listing copy

Ready-to-paste text for the Omarchy plugin marketplace, the GitHub
repository, and release posts.

## Marketplace fields

| Field | Value |
| --- | --- |
| Name | Omastoic |
| Category | Look & Feel |
| Short description | The Stoics on your Omarchy screensaver: braille portraits and cited quotes from Marcus Aurelius, Seneca, Epictetus and the founders of the school. |
| Repository | <https://github.com/rastermanden/omastoic> |
| License | MIT |
| Tags | `screensaver`, `stoic`, `quotes`, `branding`, `bun` |
| Suggested GitHub topics | `omarchy`, `omarchy-plugin`, `screensaver`, `stoicism`, `bun` |

## Long description

Omastoic puts the Stoics on the Omarchy screensaver. When the screen goes
idle, Marcus Aurelius looks back at you out of the Munich Glyptothek; a
minute later it is Seneca, or Epictetus, or the man who founded the school
on an Athenian porch. Six portraits transcoded from museum photographs, and
64 quotes from public-domain translations, every one cited by book and
section.

It does not replace, shadow or patch anything Omarchy ships. The screensaver
already re-reads `~/.config/omarchy/branding/screensaver.txt`; Omastoic keeps
a freshly composed canvas in that file and swaps it between effects. One
**Stoics** toggle sits in Style → Screensaver next to Edit Text, Set From
Image and Restore Default. Omarchy's own branding commands win — set the art
some other way and the Stoics stand aside.

## Feature bullets

- Six braille portraits and 64 cited quotes (Marcus, Seneca, Epictetus, Zeno, Cleanthes, Chrysippus).
- Rotates only while the screensaver is actually on screen.
- **Style → Screensaver → Stoics** is the on/off, with a ✓ when they have the slot.
- Stands aside when `omarchy branding screensaver` writes the slot.
- Your quotes and settings survive uninstall; `--purge` drops them.

## Install

```bash
omarchy plugin add https://github.com/rastermanden/omastoic.git --enable --yes
```

Needs bun (`omarchy pkg add bun`). Then `omastoic preview` to see it now.

Remove it cleanly with:

```bash
omastoic uninstall
```

Removing the plugin keeps your quotes in `~/.config/omastoic/`.

## One line

The Stoics on your Omarchy screensaver — portraits and cited quotes in the
slot Omarchy already reads.

## Artwork

Listing still: [preview.png](../preview.png). README motion:
[preview.gif](../preview.gif). Longer clip: [demo.mp4](../demo.mp4).

## Disclosures

- Omastoic writes `~/.config/omarchy/branding/screensaver.txt`, the file
  Omarchy's screensaver already reads. It tracks what it wrote and will not
  overwrite art it does not own.
- It adds one **Stoics** row to `~/.config/omarchy/extensions/omarchy-menu.jsonc`
  inside a marked block, and a user systemd service that runs only while
  you are logged in.
- Plugins run unsandboxed as the logged-in user inside `omarchy-shell`;
  review the source before enabling it.
- Portrait sources are public domain or CC0; translations are out of
  copyright. Credits in [CREDITS.md](../CREDITS.md).
