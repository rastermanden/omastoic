# Builder contract

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

## FORBIDDEN
- Merging, tagging, releasing, or commenting on the marketplace issue unless
  the owner asked for that action in this run.
- Fetching anything at runtime.
- Deleting or overwriting a file that is not provably Omastoic's.
- Adding a quote that has no author and exact source.
- Putting personal names, email addresses, home paths, or tokens in code or
  commits.

## Working mode
The builder works in `/poteto-mode`. Read
`.cursor/skills/poteto-mode/SKILL.md` first, then follow its principles and
playbooks. These skills sit next to pstack.

- `issue-fra-observation` turns a loose observation into a GitHub issue.
- `projekt-workflow` is the loop for each change.
- `typesafe-ai` is the optional TypeSafe judge. Use it only when the owner runs
  a judge call.

The owner's rules win over poteto-mode's Autonomy section. Never merge, tag,
release, push to main, or comment on the Omarchy marketplace issue without the
owner's explicit approval. Open pull requests only.

`TYPESAFE_API_KEY` and any other API key stay out of the repo, CI, and commits.
Judge calls run only from the owner's operator, not in CI.

Map this loop onto pstack:
- `/blast-radius` before building
- `/unslop` on user-facing text
- `/interrogate` for an independent review
- `/correct` after each review round
- `show-me-your-work` for a long run

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
