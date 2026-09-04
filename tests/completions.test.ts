import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTHORS_PLACEHOLDER, authorCompletionList, renderCompletion } from "../src/completions.ts";

const root = join(import.meta.dir, "..");
const tsv = readFileSync(join(root, "data/authors.tsv"), "utf8");

test("completion authors are all plus every slug in authors.tsv order", () => {
  expect(authorCompletionList(tsv)).toBe(
    "all marcus seneca epictetus zeno cleanthes chrysippus",
  );
});

test("a seventh Stoic in the TSV is offered for tab completion", () => {
  const extra = `${tsv}musonius\tMusonius Rufus\tc. AD 30 – 100\n`;
  expect(authorCompletionList(extra)).toContain("musonius");
  expect(authorCompletionList(extra).startsWith("all ")).toBe(true);
});

test("the bash and fish templates take the author list at setup", () => {
  const bash = readFileSync(join(root, "completions/omastoic.bash"), "utf8");
  const fish = readFileSync(join(root, "completions/omastoic.fish"), "utf8");
  expect(bash).toContain(`local authors="${AUTHORS_PLACEHOLDER}"`);
  expect(fish).toContain(`-xa "${AUTHORS_PLACEHOLDER}"`);
  expect(bash).not.toContain("marcus seneca epictetus");
  expect(fish).not.toContain("marcus seneca epictetus");

  const authors = authorCompletionList(tsv);
  const renderedBash = renderCompletion(bash, authors);
  const renderedFish = renderCompletion(fish, authors);
  expect(renderedBash).toContain(`local authors="${authors}"`);
  expect(renderedFish).toContain(`-xa "${authors}"`);
  expect(renderedBash).not.toContain(AUTHORS_PLACEHOLDER);
  expect(renderedFish).not.toContain(AUTHORS_PLACEHOLDER);
});
