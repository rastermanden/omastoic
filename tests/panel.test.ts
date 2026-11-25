import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { root, sandbox } from "./sandbox.ts";
import { headerPortraitLayout, PORTRAIT_COLS, PORTRAIT_ROWS, previewPortraitLayout } from "../src/portrait.ts";

type Sandbox = ReturnType<typeof sandbox>;

const settingsPath = (s: Sandbox) => join(s.config, "omastoic/config.json");
const quotesPath = (s: Sandbox) => join(s.config, "omastoic/quotes.tsv");
const saved = (s: Sandbox) => JSON.parse(readFileSync(settingsPath(s), "utf8"));
const stateOf = (result: { stdout: string }) => JSON.parse(result.stdout);

test("panel state reads the roster and defaults without writing anything", async () => {
  const s = sandbox();
  try {
    const result = await s.cli(["panel", "state"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const state = stateOf(result);
    expect(state.authors.map((author: { slug: string }) => author.slug)).toEqual([
      "marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus",
    ]);
    expect(state.authors[0].name).toBe("Marcus Aurelius");
    expect(state.authors[0].selected).toBe(true);
    expect(state.allAuthors).toBe(true);
    expect(state.settings).toEqual({});
    expect(state.summary).toContain("every 60s");
    expect(state.customQuotes).toBe(0);
    // A read-only bridge: no config, no state directory, no unit.
    expect(existsSync(settingsPath(s))).toBe(false);
    expect(existsSync(s.state)).toBe(false);
  } finally { s.cleanup(); }
});

test("panel apply writes exactly what config --authors/--interval writes", async () => {
  const viaPanel = sandbox();
  const viaFlags = sandbox();
  try {
    const applied = await viaPanel.cli(["panel", "apply", JSON.stringify({ interval: 90, authors: ["marcus", "seneca"] })]);
    expect(applied.code).toBe(0);
    expect(applied.stderr).toBe("");
    const state = stateOf(applied);
    expect(state.settings).toEqual({ interval: 90, authors: ["marcus", "seneca"] });
    expect(state.allAuthors).toBe(false);
    expect(state.authors.filter((author: { selected: boolean }) => author.selected).map((author: { slug: string }) => author.slug))
      .toEqual(["marcus", "seneca"]);
    expect(state.summary).toContain("every 90s");

    expect((await viaFlags.cli(["config", "--authors", "marcus,seneca", "--interval", "90"])).code).toBe(0);
    expect(readFileSync(settingsPath(viaPanel), "utf8")).toBe(readFileSync(settingsPath(viaFlags), "utf8"));
  } finally { viaPanel.cleanup(); viaFlags.cleanup(); }
});

test("panel apply with every Stoic keeps the default and drops the key", async () => {
  const s = sandbox();
  try {
    const all = ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus"];
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 60, authors: all })])).code).toBe(0);
    expect(saved(s)).toEqual({ interval: 60 });
    expect(stateOf(await s.cli(["panel", "state"])).allAuthors).toBe(true);
  } finally { s.cleanup(); }
});

test("panel apply rejects a bad interval or an unknown Stoic and keeps the file", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 30 })])).code).toBe(0);
    const before = readFileSync(settingsPath(s), "utf8");
    for (const payload of [{ interval: 0 }, { interval: 3601 }, { interval: 1.5 }, { interval: "sixty" }]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify(payload)]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("whole number of seconds from 1 to 3600");
    }
    for (const payload of [{ authors: ["plato"] }, { authors: "marcus" }, { authors: [1] }]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify(payload)]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("omastoic:");
    }
    for (const raw of ["not json", "[]", "null"]) {
      expect((await s.cli(["panel", "apply", raw])).stdout).not.toContain("{");
      expect((await s.cli(["panel", "apply", raw])).code).toBe(1);
    }
    expect(readFileSync(settingsPath(s), "utf8")).toBe(before);
  } finally { s.cleanup(); }
});

