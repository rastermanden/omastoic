import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";

test("config selects bundled quotes, lists them, and still adds custom lines", async () => {
  const s = sandbox();
  try {
    const listed = await s.cli(["config", "--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("* q01  marcus  Meditations II.5");
    expect(listed.stdout).toContain("custom:\n  (none)");

    const limited = await s.cli(["config", "--authors", "marcus", "--quotes", "marcus=q01"]);
    expect(limited.code).toBe(0);
    expect(limited.stdout).toContain("1 of 18 quotes");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved).toEqual({ authors: ["marcus"], quotes: { marcus: ["q01"] } });

    const shown = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("Meditations II.5");
    expect(shown.stdout).toContain("every act of thy life");
    expect(shown.stdout).not.toContain("ten thousand years");

    const added = await s.cli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(added.code).toBe(0);
    expect(readFileSync(join(s.config, "omastoic/quotes.tsv"), "utf8")).toContain("marcus\tDesk note\tA custom sentence for the saver.\n");
    const again = await s.cli(["config", "--add", "marcus\tDesk note\tA custom sentence for the saver."]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already in");

    const canvases = [shown.stdout];
    for (let i = 0; i < 24; i++) canvases.push((await s.cli(["show", "--cols", "92", "--rows", "25"])).stdout);
    expect(canvases.every((canvas) => canvas.length > 0)).toBe(true);
    expect(canvases.some((canvas) => canvas.includes("A custom sentence for the saver."))).toBe(true);
    expect(canvases.some((canvas) => canvas.includes("Meditations II.5"))).toBe(true);

    const status = await s.cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("2 quotes:");
    expect(status.stdout).toContain("Marcus Aurelius");
    expect(status.stdout).not.toContain("Seneca");

    const one = await s.cli(["config", "--authors", "epictetus", "--quotes", "epictetus=q49"]);
    expect(one.code).toBe(0);
    const epictetus = await s.cli(["show", "--cols", "92", "--rows", "25"]);
    expect(epictetus.stdout).toContain("I must die");
    expect(epictetus.stdout).not.toContain("fetter my leg");

    const rejected = await s.cli(["config", "--quotes", "marcus=q99"]);
    expect(rejected.code).toBe(1);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8")).quotes.epictetus).toEqual(["q49"]);

    const cleared = await s.cli(["config", "--quotes", "all", "--authors", "all"]);
    expect(cleared.code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"))).toEqual({});
    const book = await s.cli(["status"]);
    expect(book.stdout).toContain("65 quotes:");
  } finally { s.cleanup(); }
});

test("a bad quote field is ignored and an empty bundled list can fall back", async () => {
  const s = sandbox();
  try {
    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({ interval: 12, quotes: { marcus: ["nope"] } }));
    const kept = await s.cli(["status"]);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain("64 quotes:");
    expect(kept.stdout).toContain("every 12s");
    expect(kept.stderr).not.toContain("ignoring unreadable");

    s.put(join(s.config, "omastoic/config.json"), JSON.stringify({
      quotes: { marcus: [], seneca: [], epictetus: [], zeno: [], cleanthes: [], chrysippus: [] },
    }));
    const fellBack = await s.cli(["status"]);
    expect(fellBack.code).toBe(0);
    expect(fellBack.stderr).toContain("config quotes matched no quotes");
    expect(fellBack.stdout).toContain("64 quotes:");
    expect(fellBack.stdout).toContain("0 of 64 quotes");
    const unmarked = await s.cli(["config", "--list"]);
    expect(unmarked.stdout).toContain("  q01  marcus  Meditations II.5");
    expect(unmarked.stdout).not.toContain("* q01");
  } finally { s.cleanup(); }
});
