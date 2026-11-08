import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { pickQuotes, pickQuotesPlain, pickQuotesTui, quoteChoiceLabel } from "../src/quote-picker.ts";

const rows = [
  { id: "q01", citation: "Meditations II.5", text: "Say only what your nature tells you." },
  { id: "q02", citation: "Meditations IV.17", text: "Every act of thy life as thy last." },
  { id: "q03", citation: "Letters 78.16", text: "Meditations are the mind's medicine." },
];
const ids = rows.map((row) => row.id);
const without = (...dropped: string[]) => ids.filter((id) => !dropped.includes(id));
const many = Array.from({ length: 12 }, (_, index) => ({
  id: `q${String(index + 1).padStart(2, "0")}`,
  citation: `Book ${index + 1}`,
  text: `Line number ${index + 1}.`,
}));

/** A fake terminal: queued keys, recorded raw-mode calls, recorded writes. */
function harness(opts: { isTTY?: boolean; raw?: boolean; fail?: string; isRaw?: boolean; stdoutTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = [];
  let ended = false;
  let returned = false;
  let nextAfterReturn = 0;
  let waiter: ((result: { done: boolean; value?: unknown }) => void) | null = null;
  const modes: boolean[] = [];
  const writes: string[] = [];
  const events = new EventEmitter();

  const offer = () => {
    if (!waiter) return;
    const wake = waiter;
    if (chunks.length) { waiter = null; wake({ done: false, value: chunks.shift() }); }
    else if (ended || returned) { waiter = null; wake({ done: true, value: undefined }); }
  };
  const failure = opts.fail ? new Error(opts.fail) : null;
  const iterator = {
    next: () => {
      if (returned) { nextAfterReturn += 1; return Promise.resolve({ done: true, value: undefined }); }
      if (failure && chunks.length === 0) return Promise.reject(failure);
      if (chunks.length) return Promise.resolve({ done: false, value: chunks.shift() });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise<{ done: boolean; value?: unknown }>((resolve) => { waiter = resolve; });
    },
    return: async () => { returned = true; offer(); return { done: true, value: undefined }; },
  };

  const input: any = {
    isTTY: opts.isTTY ?? true,
    isRaw: opts.isRaw,
    setRawMode: opts.raw === false ? undefined : (on: boolean) => { modes.push(on); },
    [Symbol.asyncIterator]: () => iterator,
  };
  const output: any = {
    isTTY: opts.stdoutTTY ?? true,
    columns: opts.columns ?? 80,
    rows: opts.rows ?? 24,
    write: (chunk: string) => { writes.push(chunk); return true; },
    on: (event: string, cb: (...args: unknown[]) => void) => { events.on(event, cb); return output; },
    off: (event: string, cb: (...args: unknown[]) => void) => { events.off(event, cb); return output; },
  };
  const signals = new EventEmitter();
  const text = () => writes.join("");
  const send = (chunk: string) => { chunks.push(chunk); offer(); };
  const end = () => { ended = true; offer(); };
  const resize = () => events.emit("resize");
  const setColumns = (columns: number) => { output.columns = columns; };
  const setRows = (rows: number) => { output.rows = rows; };
  return {
    io: { input, output, signals }, modes, text, send, end, resize, events, writes, setColumns, setRows,
    reader: { released: () => returned, nextAfterReturn: () => nextAfterReturn },
  };
}

test("the label keeps the id, citation and words, and clips a long line", () => {
  expect(quoteChoiceLabel(rows[0]!)).toBe("q01  Meditations II.5  Say only what your nature tells you.");
  const long = { id: "c01", citation: "Desk, note", text: "x".repeat(80) };
  const label = quoteChoiceLabel(long);
  expect(label.startsWith("c01  Desk, note  ")).toBe(true);
  expect(label.endsWith("…")).toBe(true);
  expect(label.length).toBeLessThan(80);
});

test("space and x toggle the focused row and enter saves in book order", async () => {
  const space = harness();
  const dropped = pickQuotesTui("Marcus Aurelius", rows, null, space.io);
  space.send(" ");
  space.send("\r");
  expect(await dropped).toEqual(without("q01"));

  const x = harness();
  const kept = pickQuotesTui("Marcus Aurelius", rows, ["q01"], x.io);
  x.send("j");
  x.send("x");
  x.send("\r");
  expect(await kept).toEqual(["q01", "q02"]);
});

test("digits toggle the row number on screen and arrows or j/k move the focus", async () => {
  const digits = harness();
  const stable = pickQuotesTui("Marcus Aurelius", rows, [], digits.io);
  digits.send("3");
  digits.send("1");
  digits.send("\r");
  expect(await stable).toEqual(["q01", "q03"]);

  const moved = harness();
  const focus = pickQuotesTui("Marcus Aurelius", rows, [], moved.io);
  moved.send("n");
  moved.send("j");
  moved.send(" ");
  moved.send("\x1b[B");
  moved.send(" ");
  moved.send("\x1b[A");
  moved.send(" ");
  moved.send("\r");
  expect(await focus).toEqual(["q03"]);
});

test("a checks every row and n clears every row", async () => {
  const every = harness();
  const all = pickQuotesTui("Marcus Aurelius", rows, [], every.io);
  every.send("a");
  every.send("\r");
  expect(await all).toEqual(ids);

  const none = harness();
  const empty = pickQuotesTui("Marcus Aurelius", rows, null, none.io);
  none.send("n");
  none.send("\r");
  expect(await empty).toEqual([]);
});

test("the filter line narrows the list, numbers what is shown and applies on enter", async () => {
  const h = harness();
  const picked = pickQuotesTui("Marcus Aurelius", rows, [], h.io);
  h.send("/78.16\r");
  h.send("1");
  h.send("\r");
  expect(await picked).toEqual(["q03"]);
  const frame = h.text();
  expect(frame).toContain("filter: 78.16 (1 of 3)");
  // The frame history holds the unfiltered first draw; the last frame is what is on screen.
  const lastFrame = frame.split("\x1b[J").at(-1)!;
  expect(lastFrame).not.toContain("Meditations II.5");
});

test("a short terminal fits the header, status, rows and hints inside its height", async () => {
  for (const height of [1, 2, 3, 4, 5, 6, 7]) {
    const h = harness({ rows: height });
    const picked = pickQuotesTui("Marcus Aurelius", many, [], h.io);
    h.send("\r");
    expect(await picked).toEqual([]);
    const frames = h.text().split("\x1b[J").slice(1, -1);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const lines = frame.replace(/\x1b\[\d*A/g, "").replace(/\r/g, "").split("\n");
      // Every line printed must sit on a real row of this terminal.
      expect(lines.length).toBeLessThanOrEqual(height);
    }
  }
});

test("a short terminal pages by the rows that actually fit", async () => {
  const h = harness({ rows: 5 });
  const picked = pickQuotesTui("Marcus Aurelius", many, [], h.io);
  h.send("\x1b[6~");
  h.send("1");
  h.send("\r");
  // Five rows leave two quote rows, so page two starts at q03.
  expect(await picked).toEqual(["q03"]);
  expect(h.text()).toContain("page 2/6");
});

test("a resize to a shorter terminal repaints inside the new height", async () => {
  const h = harness({ rows: 24 });
  const picked = pickQuotesTui("Marcus Aurelius", many, null, h.io);
  h.setRows(6);
  h.resize();
  h.send("\r");
  expect(await picked).toEqual(many.map((row) => row.id));
  const frames = h.text().split("\x1b[J");
  // frames[1] is the first draw, frames[2] the redraw after the shrink.
  const moved = /\x1b\[(\d+)A\r$/.exec(frames[1]!);
  expect(moved).not.toBeNull();
  expect(Number(moved![1])).toBeLessThanOrEqual(5);
  const lines = frames[2]!.replace(/\x1b\[\d*A/g, "").replace(/\r/g, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(6);
});

test("paging shows the next page and digits map to that page", async () => {
  const h = harness({ columns: 80 });
  const picked = pickQuotesTui("Marcus Aurelius", many, [], h.io);
  h.send("\x1b[6~");
  h.send("1");
  h.send("4");
  h.send("\r");
  // A 24-row terminal fits eight quotes per page, so page two starts at q09.
  expect(await picked).toEqual(["q09", "q12"]);
  const frame = h.text();
  expect(frame).toContain("page 2/2");
  expect(frame).toContain("8 [ ] q08");
  expect(frame).toContain("1 [ ] q09");
});

test("q, escape, ctrl-c, ctrl-d and end of input cancel and restore the terminal", async () => {
  for (const keys of ["q", "\x1b", "\x03", "\x04"]) {
    const h = harness();
    const picked = pickQuotesTui("Marcus Aurelius", rows, ["q01"], h.io);
    h.send(keys);
    expect(await picked).toBeUndefined();
    expect(h.modes).toEqual([true, false]);
    expect(h.text().endsWith("\x1b[?25h")).toBe(true);
  }
  const closed = harness();
  const picked = pickQuotesTui("Marcus Aurelius", rows, ["q01"], closed.io);
  closed.end();
  expect(await picked).toBeUndefined();
  expect(closed.modes).toEqual([true, false]);
});

test("the frame shows checked rows, numbers, filter and hints, and never uses the alternate screen", async () => {
  const h = harness();
  const picked = pickQuotesTui("Marcus Aurelius", rows, ["q02"], h.io);
  h.send("\r");
  expect(await picked).toEqual(["q02"]);
  const frame = h.text();
  expect(frame).toContain("Quotes from Marcus Aurelius");
  expect(frame).toContain("1 [ ] q01");
  expect(frame).toContain("2 [x] q02");
  expect(frame).toContain("3 [ ] q03");
  expect(frame).toContain("space/x toggle");
  expect(frame).toContain("1-9");
  expect(frame).toContain("/ filter");
  expect(frame).toContain("a all");
  expect(frame).toContain("n none");
  expect(frame).toContain("enter save");
  expect(frame).toContain("q cancel");
  expect(frame.startsWith("\x1b[?25l")).toBe(true);
  expect(frame).not.toContain("\x1b[?1049h");
  expect(frame).toContain("\x1b[J");
});

test("a resize redraws, clips to the width and leaves no listeners behind", async () => {
  const h = harness({ columns: 20 });
  const picked = pickQuotesTui("Marcus Aurelius", rows, null, h.io);
  h.setColumns(60);
  h.resize();
  h.send("\r");
  expect(await picked).toEqual(ids);
  const frames = h.text().split("\x1b[J");
  const lines = (frame: string) => frame.replace(/\x1b\[\d*A/g, "").replace(/\r/g, "").split("\n");
  for (const line of lines(frames[1]!)) expect(line.length).toBeLessThanOrEqual(19);
  expect(lines(frames[2]!).some((line) => line.length > 19)).toBe(true);
  expect(h.events.listenerCount("resize")).toBe(0);
  expect(h.modes).toEqual([true, false]);
});

test("a signal and a broken terminal both clean up", async () => {
  const h = harness();
  const picked = pickQuotesTui("Marcus Aurelius", rows, ["q01"], h.io);
  h.io.signals.emit("SIGTERM");
  expect(await picked).toBeUndefined();
  expect(h.modes).toEqual([true, false]);
  expect(h.io.signals.listenerCount("SIGTERM")).toBe(0);

  const broken = harness({ fail: "tty broke" });
  await expect(pickQuotesTui("Marcus Aurelius", rows, null, broken.io)).rejects.toThrow("tty broke");
  expect(broken.modes).toEqual([true, false]);
  expect(broken.text().endsWith("\x1b[?25h")).toBe(true);
});

test("an already raw terminal is left as it was found, and so is a raw-less one", async () => {
  const raw = harness({ isRaw: true });
  const picked = pickQuotesTui("Marcus Aurelius", rows, null, raw.io);
  raw.send("\r");
  expect(await picked).toEqual(ids);
  expect(raw.modes).toEqual([]);

  const noRaw = harness({ raw: false });
  const fallback = pickQuotes("Marcus Aurelius", rows, ["q01"], { plain: false, ...noRaw.io });
  noRaw.send("\n");
  expect(await fallback).toEqual(["q01"]);
  expect(noRaw.modes).toEqual([]);
});

test("the plain prompt numbers every quote and accepts numbers and ids", async () => {
  const h = harness({ isTTY: false });
  const picked = pickQuotesPlain("Marcus Aurelius", rows, null, h.io);
  h.send("2, q03\n");
  expect(await picked).toEqual(["q02", "q03"]);
  const shown = h.text();
  expect(shown).toContain("Quotes from Marcus Aurelius");
  expect(shown).toContain("  3 [x] q03  Letters 78.16");
  expect(shown).toContain("Select quotes");
  expect(h.modes).toEqual([]);
  expect(h.reader.released()).toBe(true);
});

test("the plain prompt keeps the set on an empty line, ignores nonsense and stops at end of input", async () => {
  const keep = harness({ isTTY: false });
  const kept = pickQuotesPlain("Marcus Aurelius", rows, ["q02"], keep.io);
  keep.send("keep\n");
  expect(await kept).toEqual(["q02"]);

  const all = harness({ isTTY: false });
  const every = pickQuotesPlain("Marcus Aurelius", rows, null, all.io);
  all.send("all\n");
  expect(await every).toEqual(ids);

  const none = harness({ isTTY: false });
  const empty = pickQuotesPlain("Marcus Aurelius", rows, null, none.io);
  none.send("none\n");
  expect(await empty).toEqual([]);

  const retry = harness({ isTTY: false });
  const retried = pickQuotesPlain("Marcus Aurelius", rows, ["q01"], retry.io);
  retry.send("zero\n9\n3\n");
  expect(await retried).toEqual(["q03"]);
  expect(retry.text()).toContain("omastoic: pick 1-3, ids, all, or none");

  const last = harness({ isTTY: false });
  const lastLine = pickQuotesPlain("Marcus Aurelius", rows, [], last.io);
  last.send("1");
  last.end();
  expect(await lastLine).toEqual(["q01"]);

  const closed = harness({ isTTY: false });
  const cancelled = pickQuotesPlain("Marcus Aurelius", rows, null, closed.io);
  closed.end();
  expect(await cancelled).toBeUndefined();

  const quit = harness({ isTTY: false });
  const quitted = pickQuotesPlain("Marcus Aurelius", rows, null, quit.io);
  quit.send("q\n");
  expect(await quitted).toBeUndefined();
});

test("redirected stdout and --plain both fall back to the numbered prompt", async () => {
  const piped = harness({ stdoutTTY: false });
  const fromPipe = pickQuotes("Marcus Aurelius", rows, ["q01"], { plain: false, ...piped.io });
  piped.send("\n");
  expect(await fromPipe).toEqual(["q01"]);
  expect(piped.modes).toEqual([]);
  expect(piped.text()).not.toContain("\x1b[?25l");

  const requested = harness();
  const plain = pickQuotes("Marcus Aurelius", many, null, { plain: true, ...requested.io });
  requested.send("\n");
  expect(await plain).toEqual(many.map((row) => row.id));
  expect(requested.modes).toEqual([]);
});

test("a Stoic with no quotes still draws a row and saves an empty set", async () => {
  const h = harness();
  const picked = pickQuotesTui("Seneca", [], null, h.io);
  h.send("\r");
  expect(await picked).toEqual([]);
  expect(h.text()).toContain("(no quotes)");
});