test("panel apply adds a custom quote and keeps it in rotation", async () => {
  const s = sandbox();
  try {
    const result = await s.cli(["panel", "apply", JSON.stringify({
      interval: 45,
      authors: ["marcus"],
      addQuote: { author: "marcus", citation: "Meditations IX.1", text: "The panel wrote this line." },
    })]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const state = stateOf(result);
    expect(state.customQuotes).toBe(1);
    expect(readFileSync(quotesPath(s), "utf8")).toContain("marcus\tMeditations IX.1\tThe panel wrote this line.");
    expect(saved(s)).toEqual({ interval: 45, authors: ["marcus"] });
    // The line is in rotation: `config --list` stars it, and show renders it.
    const listed = await s.cli(["config", "--list"]);
    expect(listed.stdout).toContain("c01");
    expect(listed.stdout).toContain("The panel wrote this line.");

    // An explicit custom selection gains the new id instead of dropping it.
    s.put(settingsPath(s), JSON.stringify({ authors: ["marcus"], quotes: { marcus: ["q01", "c01"] } }));
    expect((await s.cli(["panel", "apply", JSON.stringify({
      addQuote: { author: "marcus", citation: "Meditations IX.2", text: "A second line." },
    })])).code).toBe(0);
    expect(saved(s).quotes.marcus).toEqual(["q01", "c01", "c02"]);
  } finally { s.cleanup(); }
});

test("panel apply refuses an incomplete or duplicate quote and leaves the file alone", async () => {
  const s = sandbox();
  try {
    for (const addQuote of [{ author: "marcus", citation: "Meditations IX.1" }, { author: "marcus", citation: "", text: "x" }, "marcus"]) {
      const rejected = await s.cli(["panel", "apply", JSON.stringify({ addQuote })]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("omastoic:");
    }
    expect(existsSync(quotesPath(s))).toBe(false);

    const line = { author: "marcus", citation: "Meditations IX.1", text: "Only once." };
    expect((await s.cli(["panel", "apply", JSON.stringify({ addQuote: line })])).code).toBe(0);
    const duplicate = await s.cli(["panel", "apply", JSON.stringify({ addQuote: line })]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already in");
  } finally { s.cleanup(); }
});

test("panel apply reads the same JSON from stdin", async () => {
  const s = sandbox();
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "panel", "apply"], {
      cwd: join(import.meta.dir, ".."),
      env: s.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ interval: 15, authors: ["zeno"] }));
    child.stdin.end();
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).settings).toEqual({ interval: 15, authors: ["zeno"] });
    expect(saved(s)).toEqual({ interval: 15, authors: ["zeno"] });
  } finally { s.cleanup(); }
});

test("panel state includes a cited sample, the backend, and no writes", async () => {
  const s = sandbox();
  try {
    const state = stateOf(await s.cli(["panel", "state"]));
    expect(state.samples).toHaveLength(6);
    expect(state.samples[0].slug).toBe("marcus");
    expect(state.samples[0].citation).toBe("Meditations VII.22");
    expect(state.samples[0].text).toBe("It is peculiar to man to love even those who do wrong.");
    expect(state.samples[0].text).not.toContain("…");
    expect(state.samples[0].portrait).toMatch(/\S/);
    const grid = (art: string) => {
      const lines = art.split("\n");
      return { rows: lines.length, cols: Math.max(...lines.map((line) => [...line].length)) };
    };
    const layout = headerPortraitLayout();
    const marcus = state.samples.find((sample: { slug: string }) => sample.slug === "marcus");
    const seneca = state.samples.find((sample: { slug: string }) => sample.slug === "seneca");
    expect(layout.fontPx).toBe(8);
    expect(layout.cellWidth).toBeGreaterThanOrEqual(5);
    expect(layout.dotPitch).toBeCloseTo(layout.cellWidth / 2);
    expect(layout.dotPitch).toBeCloseTo(layout.cellHeight / 4);
    expect(layout.dotPitch).toBeGreaterThanOrEqual(2);
    expect(layout.width).toBeGreaterThanOrEqual(80);
    expect(layout.width).toBeLessThanOrEqual(96);
    expect(layout.height).toBeGreaterThanOrEqual(80);
    expect(layout.height).toBeLessThanOrEqual(96);
    expect(state.portraitFont).toBe(layout.fontPx);
    expect(state.portraitLine).toBe(layout.cellHeight);
    expect(state.portraitWidth).toBe(layout.width);
    expect(state.portraitHeight).toBe(layout.height);
    expect(grid(marcus.portrait)).toEqual({ rows: layout.rows, cols: layout.cols });
    expect(grid(seneca.portrait)).toEqual({ rows: layout.rows, cols: layout.cols });
    expect(marcus.portrait).not.toBe(seneca.portrait);
    expect(["native", "terminal", "missing"]).toContain(state.backend);
    expect(typeof state.intervalApplied).toBe("boolean");
    expect(state.custom).toEqual([]);
  } finally { s.cleanup(); }
});

