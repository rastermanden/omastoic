import { test, expect } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";
import { createRequire } from "node:module";
import { BEGIN, withBlock, withoutBlock } from "../src/menu.ts";

// The host is the oracle, not another permissive JSONC library. CI checks out
// the audited Omarchy revision; desktop development reads the installed host.
const host = process.env.OMARCHY_TEST_ROOT ?? "/usr/share/omarchy";
const model = createRequire(import.meta.path)(`${host}/shell/plugins/menu/MenuModel.js`);
const defaults = model.parseMenuJsonc(readFileSync(`${host}/default/omarchy/omarchy-menu.jsonc`, "utf8"));

for (const original of [
  "", " \r\n\t", "// only a comment", "// first\r\n  // second\r\n",
  '{\n  "personal": {"label":"Personal"}\n}\n',
  '{\n  "personal": {"label":"Personal"},\n}\n',
  '{\n}\n',
  '{\r\n  // preserve a comment\r\n}\r\n',
  '{"personal":{"label":"A } brace, a \\\"quote\\\" and // string"}}',
  '{\n // >>> neighbour:begin\n "personal":{"label":"Mine"}\n // <<< neighbour:end\n}\n',
  '{"items": {"personal":{"label":"Personal"}}, "title":"Wrapper }"}',
]) {
  test(`host menu round-trip: ${JSON.stringify(original)}`, () => {
    const before = model.keepMenuRows(null, original, false);
    expect(before).not.toBeNull();
    const next = withBlock(original);
    const after = model.keepMenuRows(null, next, false);
    expect(after).not.toBeNull();
    expect(after.length).toBe(before.length + 1);
    for (const row of before) expect(after).toContainEqual(row);
    const merged = model.mergeMenuSources(defaults, after).items;
    for (const id of ["appearance.branding.screensaver.stoics"]) {
      expect(merged[id].parent).toBe("appearance.branding.screensaver");
      expect(merged[merged[id].parent]).toBeDefined();
    }
    expect(withBlock(next)).toBe(next);
    expect(withoutBlock(next)).toBe(original);
    expect(withBlock(next).split(BEGIN)).toHaveLength(2);
  });
}

test("refuse invalid menu documents instead of writing more invalid JSONC", () => {
  for (const bad of ["null", "[]", '{"personal": {', '{"x": {}} garbage']) expect(() => withBlock(bad)).toThrow();
});

for (const original of ["", "// only a comment"]) {
  for (const removal of ["uninstall", "prune"]) {
    test(`empty host menu survives setup and ${removal}: ${JSON.stringify(original)}`, async () => {
      const s = sandbox();
      const menu = join(s.config, "omarchy/extensions/omarchy-menu.jsonc");
      s.put(menu, original);
      try {
        expect(model.keepMenuRows(null, original, false)).toEqual([]);
        expect((await s.cli(["setup", "--quiet"])).code).toBe(0);
        expect(model.keepMenuRows(null, readFileSync(menu, "utf8"), false).map((row: { id: string }) => row.id)).toEqual(["appearance.branding.screensaver.stoics"]);
        if (removal === "prune") rmSync(s.plugin, { recursive: true });
        expect((await (removal === "prune" ? s.prune() : s.cli(["uninstall"]))).code).toBe(0);
        expect(readFileSync(menu, "utf8")).toBe(original);
        expect(model.keepMenuRows(null, readFileSync(menu, "utf8"), false)).toEqual([]);
      } finally { s.cleanup(); }
    });
  }
}

test("updating old misplaced rows removes them and preserves neighbours", () => {
  const old = '{\n "personal":{"label":"Mine"},\n // >>> omastoic:begin — old version\n "style.screensaver.stoics":{"label":"Old"},\n "style.screensaver.configure":{"label":"Configure"},\n // <<< omastoic:end\n}\n';
  const result = model.parseMenuJsonc(withBlock(old));
  expect(result.map((r: { id: string }) => r.id).sort()).toEqual(["appearance.branding.screensaver.stoics", "personal"]);
});
