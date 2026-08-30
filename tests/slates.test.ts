import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreviews, discover, find, STOICS, type SlatePaths } from "../src/slates.ts";

let root: string;
let paths: SlatePaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omastoic-slates-"));
  mkdirSync(join(root, "user"), { recursive: true });
  paths = {
    backup: join(root, "screensaver.txt.pre-omastoic"),
    userDir: join(root, "user"),
    omarchyLogo: join(root, "logo.txt"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the Stoics are always on offer, and always first", async () => {
  const slates = await discover(paths);
  expect(slates[0]).toEqual({ name: STOICS, kind: "stoics" });
});

test("only art that exists is offered", async () => {
  expect((await discover(paths)).map((s) => s.name)).toEqual([STOICS]);

  writeFileSync(paths.backup, "old art\n");
  writeFileSync(paths.omarchyLogo, "logo\n");
  writeFileSync(join(paths.userDir, "Waves.txt"), "~~~\n");

  expect((await discover(paths)).map((s) => s.name)).toEqual([
    STOICS,
    "Previous",
    "Omarchy",
    "Waves",
  ]);
});

test("user slates are named after their files, in order", async () => {
  writeFileSync(join(paths.userDir, "Zebra.txt"), "z");
  writeFileSync(join(paths.userDir, "Apple.txt"), "a");
  writeFileSync(join(paths.userDir, "notes.md"), "ignored");

  const names = (await discover(paths)).map((s) => s.name);
  expect(names).toEqual([STOICS, "Apple", "Zebra"]);
});

test("a user slate cannot shadow another name — the picker keys on it", async () => {
  writeFileSync(paths.backup, "old art\n");
  writeFileSync(join(paths.userDir, "Previous.txt"), "mine");
  writeFileSync(join(paths.userDir, "Stoics.txt"), "not the real ones");

  const slates = await discover(paths);
  expect(new Set(slates.map((s) => s.name)).size).toBe(slates.length);
  expect(slates.map((s) => s.name)).toContain("Previous 2");
  expect(slates.map((s) => s.name)).toContain("Stoics 2");
  expect(find(slates, STOICS)?.kind).toBe("stoics");
});

test("slates are found by name, ignoring case and stray spaces", async () => {
  writeFileSync(paths.omarchyLogo, "logo\n");
  const slates = await discover(paths);
  expect(find(slates, "omarchy")?.name).toBe("Omarchy");
  expect(find(slates, "  STOICS ")?.kind).toBe("stoics");
  expect(find(slates, "nothing")).toBeUndefined();
});

test("a preview is built for every slate that has content", async () => {
  writeFileSync(paths.omarchyLogo, "logo\n");
  writeFileSync(join(paths.userDir, "Empty.txt"), "   \n");

  const drawn: string[] = [];
  const previews = await buildPreviews(
    await discover(paths),
    join(root, "cache"),
    "stoics canvas",
    async (_canvas, out) => {
      drawn.push(out);
      writeFileSync(out, "png");
    },
  );

  expect([...previews.keys()]).toEqual([STOICS, "Omarchy"]);
  expect(drawn.length).toBe(2);
  expect(previews.get(STOICS)).toBe(join(root, "cache", "Stoics.png"));
});

test("previews are cached, and redrawn only when the art changes", async () => {
  writeFileSync(paths.omarchyLogo, "logo\n");
  const cache = join(root, "cache");
  const render = async (_c: string, out: string) => {
    drawn++;
    writeFileSync(out, "png");
  };
  let drawn = 0;

  const slates = await discover(paths);
  await buildPreviews(slates, cache, "same", render);
  expect(drawn).toBe(2);

  await buildPreviews(slates, cache, "same", render);
  expect(drawn).toBe(2); // nothing changed

  writeFileSync(paths.omarchyLogo, "a different logo\n");
  await buildPreviews(slates, cache, "same", render);
  expect(drawn).toBe(3); // just the one that changed

  await buildPreviews(slates, cache, "a new sample quote", render);
  expect(drawn).toBe(4); // the Stoics tile, because its sample changed
});