test("preview --quote writes that same line", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "art before the Stoics\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    const sample = stateOf(await s.cli(["panel", "state"])).samples[0];
    const shown = await s.cli(["preview", "--quote", sample.id]);
    expect(shown.code).toBe(0);
    expect(readFileSync(branding, "utf8")).toContain(sample.citation);
    expect(readFileSync(branding, "utf8")).toContain("love even those who do");
    const missing = await s.cli(["preview", "--quote", "q99"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not in the book");
  } finally { s.cleanup(); }
});

test("panel apply leaves the daemon alone when nothing changed", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "my art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["on"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120, authors: ["marcus"] })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120, authors: ["marcus"] })])).code).toBe(0);
    expect(s.log()).not.toContain("restart");
    expect(saved(s)).toEqual({ interval: 120, authors: ["marcus"] });
  } finally { s.cleanup(); }
});

test("panel apply removes one custom quote and refuses a bundled id", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["panel", "apply", JSON.stringify({
      addQuote: { author: "marcus", citation: "Meditations IX.1", text: "First added line." },
    })])).code).toBe(0);
    expect((await s.cli(["panel", "apply", JSON.stringify({
      addQuote: { author: "seneca", citation: "Letters 1.1", text: "Second added line." },
    })])).code).toBe(0);
    const bundled = await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "q01" })]);
    expect(bundled.code).toBe(1);
    expect(bundled.stderr).toContain("Only a quote you added");
    expect(readFileSync(quotesPath(s), "utf8")).toContain("Second added line.");

    const removed = await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "c01" })]);
    expect(removed.code).toBe(0);
    const state = stateOf(removed);
    expect(state.custom.map((quote: { text: string }) => quote.text)).toEqual(["Second added line."]);
    expect(state.custom[0].id).toBe("c01");
    expect(readFileSync(quotesPath(s), "utf8")).not.toContain("First added line.");
    const unknown = await s.cli(["panel", "apply", JSON.stringify({ removeQuote: "c09" })]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("not one of yours");
  } finally { s.cleanup(); }
});

test("panel apply restarts an enabled rotation service", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "my art\n");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["on"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "apply", JSON.stringify({ interval: 120 })])).code).toBe(0);
    expect(s.log()).toContain("restart omastoic.service");
    s.put(join(s.home, "systemctl.log"), "");
    // `panel state` is a read: it must never restart anything.
    expect((await s.cli(["panel", "state"])).code).toBe(0);
    expect(s.log()).not.toContain("restart");
  } finally { s.cleanup(); }
});

