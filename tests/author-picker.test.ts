import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { pickAuthors, pickAuthorsPlain, pickAuthorsTui, rawTtyUsable } from "../src/author-picker.ts";

const rows = [
  { slug: "marcus", name: "Marcus Aurelius" },
  { slug: "seneca", name: "Seneca" },
  { slug: "epictetus", name: "Epictetus" },
  { slug: "zeno", name: "Zeno of Citium" },
  { slug: "cleanthes", name: "Cleanthes" },
  { slug: "chrysippus", name: "Chrysippus" },
];
const all = rows.map((row) => row.slug);
const without = (...slugs: string[]) => all.filter((slug) => !slugs.includes(slug));

/** A fake terminal: queued keystrokes, recorded raw-mode calls, recorded writes. */
function harness(opts: { isTTY?: boolean; raw?: boolean; fail?: string; isRaw?: boolean; stdoutTTY?: boolean; columns?: number } = {}) {
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
  return {
    io: { input, output, signals }, modes, text, send, end, resize, events, writes, setColumns,
    reader: { released: () => returned, nextAfterReturn: () => nextAfterReturn },
  };
}

test("space and x toggle the focused row and enter confirms in roster order", async () => {
  const space = harness();
  const picked = pickAuthorsTui(rows, [], space.io);
  space.send(" ");
  space.send("\r");
  expect(await picked).toEqual(without("marcus"));

  const x = harness();
  const dropped = pickAuthorsTui(rows, [], x.io);
  x.send("x");
  x.send("\r");
  expect(await dropped).toEqual(without("marcus"));
});

test("arrows and j/k move the focus, digits toggle by stable roster position", async () => {
  const down = harness();
  const moved = pickAuthorsTui(rows, [], down.io);
  down.send("j");
  down.send(" ");
  down.send("\x1b[B");
  down.send(" ");
  down.send("\x1b[A");
  down.send(" ");
  down.send("\r");
  // j moves to Seneca and unchecks it; down moves to Epictetus and unchecks it;
  // up returns to Seneca and checks it again.
  expect(await moved).toEqual(without("epictetus"));

  const digits = harness();
  const stable = pickAuthorsTui(rows, [], digits.io);
  digits.send("n");
  digits.send("6");
  digits.send("3");
  digits.send("\r");
  expect(await stable).toEqual(["epictetus", "chrysippus"]);
});

test("a selects all, n clears all, and an empty selection stays the whole roster", async () => {
  const none = harness();
  const cleared = pickAuthorsTui(rows, ["seneca"], none.io);
  none.send("n");
  none.send("\r");
  expect(await cleared).toEqual([]);

  const every = harness();
  const restored = pickAuthorsTui(rows, [], every.io);
  every.send("n");
  every.send("1");
  every.send("a");
  every.send("\r");
  expect(await restored).toEqual(all);
});

test("q, escape, ctrl-c, ctrl-d and eof all cancel without a selection", async () => {
  for (const keys of ["q", "\x1b", "\x03", "\x04"]) {
    const h = harness();
    const picked = pickAuthorsTui(rows, ["marcus"], h.io);
    h.send(keys);
    expect(await picked).toBeUndefined();
    expect(h.modes).toEqual([true, false]);
  }
  const closed = harness();
  const picked = pickAuthorsTui(rows, ["marcus"], closed.io);
  closed.end();
  expect(await picked).toBeUndefined();
  expect(closed.modes).toEqual([true, false]);
});

test("the picker shows checked rows, numbering and key hints, then cleans up", async () => {
  const h = harness();
  const picked = pickAuthorsTui(rows, ["marcus", "zeno"], h.io);
  h.send("\r");
  expect(await picked).toEqual(["marcus", "zeno"]);
  const frame = h.text();
  expect(frame).toContain("[x] Marcus Aurelius");
  expect(frame).toContain("[ ] Seneca");
  expect(frame).toContain("[x] Zeno of Citium");
  expect(frame).toContain("1 [x]");
  expect(frame).toContain("6 [ ]");
  expect(frame).toContain("space/x toggle");
  expect(frame).toContain("a all");
  expect(frame).toContain("n none");
  expect(frame).toContain("enter save");
  expect(frame).toContain("q cancel");
  expect(frame.startsWith("\x1b[?25l")).toBe(true);
  expect(frame).not.toContain("\x1b[?1049h");
  expect(frame.endsWith("\x1b[?25h")).toBe(true);
  expect(frame).toContain("\x1b[J");
});

