import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";
import { pty, SHOWS } from "./pty.ts";

test("a key typed after the author picker reaches the quote picker", async () => {
  const s = sandbox();
  try {
    // Only Marcus, one quote toggled off: the second screen must see the keys.
    const run = await pty(s, ["config"], [
      { marker: SHOWS.authors, keys: "n1\r" },
      { marker: SHOWS.quotes, keys: " \r" },
      { marker: SHOWS.interval, keys: "\x1560\r" },
      { marker: SHOWS.confirm, keys: "n" },
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Stoics on the screensaver");
    expect(run.stdout).toContain("Quotes from Marcus Aurelius");
    const saved = JSON.parse(readFileSync(join(s.config, "omastoic/config.json"), "utf8"));
    expect(saved.authors).toEqual(["marcus"]);
    expect(saved.interval).toBe(60);
    expect(saved.quotes.marcus).not.toContain("q01");
    expect(saved.quotes.marcus).toHaveLength(24);
  } finally { s.cleanup(); }
}, 20000);