test("omastoic ui toggles the panel through the running shell", async () => {
  const s = sandbox();
  s.stub("omarchy-shell", 'echo "$*" >> "$HOME/shell.log"');
  try {
    expect((await s.cli(["ui"])).code).toBe(0);
    expect(readFileSync(join(s.home, "shell.log"), "utf8").trim()).toBe("shell toggle io.github.rastermanden.omastoic");
    s.stub("omarchy-shell", "exit 1");
    const failed = await s.cli(["ui"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("is omarchy-shell running?");

    rmSync(join(s.bin, "omarchy-shell"));
    const missing = await s.cli(["ui"], { PATH: s.bin });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("is omarchy-shell running?");
    expect(missing.stderr).not.toContain("Executable not found");
  } finally { s.cleanup(); }
});

test("panel size persists under XDG_STATE_HOME without touching config.json or the daemon", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  const sizePath = join(s.state, "panel-size.json");
  s.put(branding, "my art\n");
  try {
    // Initially absent: panel state reports null and does not create STATE.
    const initial = stateOf(await s.cli(["panel", "state"]));
    expect(initial.panelSize).toBeNull();
    expect(existsSync(s.state)).toBe(false);

    // Save a custom size; config.json stays absent and panel state reads it back.
    const savedSize = await s.cli(["panel", "size", JSON.stringify({ width: 740, height: 610 })]);
    expect(savedSize.code).toBe(0);
    expect(JSON.parse(savedSize.stdout)).toEqual({ width: 740, height: 610 });
    expect(existsSync(sizePath)).toBe(true);
    expect(existsSync(settingsPath(s))).toBe(false);
    expect(stateOf(await s.cli(["panel", "state"])).panelSize).toEqual({ width: 740, height: 610 });

    // Running `omastoic config` is unaffected and never writes panel size into config.json.
    expect((await s.cli(["config", "--authors", "marcus", "--interval", "45"])).code).toBe(0);
    expect(saved(s)).toEqual({ interval: 45, authors: ["marcus"] });

    // Resizing never restarts an active daemon.
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    expect((await s.cli(["on"])).code).toBe(0);
    s.put(join(s.home, "systemctl.log"), "");
    expect((await s.cli(["panel", "size", JSON.stringify({ width: 820 })])).code).toBe(0);
    expect(s.log()).not.toContain("restart");
    expect(stateOf(await s.cli(["panel", "state"])).panelSize).toEqual({ width: 820 });
    expect(saved(s)).toEqual({ interval: 45, authors: ["marcus"] });

    // Invalid payloads fail cleanly and preserve the previous size file.
    for (const invalid of [{ width: 50 }, { reset: false }, { width: null }, { reset: true, width: null }]) {
      const bad = await s.cli(["panel", "size", JSON.stringify(invalid)]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("omastoic:");
      expect(stateOf(await s.cli(["panel", "state"])).panelSize).toEqual({ width: 820 });
    }

    // Corrupt state on disk falls back to null on panel state.
    s.put(sizePath, "{broken");
    expect(stateOf(await s.cli(["panel", "state"])).panelSize).toBeNull();

    // Reset removes the state file cleanly.
    expect((await s.cli(["panel", "size", JSON.stringify({ reset: true })])).code).toBe(0);
    expect(existsSync(sizePath)).toBe(false);
    expect(stateOf(await s.cli(["panel", "state"])).panelSize).toBeNull();

    // Uninstall sweeps panel-size.json along with runtime state.
    expect((await s.cli(["panel", "size", JSON.stringify({ width: 700, height: 550 })])).code).toBe(0);
    expect(existsSync(sizePath)).toBe(true);
    expect((await s.cli(["uninstall"])).code).toBe(0);
    expect(existsSync(sizePath)).toBe(false);
  } finally { s.cleanup(); }
});

function makeTestGrayscalePng(width: number, height: number, pixel: (x: number, y: number) => number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixel(x, y);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("panel state exposes fullPortrait and panel preview-portrait renders read-only previews and errors cleanly", async () => {
  const s = sandbox();
  const photoPng = join(s.home, "photo.png");
  const drawingPng = join(s.home, "drawing.png");
  const blankPng = join(s.home, "blank.png");
  const corruptJpg = join(s.home, "corrupt.jpg");
  const validText = join(s.home, "fake.png");

  writeFileSync(
    photoPng,
    makeTestGrayscalePng(120, 140, (x, y) => {
      const dx = x - 60;
      const dy = y - 52;
      if ((x - 49) ** 2 + (y - 46) ** 2 <= 14 || (x - 71) ** 2 + (y - 46) ** 2 <= 14) return 28;
      if (Math.abs(dx) <= 9 && Math.abs(y - 68) <= 2) return 40;
      if ((dx * dx) / (28 * 28) + (dy * dy) / (36 * 36) <= 1) {
        return Math.max(95, Math.min(225, Math.round(215 - Math.hypot(dx, dy) * 1.9)));
      }
      if (y >= 92 && Math.abs(dx) <= 44) return 96;
      return 24;
    }),
  );
  writeFileSync(
    drawingPng,
    makeTestGrayscalePng(68, 80, (x, y) => {
      const dx = x - 34;
      const dy = y - 34;
      return dx * dx + dy * dy < 18 * 18 ? 15 : 252;
    }),
  );
  writeFileSync(blankPng, makeTestGrayscalePng(32, 32, () => 255));
  writeFileSync(corruptJpg, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]));
  writeFileSync(validText, "not an image\n");

  try {
    // 1. panel state includes fullPortrait (\u2800-padded, no ASCII spaces) and preview font/line metrics.
    const state = stateOf(await s.cli(["panel", "state"]));
    const previewLayout = previewPortraitLayout();
    expect(state.previewPortraitFont).toBe(previewLayout.fontPx);
    expect(state.previewPortraitLine).toBe(previewLayout.cellHeight);
    for (const sample of state.samples) {
      expect(typeof sample.fullPortrait).toBe("string");
      expect(sample.fullPortrait).toMatch(/[\u2801-\u28ff]/);
      expect(sample.fullPortrait).not.toContain(" ");
      const lines = sample.fullPortrait.split("\n");
      expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
      expect(Math.max(...lines.map((l: string) => [...l].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    }

    // 2. panel preview-portrait via argument renders photo and drawing cleanly without writing config/state/systemctl.
    for (const image of [photoPng, drawingPng]) {
      const res = await s.cli(["panel", "preview-portrait", JSON.stringify({ image })]);
      expect(res.code).toBe(0);
      expect(res.stderr).toBe("");
      const parsed = JSON.parse(res.stdout);
      expect(parsed.cols).toBe(PORTRAIT_COLS);
      expect(parsed.rows).toBe(PORTRAIT_ROWS);
      expect(parsed.fontPx).toBe(previewLayout.fontPx);
      expect(parsed.lineHeight).toBe(previewLayout.cellHeight);
      expect(parsed.portrait).toMatch(/[\u2801-\u28ff]/);
      expect(parsed.portrait).not.toContain(" ");
      const lines = parsed.portrait.split("\n");
      expect(lines.length).toBeLessThanOrEqual(PORTRAIT_ROWS);
      expect(Math.max(...lines.map((l: string) => [...l].length))).toBeLessThanOrEqual(PORTRAIT_COLS);
    }

    // 3. panel preview-portrait reads JSON from stdin and stays read-only.
    const child = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "panel", "preview-portrait"], {
      cwd: root,
      env: s.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ image: photoPng }));
    child.stdin.end();
    const [stdinOut, stdinErr, stdinCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdinCode).toBe(0);
    expect(stdinErr).toBe("");
    expect(JSON.parse(stdinOut).portrait).toMatch(/[\u2801-\u28ff]/);

    // 4. Error paths keep exact converter error texts and write nothing.
    for (const [image, expected] of [
      [join(s.home, "missing.jpg"), "image file not found"],
      [validText, "JPEG or PNG"],
      [corruptJpg, "not a readable JPEG or PNG image"],
      [blankPng, "image produced an empty portrait"],
    ] as const) {
      const bad = await s.cli(["panel", "preview-portrait", JSON.stringify({ image })]);
      expect(bad.code).toBe(1);
      expect(bad.stdout).toBe("");
      expect(bad.stderr.toLowerCase()).toContain(expected.toLowerCase());
      expect(bad.stderr).not.toContain("omastoic-portrait-");
    }

    // Dimension-limit converter failure preserves its clean error message.
    const fakeBin = join(s.home, "fake-limit-bin");
    mkdirSync(fakeBin, { recursive: true });
    for (const [name, target] of [["sh", Bun.which("sh")], ["bash", Bun.which("bash")]] as const) {
      if (target) {
        s.put(join(fakeBin, name), `#!/bin/sh\nexec "${target}" "$@"\n`);
        chmodSync(join(fakeBin, name), 0o755);
      }
    }
    s.put(
      join(fakeBin, "magick"),
      '#!/bin/sh\necho "magick: width or height exceeds limit \\`/tmp/omastoic-portrait-x/source.png\' @ error/png.c/ReadPNGImage/1." >&2\nexit 1\n',
    );
    chmodSync(join(fakeBin, "magick"), 0o755);
    const limitErr = await s.cli(["panel", "preview-portrait", JSON.stringify({ image: photoPng })], { PATH: fakeBin });
    expect(limitErr.code).toBe(1);
    expect(limitErr.stderr).toContain("dimensions exceed the image converter limit");
    expect(limitErr.stderr).not.toContain("omastoic-portrait-");

    // Nothing was created or written anywhere in config or state.
    expect(existsSync(settingsPath(s))).toBe(false);
    expect(existsSync(quotesPath(s))).toBe(false);
    expect(existsSync(join(s.config, "omastoic"))).toBe(false);
    expect(existsSync(s.state)).toBe(false);
  } finally { s.cleanup(); }
});
