# Builder contract

This file is the single source of truth for how work happens in this repo.
Every coding agent finds it. Claude Code reads `CLAUDE.md`, Gemini CLI and
Antigravity read `GEMINI.md`, and Copilot reads `.github/copilot-instructions.md`.
Each of those files is a thin pointer to this file. Codex, OpenCode, Cursor,
Pi, Grok, and Antigravity read `AGENTS.md` directly. Edit only this file so
the pointers stay in sync.

Skills live in `.agents/skills/`. Every agent reads that directory except
Claude Code, which reads `.claude/skills/`. That copy is a real directory kept
identical to `.agents/skills/` by a verify check, because `omarchy plugin
validate` rejects symlinks. Edit a skill in `.agents/skills/` and copy the
change to `.claude/skills/`. The check fails when the two drift.

## Before any change

Read `.agents/skills/projekt-workflow/SKILL.md`. It defines the loop for every
change: an issue with a Done-check, blast radius, build, verify, an independent
review, and the owner as publish gate. Read [VISION.md](VISION.md) too. Every
issue and change is checked against it.

## Skills, and when to use them

- `projekt-workflow`. The loop for every change. Start here.
- `issue-fra-observation`. Turns a loose observation into an issue with
  Problem, Expected, and Done-check.
- `blast-radius`. Checks what a change could break before it ships.
- `unslop`. Removes AI patterns and filler from user-facing text.
- `interrogate`. Runs an independent review, never on your own work.
- `correct`. Fixes the repeated mistake class after a review round.
- `show-me-your-work`. Writes a record for a long or unattended run.
- `typesafe-ai`. Runs the optional TypeSafe judge, only when the owner calls it.
- Other pstack skills (`architect`, `poteto-mode`, `tdd`, `setup-pstack`, and
  so on) are available when they fit. They are not project rules.

## JOB

Change Omastoic so it still matches [VISION.md](VISION.md). Read that file
before editing. A change that breaks a principle does not land unless VISION.md
is changed first, on purpose.

## SOURCES

- The issue: Problem, Expected, and Done-check.
- VISION.md.
- The code and tests that the change touches.
- Upstream Omarchy contracts when a host API is involved. Check the current
  contract; do not trust a remembered version.

## JUDGMENT

Done means every Done-check is met or marked not testable here, `bun run verify`
exits 0, and CI on the pull request is green. A headless check does not replace
a live Omarchy run when the Done-check needs one.

## OUTPUT

A pull request the owner can merge. Describe what changed, which issue it
closes, the verify result, and what a person still needs to check by hand.
Do not merge, tag, or release.

## Hard rules

- Never merge, tag, release, push to main, or comment on the Omarchy
  marketplace issue without the owner's explicit approval. Open pull requests
  only.
- Never put personal names, email addresses, home paths, or tokens in code or
  commits.
- The TypeSafe judge runs only from the owner's operator, never in CI.
- Never put API keys (`TYPESAFE_API_KEY` or any other) in the repo, CI, or
  commits.
- Do not fetch anything at runtime.
- Do not delete or overwrite a file that is not provably Omastoic's.
- Do not add a quote that has no author and exact source.

## Working mode

The builder works in `/poteto-mode`. Read
`.agents/skills/poteto-mode/SKILL.md` first, then follow its principles and
playbooks.

The owner's rules win over poteto-mode's Autonomy section. Never merge, tag,
release, push to main, or comment on the Omarchy marketplace issue without the
owner's explicit approval. Open pull requests only.

## Working loop

1. Start from an issue with Problem, Expected, Done-check, and a vision fit.
2. Before building, write down the blast radius: files, user data, and what
   must stay untouched.
3. Run an unslop pass on user-facing text: plain words, no jargon, no filler.
4. For a UI change, audit the design before editing and polish it after.
   Real screenshots come before it ships.
5. Commit with a message that ends in `Fixes #N`, and add a verify check for
   that Done-check when it can run headlessly.
6. Ask for an independent review. Do not review your own change as if it were
   someone else's. Every confirmed finding becomes an issue if it is not fixed
   in this change.
7. `bun run verify` must be green before the change is called live. CI must be
   green before the owner is asked to merge.
8. After each review round, correct the change from the findings, then re-run
   verify.
9. End the run with a handoff kept outside the repo: TASK, STATUS, OUTPUT,
   SOURCES, REVIEWS, DONE-EVIDENCE (raw command output), DECISIONS,
   UNCERTAINTIES, DO-NOT-ASSUME.

## Lessons

Rules from past corrections, each with what enforces it.

- A QML method must not reuse an Item property name. `Item.focus` is a
  property, so a `function focus()` does not shadow it and calling it throws.
  `tests/qml.test.ts` fails if a `function focus()` reappears.
- A QML delegate that declares any required property and reads `index` must
  also declare `required property int index`. Without that declaration
  `index` is undefined and every row acts as row 0. `tests/qml.test.ts` fails
  when a delegate does that.
- Green `bun run verify` and green CI are not done on their own. The working
  loop above is part of done, and its review and unslop steps are not optional.
- Never put symlinks in the agent directories, and exclude every agent file
  from `.gitattributes` and `install.sh`. `omarchy plugin validate` rejects
  symlinks anywhere in a plugin folder, so `.claude/skills/` must stay a real
  mirror of `.agents/skills/`. `tests/agent-config.test.ts` fails on any
  symlink under `.agents`, `.claude`, `.cursor`, or `.gemini`, on mirror drift,
  or on a missing pointer or exclusion.
