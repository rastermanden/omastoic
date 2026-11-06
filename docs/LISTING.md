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
idle, Marcus Aurelius looks back at you; a minute later it is Seneca, or
Epictetus, or the man who founded the school on an Athenian porch. Six
braille portraits, and 64 entries from public-domain US translations, every one
cited by book and section. This release supports the terminal/ttfx screensaver,
audited on Omarchy 4.5.0rc3 and regression-tested with the 4.5.0 host parser
and branding CLI, not the newer native renderer.

It does not replace, shadow or patch anything Omarchy ships. The screensaver
already re-reads `~/.config/omarchy/branding/screensaver.txt`; Omastoic keeps
a freshly composed canvas in that file and swaps it between effects. One
**Stoics** toggle sits in Appearance → Branding → Screensaver next to Edit Text, Set From
Image and Restore Default. Omarchy's own branding commands win — set the art
some other way and the Stoics stand aside.

## Feature bullets

- Six braille portraits and 64 cited quotes (Marcus, Seneca, Epictetus, Zeno, Cleanthes, Chrysippus).
- Rotates only while the screensaver is actually on screen.
- **Appearance → Branding → Screensaver → Stoics** is the single on/off row.
- 60 seconds per canvas by default, configurable; the host reads changes at effect boundaries.
- Choose which bundled quotes from each Stoic stay in rotation, and add your own.
- Stands aside when `omarchy branding screensaver` writes the slot.
- Your quotes and settings survive uninstall; `--purge` drops them.

## Install

```bash
omarchy plugin add https://github.com/rastermanden/omastoic.git --enable
```

Needs Bun (`omarchy pkg add bun`) and the terminal/ttfx host backend. Then
`omastoic preview` selects Stoics and launches the saver; `omastoic show` is a
read-only text export. Update Git-managed installs with
`omarchy plugin update io.github.rastermanden.omastoic`.

Remove it cleanly with:

```bash
omastoic uninstall
```

`omarchy plugin remove io.github.rastermanden.omastoic` hides the menu row
and cleans leftover files; quotes stay in `~/.config/omastoic/`.

## One line

The Stoics on your Omarchy screensaver — portraits and cited quotes in the
slot Omarchy already reads.

## Artwork

Listing still: [preview.png](../preview.png). README motion and the longer clip
are [release assets](https://github.com/rastermanden/omastoic/releases/latest)
(`preview.gif`, `demo.mp4`) so `omarchy plugin add` does not clone ~4.5MB of
video.

## Disclosures

- Omastoic writes `~/.config/omarchy/branding/screensaver.txt`, the file
  Omarchy's screensaver already reads. It tracks what it wrote and will not
  overwrite art it does not own.
- It adds one **Stoics** row to `~/.config/omarchy/extensions/omarchy-menu.jsonc`
  inside a marked block, and a user systemd service that runs only while
  selected. Plugin disable stops and disables rotation; hot reload does not.
- Plugins run unsandboxed as the logged-in user inside `omarchy-shell`;
  review the source before enabling it.
- The portraits are AI-generated likenesses, labelled as such, not photographs
  of surviving busts; credited translations are public domain in the US. Credits in
  [CREDITS.md](../CREDITS.md).