test("a resize redraws the frame and leaves no listeners behind", async () => {
  const h = harness();
  const picked = pickAuthorsTui(rows, [], h.io);
  h.resize();
  h.send("\r");
  expect(await picked).toEqual(all);
  expect(h.text().split("Stoics on the screensaver").length - 1).toBeGreaterThanOrEqual(2);
  expect(h.events.listenerCount("resize")).toBe(0);
  expect(h.modes).toEqual([true, false]);
});

test("a terminal error still restores the terminal", async () => {
  const h = harness({ fail: "tty broke" });
  await expect(pickAuthorsTui(rows, [], h.io)).rejects.toThrow("tty broke");
  expect(h.modes).toEqual([true, false]);
  expect(h.text().endsWith("\x1b[?25h")).toBe(true);
  expect(h.events.listenerCount("resize")).toBe(0);
});

test("a signal during the picker cleans up and cancels", async () => {
  const h = harness();
  const picked = pickAuthorsTui(rows, ["marcus"], h.io);
  h.io.signals.emit("SIGTERM");
  expect(await picked).toBeUndefined();
  expect(h.modes).toEqual([true, false]);
  expect(h.text().endsWith("\x1b[?25h")).toBe(true);
  expect(h.io.signals.listenerCount("SIGTERM")).toBe(0);
});

test("the plain prompt keeps the current selection on an empty line", async () => {
  const h = harness({ isTTY: false });
  const picked = pickAuthorsPlain(rows, ["seneca", "zeno"], h.io);
  h.send("\n");
  expect(await picked).toEqual(["seneca", "zeno"]);
  const shown = h.text();
  expect(shown).toContain("1 [ ] Marcus Aurelius");
  expect(shown).toContain("2 [x] Seneca");
  expect(shown).toContain("Select Stoics");
  expect(h.modes).toEqual([]);
});

test("the plain prompt accepts all, none and numbered or slug lists", async () => {
  const every = harness({ isTTY: false });
  const allPick = pickAuthorsPlain(rows, ["marcus"], every.io);
  every.send("all\n");
  expect(await allPick).toEqual(all);

  const none = harness({ isTTY: false });
  const nonePick = pickAuthorsPlain(rows, [], none.io);
  none.send("none\n");
  expect(await nonePick).toEqual([]);

  const list = harness({ isTTY: false });
  const listPick = pickAuthorsPlain(rows, [], list.io);
  list.send("4, 1 seneca\n");
  expect(await listPick).toEqual(["marcus", "seneca", "zeno"]);

  const lastLine = harness({ isTTY: false });
  const lastPick = pickAuthorsPlain(rows, [], lastLine.io);
  lastLine.send("2");
  lastLine.end();
  expect(await lastPick).toEqual(["seneca"]);
});

test("the plain prompt rejects unknown answers and stops at end of input", async () => {
  const h = harness({ isTTY: false });
  const picked = pickAuthorsPlain(rows, ["marcus"], h.io);
  h.send("zero\n9\n2\n");
  expect(await picked).toEqual(["seneca"]);
  expect(h.text()).toContain("omastoic: pick 1-6, all, none, or a comma separated list");

  const closed = harness({ isTTY: false });
  const cancelled = pickAuthorsPlain(rows, ["marcus"], closed.io);
  closed.end();
  expect(await cancelled).toBeUndefined();

  const quit = harness({ isTTY: false });
  const quitted = pickAuthorsPlain(rows, ["marcus"], quit.io);
  quit.send("q\n");
  expect(await quitted).toBeUndefined();
});

