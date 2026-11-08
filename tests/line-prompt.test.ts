import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { askConfirm, askLine, askText } from "../src/line-prompt.ts";

/** A fake terminal: queued keys, recorded raw-mode calls, recorded writes. */
function harness(opts: { isTTY?: boolean; raw?: boolean; isRaw?: boolean; stdoutTTY?: boolean; columns?: number; rows?: number } = {}) {
  const chunks: string[] = [];
  let ended = false;
  let returned = false;
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
  const iterator = {
    next: () => {
      if (returned) return Promise.resolve({ done: true, value: undefined });
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
  return {
    io: { input, output, signals }, modes, text, send, end, events, writes,
    reader: { released: () => returned },
  };
}

test("the line prompt accepts the prefilled value on enter and hands the terminal back", async () => {
  const h = harness();
  const asking = askLine({ header: "Citation", value: "Meditations IX.1" }, h.io);
  h.send("\r");
  expect(await asking).toBe("Meditations IX.1");
  expect(h.modes).toEqual([true, false]);
  expect(h.reader.released()).toBe(true);
  expect(h.text()).toContain("Citation: ");
  expect(h.text()).toContain("Meditations IX.1");
});

test("typing replaces nothing, backspace and ctrl-u edit, and the character limit holds", async () => {
  const typed = harness();
  const asking = askLine({ header: "Author slug", value: "marcus" }, typed.io);
  typed.send("\x7f\x7f\r");
  expect(await asking).toBe("marc");

  const cleared = harness();
  const wiping = askLine({ header: "Citation", value: "Desk note" }, cleared.io);
  cleared.send("\x15z\r");
  expect(await wiping).toBe("z");

  const added = harness();
  const appending = askLine({ header: "Author slug", value: "marcus" }, added.io);
  added.send("\x15seneca\r");
  expect(await appending).toBe("seneca");

  const limited = harness();
  const capped = askLine({ header: "Author slug", charLimit: 4 }, limited.io);
  limited.send("marcus\r");
  expect(await capped).toBe("marc");
});

test("ctrl-c, ctrl-d, escape and end of input cancel the line prompt and restore the terminal", async () => {
  for (const keys of ["\x03", "\x04", "\x1b"]) {
    const h = harness();
    const asking = askLine({ header: "Citation" }, h.io);
    h.send(keys);
    expect(await asking).toBeUndefined();
    expect(h.modes).toEqual([true, false]);
    expect(h.reader.released()).toBe(true);
  }
  const closed = harness();
  const asking = askLine({ header: "Citation" }, closed.io);
  closed.end();
  expect(await asking).toBeUndefined();
  expect(closed.modes).toEqual([true, false]);
});

test("a piped line prompt asks once, reads a line and stops at end of input", async () => {
  const h = harness({ isTTY: false });
  const asking = askLine({ header: "Author slug", value: "marcus" }, h.io);
  h.send("seneca\n");
  expect(await asking).toBe("seneca");
  expect(h.modes).toEqual([]);
  expect(h.reader.released()).toBe(true);
  expect(h.text()).toBe("Author slug: ");

  const closed = harness({ isTTY: false });
  const cancelled = askLine({ header: "Author slug" }, closed.io);
  closed.end();
  expect(await cancelled).toBeUndefined();
});

test("the text prompt collects lines and submits on ctrl-d", async () => {
  const h = harness();
  const asking = askText({ header: "Quote text", value: "Your line." }, h.io);
  h.send("\rA custom sentence\rfor the saver.\x04");
  expect(await asking).toBe("Your line.\nA custom sentence\nfor the saver.");
  expect(h.modes).toEqual([true, false]);
  expect(h.reader.released()).toBe(true);
});

test("the text prompt backs over a line break, cancels on ctrl-c, and is capped", async () => {
  const h = harness();
  const asking = askText({ header: "Quote text" }, h.io);
  h.send("one\rtwo\x7f\x7f\x7f\x04");
  expect(await asking).toBe("one");

  const cancelled = harness();
  const dropped = askText({ header: "Quote text" }, cancelled.io);
  cancelled.send("half a line\x03");
  expect(await dropped).toBeUndefined();
  expect(cancelled.modes).toEqual([true, false]);

  const limited = harness();
  const capped = askText({ header: "Quote text", charLimit: 5 }, limited.io);
  limited.send("abcdefg\x04");
  expect(await capped).toBe("abcde");

  const cleared = harness();
  const wiped = askText({ header: "Quote text", value: "Your line." }, cleared.io);
  cleared.send("\x15A fresh line.\x04");
  expect(await wiped).toBe("A fresh line.");
});

test("a piped text prompt reads to end of input", async () => {
  const h = harness({ isTTY: false });
  const asking = askText({ header: "Quote text", value: "Your line." }, h.io);
  h.send("A custom sentence\nfor the saver.\n");
  h.end();
  expect(await asking).toBe("A custom sentence\nfor the saver.");
  expect(h.text()).toBe("Quote text: ");
});

test("the confirm prompt takes y or n and aborts on escape or end of input", async () => {
  const yes = harness();
  const confirmed = askConfirm("Add a custom quote?", yes.io);
  yes.send("y");
  expect(await confirmed).toBe(true);
  expect(yes.text()).toContain("Add a custom quote? [y/N]");

  const no = harness();
  const refused = askConfirm("Add a custom quote?", no.io);
  no.send("n");
  expect(await refused).toBe(false);

  const empty = harness();
  const defaulted = askConfirm("Add a custom quote?", empty.io);
  empty.send("\r");
  expect(await defaulted).toBe(false);

  for (const keys of ["\x1b", "\x03"]) {
    const h = harness();
    const aborted = askConfirm("Add a custom quote?", h.io);
    h.send(keys);
    expect(await aborted).toBeUndefined();
    expect(h.modes).toEqual([true, false]);
  }
  const closed = harness();
  const aborted = askConfirm("Add a custom quote?", closed.io);
  closed.end();
  expect(await aborted).toBeUndefined();
});

test("a piped confirm prompt reads one word and an empty line is no", async () => {
  const yes = harness({ isTTY: false });
  const confirmed = askConfirm("Add a custom quote?", yes.io);
  yes.send("yes\n");
  expect(await confirmed).toBe(true);

  const no = harness({ isTTY: false });
  const refused = askConfirm("Add a custom quote?", no.io);
  no.send("\n");
  expect(await refused).toBe(false);

  const closed = harness({ isTTY: false });
  const aborted = askConfirm("Add a custom quote?", closed.io);
  closed.end();
  expect(await aborted).toBeUndefined();
});

test("left, right, home and end move the cursor, and typing inserts where it stands", async () => {
  const middle = harness();
  const asking = askLine({ header: "Citation", value: "Marcus" }, middle.io);
  middle.send("\x1b[D\x1b[DX\r");
  expect(await asking).toBe("MarcXus");

  const start = harness();
  const atStart = askLine({ header: "Citation", value: "marcus" }, start.io);
  start.send("\x1b[HX\x1b[FY\r");
  expect(await atStart).toBe("XmarcusY");

  const right = harness();
  const moved = askLine({ header: "Citation", value: "marcus" }, right.io);
  right.send("\x1b[H\x1b[C\x1b[CZ\r");
  expect(await moved).toBe("maZrcus");
});

test("backspace and delete remove the character beside the cursor", async () => {
  const h = harness();
  const asking = askLine({ header: "Citation", value: "marcus" }, h.io);
  h.send("\x1b[H\x1b[3~\x1b[F\x7f\r");
  // Home deletes the m, end backs over the s.
  expect(await asking).toBe("arcu");

  const empty = harness();
  const nothing = askLine({ header: "Citation" }, empty.io);
  empty.send("\x1b[D\x1b[3~\x7f\r");
  expect(await nothing).toBe("");
});

test("a fragmented arrow moves the cursor before the next character is typed", async () => {
  const h = harness();
  const asking = askLine({ header: "Citation", value: "marcus" }, h.io);
  h.send("\x1b");
  h.send("[D");
  h.send("X\r");
  expect(await asking).toBe("marcuXs");
});

test("the whole line is redrawn around the cursor, so no stale text remains", async () => {
  const h = harness();
  const asking = askLine({ header: "Citation", value: "marcus" }, h.io);
  h.send("\x1b[H");
  h.send("\r");
  expect(await asking).toBe("marcus");
  // Home leaves the caret before the text, and the redraw moves it there.
  expect(h.text()).toContain("\x1b[6D");
  const drawn = h.text().split("\x1b[J").filter((frame) => frame.includes("Citation: ")).at(-1)!;
  expect(drawn).toContain("Citation: marcus");
});

test("a signal cancels every prompt and restores the terminal", async () => {
  const line = harness();
  const asking = askLine({ header: "Author slug", value: "marcus" }, line.io);
  line.io.signals.emit("SIGTERM");
  expect(await asking).toBeUndefined();
  expect(line.modes).toEqual([true, false]);
  expect(line.io.signals.listenerCount("SIGTERM")).toBe(0);

  const text = harness();
  const writing = askText({ header: "Quote text" }, text.io);
  text.io.signals.emit("SIGINT");
  expect(await writing).toBeUndefined();
  expect(text.modes).toEqual([true, false]);

  const confirm = harness();
  const confirming = askConfirm("Add a custom quote?", confirm.io);
  confirm.io.signals.emit("SIGHUP");
  expect(await confirming).toBeUndefined();
  expect(confirm.modes).toEqual([true, false]);
});

test("a fatal signal restores every prompt before the process is handed the signal", async () => {
  const line = harness();
  let raised: string | null = null;
  let rawAtRaise: boolean | undefined;
  let cursorAtRaise: boolean | undefined;
  const asking = askLine({ header: "Author slug", value: "marcus" }, {
    ...line.io,
    fatal: (signal: string) => {
      raised = signal;
      rawAtRaise = line.modes.at(-1);
      cursorAtRaise = line.text().endsWith("\x1b[?25h");
    },
  });
  line.io.signals.emit("SIGTERM");
  expect(await asking).toBeUndefined();
  expect(raised as string | null).toBe("SIGTERM");
  expect(rawAtRaise).toBe(false);
  expect(cursorAtRaise).toBe(true);

  const text = harness();
  let textRaised: string | null = null;
  const writing = askText({ header: "Quote text" }, { ...text.io, fatal: (signal) => { textRaised = signal; } });
  text.io.signals.emit("SIGHUP");
  expect(await writing).toBeUndefined();
  expect(textRaised as string | null).toBe("SIGHUP");
  expect(text.modes).toEqual([true, false]);

  const confirm = harness();
  let confirmRaised: string | null = null;
  const confirming = askConfirm("Add a custom quote?", { ...confirm.io, fatal: (signal) => { confirmRaised = signal; } });
  confirm.io.signals.emit("SIGTERM");
  expect(await confirming).toBeUndefined();
  expect(confirmRaised as string | null).toBe("SIGTERM");
  expect(confirm.modes).toEqual([true, false]);
});

test("SIGINT still cancels a prompt like ctrl-c without raising a signal", async () => {
  const h = harness();
  let raised: string | null = null;
  const asking = askLine({ header: "Author slug" }, { ...h.io, fatal: (signal) => { raised = signal; } });
  h.io.signals.emit("SIGINT");
  expect(await asking).toBeUndefined();
  expect(raised).toBeNull();
  expect(h.modes).toEqual([true, false]);
});

test("a fatal signal leaves an already raw terminal raw", async () => {
  const h = harness({ isRaw: true });
  let raised: string | null = null;
  const asking = askLine({ header: "Citation", value: "Desk note" }, { ...h.io, fatal: (signal) => { raised = signal; } });
  h.io.signals.emit("SIGTERM");
  expect(await asking).toBeUndefined();
  expect(raised).toBe("SIGTERM");
  expect(h.modes).toEqual([]);
  expect(h.text().endsWith("\x1b[?25h")).toBe(true);
});

test("an already raw terminal is left as it was found", async () => {
  const h = harness({ isRaw: true });
  const asking = askLine({ header: "Citation", value: "Desk note" }, h.io);
  h.send("\r");
  expect(await asking).toBe("Desk note");
  expect(h.modes).toEqual([]);
});
