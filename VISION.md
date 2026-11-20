# Vision

## Why Omastoic exists
An idle screen is a small pause in the day. Omastoic uses it to show one Stoic
thought, with an exact source, so the pause gets something worth reading.

## Who it is for
People who use Omarchy and want the screensaver to show something calm and
real, without having to configure much and without anything changing their
system in surprising ways.

## Principles
1. **One portrait, one cited thought.** Every quote has an author and an exact
   source (work, book, section). No quotes without a source.
2. **Omarchy owns the desktop.** We write the branding file Omarchy already
   reads. We never replace Omarchy's launcher, and Omarchy's own branding
   commands always win.
3. **Leave no trace.** Turning it off, disabling it or uninstalling it puts back
   exactly what was there before. Never delete or overwrite anything that is
   not provably ours.
4. **Safe by default.** Nothing is fetched at runtime, nothing needs root, and
   nothing runs that a reviewer cannot read in the repo.
5. **Beauty is a feature.** Aesthetics matter as much as correctness. The
   portrait, the type and the quote must look crafted, fit the user's Omarchy
   theme, and never look like a debug screen.
6. **A settings UI that is a joy to use.** The config UI must be exceptionally
   beautiful and dead simple: every choice understandable at a glance, sensible
   defaults, no jargon, no dead ends, and every change visible right away.
   UI changes get a design review (Impeccable audit and polish) and real
   screenshots before they ship.
7. **Small and calm.** One menu row, a few commands, sensible defaults. Add
   settings only when many users need them.
8. **Your settings survive.** Updates and reinstalls keep `~/.config/omastoic/`.
9. **Honest docs.** The README describes what was actually tested, on which
   Omarchy version, with screenshots from real runs.
10. **Follow Omarchy.** Support the native screensaver first and keep the older
   terminal saver working while people still use it.

## How this is used
Every issue and every change is checked against this file. If a change breaks
a principle, either the change goes, or this file is changed first, on purpose.