test("the picker hands stdin back at confirm, cancel and in plain mode", async () => {
  const confirmed = harness();
  const picked = pickAuthorsTui(rows, [], confirmed.io);
  confirmed.send("\r");
  expect(await picked).toEqual(all);
  expect(confirmed.reader.released()).toBe(true);
  expect(confirmed.reader.nextAfterReturn()).toBe(0);

  const cancelled = harness();
  const dropped = pickAuthorsTui(rows, [], cancelled.io);
  cancelled.send("q");
  expect(await dropped).toBeUndefined();
  expect(cancelled.reader.released()).toBe(true);
  expect(cancelled.reader.nextAfterReturn()).toBe(0);

  const plain = harness({ isTTY: false });
  const plainPick = pickAuthorsPlain(rows, [], plain.io);
  plain.send("\n");
  expect(await plainPick).toEqual(all);
  expect(plain.reader.released()).toBe(true);
  expect(plain.reader.nextAfterReturn()).toBe(0);

  // A prompt after the picker can still read: the reader is gone, not the stream.
  plain.send("2\n");
  const next = await pickAuthorsPlain(rows, [], { input: plain.io.input, output: plain.io.output });
  expect(next).toEqual(undefined);
});

test("redirected stdout falls back to the plain prompt", async () => {
  const h = harness({ stdoutTTY: false });
  const picked = pickAuthors(rows, ["marcus"], { plain: false, ...h.io });
  h.send("\n");
  expect(await picked).toEqual(["marcus"]);
  expect(h.modes).toEqual([]);
  expect(h.text()).not.toContain("\x1b[?25l");
  expect(h.text()).toContain("Select Stoics");
});

test("an already raw terminal is left as it was found", async () => {
  const h = harness({ isRaw: true });
  const picked = pickAuthorsTui(rows, [], h.io);
  h.send("\r");
  expect(await picked).toEqual(all);
  expect(h.modes).toEqual([]);
});

test("a narrow terminal truncates every frame line and a resize re-fits them", async () => {
  const h = harness({ columns: 20 });
  const picked = pickAuthorsTui(rows, [], h.io);
  h.setColumns(60);
  h.resize();
  h.send("\r");
  expect(await picked).toEqual(all);
  const frames = h.text().split("\x1b[J");
  // Each frame carries the cursor-up and carriage return of the next redraw.
  const lines = (frame: string) => frame.replace(/\x1b\[\d*A/g, "").replace(/\r/g, "").split("\n");
  const narrow = lines(frames[1]!);
  expect(narrow.length).toBe(8);
  for (const line of narrow) expect(line.length).toBeLessThanOrEqual(19);
  const wide = lines(frames[2]!);
  expect(wide.some((line) => line.length > 19)).toBe(true);
  expect(wide.every((line) => line.length <= 59)).toBe(true);
  expect(wide[0]).toContain("Stoics on the screensaver");
});

test("a raw tty is required for the picker and plain mode is used otherwise", async () => {
  expect(rawTtyUsable(harness().io.input, harness().io.output)).toBe(true);
  expect(rawTtyUsable(harness({ raw: false }).io.input, harness().io.output)).toBe(false);
  expect(rawTtyUsable(harness({ isTTY: false }).io.input, harness().io.output)).toBe(false);

  const plain = harness({ raw: false });
  const asking = pickAuthors(rows, ["marcus"], { plain: false, ...plain.io });
  plain.send("\n");
  expect(await asking).toEqual(["marcus"]);

  const piped = harness({ isTTY: false });
  const pipedPick = pickAuthors(rows, [], { plain: true, ...piped.io });
  piped.send("none\n");
  expect(await pipedPick).toEqual([]);

  const requested = harness();
  const requestedPick = pickAuthors(rows, ["seneca"], { plain: true, ...requested.io });
  requested.send("\n");
  expect(await requestedPick).toEqual(["seneca"]);
  expect(requested.modes).toEqual([]);
});
