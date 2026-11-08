// The Stoic checklist for `omastoic config`: a small raw-mode picker with a
// plain numbered fallback, so a pipe or a dumb terminal still gets to choose.

export type AuthorRow = { slug: string; name: string };

export type PickerInput = AsyncIterable<unknown> & {
  isTTY?: boolean;
  /** Terminals remember this, so a picker never leaves the tty changed. */
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

export type PickerOutput = {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
};

export type PickerSignals = {
  on(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
};

export type PickerIo = { input: PickerInput; output: PickerOutput; signals?: PickerSignals; /** A reader shared by every prompt in one config run, so no byte of a pipe is dropped. */ source?: ChunkSource };
export type PickOptions = PickerIo & { plain: boolean };

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** How long a trailing escape byte waits for the rest of an arrow sequence. */
const ESCAPE_GRACE_MS = 20;
const FALLBACK_COLUMNS = 80;

/** A raw tty is the only way the picker reads single keys without echo, and it
 * can only draw when stdout is that same terminal. */
export function rawTtyUsable(input: PickerInput, output: PickerOutput): boolean {
  return input.isTTY === true && typeof input.setRawMode === "function" && output.isTTY === true;
}

type Chunk = { kind: "chunk"; value: string } | { kind: "eof" } | { kind: "timeout" };

/** Buffers terminal reads so keys can be read one at a time, with a grace timer.
 * The quote picker and the line prompts reuse it so every widget reads the one
 * terminal the same way and hands it back the same way. */
export class ChunkSource {
  private queue: string[] = [];
  private ended = false;
  private closed = false;
  private failure: unknown = null;
  private wake: (() => void) | null = null;
  private readonly iterator: AsyncIterator<unknown> | null = null;
  private detach: (() => void) | null = null;

  constructor(input: AsyncIterable<unknown>) {
    // process.stdin is shared with the prompts that follow, so it is read
    // through add/removeListener rather than an async iterator: an iterator's
    // return() would destroy the stream. The listener is removed on close and
    // the fd is left open.
    if (typeof input.on === "function" && (typeof input.off === "function" || typeof input.removeListener === "function")) {
      this.attach(input);
      return;
    }
    this.iterator = typeof input[Symbol.asyncIterator] === "function" ? input[Symbol.asyncIterator]() : null;
    void this.pump();
  }

  private attach(input: PickerInput): void {
    const onData = (chunk: unknown) => {
      if (this.closed) return;
      this.queue.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      this.notify();
    };
    const onEnd = () => { this.ended = true; this.notify(); };
    const onError = (error: unknown) => {
      if (!this.closed) this.failure = error;
      this.ended = true;
      this.notify();
    };
    input.on?.("data", onData);
    input.on?.("end", onEnd);
    input.on?.("error", onError);
    try { input.resume?.(); } catch { /* already flowing */ }
    const drop = (event: string, listener: (...args: unknown[]) => void) => {
      if (typeof input.off === "function") input.off(event, listener);
      else input.removeListener?.(event, listener);
    };
    this.detach = () => {
      drop("data", onData);
      drop("end", onEnd);
      drop("error", onError);
      try { input.pause?.(); } catch { /* the tty is already gone */ }
    };
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** A signal handler, or any other owner, can feed a key without a stream. */
  inject(chunk: string): void {
    if (this.closed) return;
    this.queue.push(chunk);
    this.notify();
  }

  /** Give bytes back, so the next prompt in the same run reads what this one did not use. */
  unshift(chunk: string): void {
    if (!chunk || this.closed) return;
    this.queue.unshift(chunk);
    this.notify();
  }

  /**
   * Hand the terminal back. The pending read is released but the stream itself
   * is left open, so the prompts that follow this picker read every key.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    this.queue.length = 0;
    this.wake = null;
    this.detach?.();
    this.detach = null;
    try { void this.iterator?.return?.(); } catch { /* the tty is already gone */ }
  }

  private async pump(): Promise<void> {
    const iterator = this.iterator;
    if (!iterator) { this.ended = true; return; }
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        if (this.closed) return;
        this.queue.push(typeof step.value === "string" ? step.value : Buffer.from(step.value as Uint8Array).toString("utf8"));
        this.notify();
        if (this.closed) return;
      }
    } catch (error) {
      if (!this.closed) this.failure = error;
    }
    this.ended = true;
    this.notify();
  }

  async next(timeoutMs?: number): Promise<Chunk> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued != null) return { kind: "chunk", value: queued };
      if (this.failure != null) throw this.failure;
      if (this.ended) return { kind: "eof" };
      const waiting = new Promise<void>((resolve) => { this.wake = resolve; });
      if (timeoutMs == null) {
        await waiting;
        continue;
      }
      const timed = new Promise<"timeout">((resolve) => { setTimeout(() => resolve("timeout"), timeoutMs); });
      if (await Promise.race([waiting.then(() => "wake" as const), timed]) === "timeout") return { kind: "timeout" };
    }
  }
}
type Key =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "toggle" }
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "digit"; index: number }
  | { kind: "ignore" };

/**
 * One key from the head of the buffer. A trailing escape byte may still be the
 * start of an arrow sequence, so it asks for more input instead of guessing.
 */
function decode(buffer: string): { key: Key; rest: string } | "more" {
  const [first] = buffer;
  if (first === "\x1b") {
    if (buffer.length === 1) return "more";
    const second = buffer[1];
    if (second === "[" || second === "O") {
      if (buffer.length < 3) return "more";
      const third = buffer[2];
      if (third === "A") return { key: { kind: "up" }, rest: buffer.slice(3) };
      if (third === "B") return { key: { kind: "down" }, rest: buffer.slice(3) };
      const sequence = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(buffer);
      if (!sequence) return "more";
      return { key: { kind: "ignore" }, rest: buffer.slice(sequence[0].length) };
    }
    return { key: { kind: "cancel" }, rest: buffer.slice(1) };
  }
  const rest = buffer.slice(1);
  if (first === "\r" || first === "\n") return { key: { kind: "confirm" }, rest };
  if (first === "\x03" || first === "\x04") return { key: { kind: "cancel" }, rest };
  if (first === " " || first === "x" || first === "X") return { key: { kind: "toggle" }, rest };
  if (first === "j" || first === "J") return { key: { kind: "down" }, rest };
  if (first === "k" || first === "K") return { key: { kind: "up" }, rest };
  if (first === "a" || first === "A") return { key: { kind: "all" }, rest };
  if (first === "n" || first === "N") return { key: { kind: "none" }, rest };
  if (first === "q" || first === "Q") return { key: { kind: "cancel" }, rest };
  if (first >= "1" && first <= "9") return { key: { kind: "digit", index: Number(first) - 1 }, rest };
  return { key: { kind: "ignore" }, rest };
}

const HINTS = "space/x toggle · 1-6 · j/k move · a all · n none · enter save · q cancel";
const HEADER = "Stoics on the screensaver";

/** One line per row keeps the frame's line count fixed, so a redraw can clear it. */
function frameLines(rows: AuthorRow[], checked: Set<string>, focus: number, columns: number): string[] {
  const width = Number.isInteger(columns) && columns > 4 ? columns - 1 : FALLBACK_COLUMNS - 1;
  const fit = (line: string) => (line.length > width ? line.slice(0, width) : line);
  const lines = [HEADER];
  rows.forEach((row, index) => {
    lines.push(`${index === focus ? ">" : " "} ${index + 1} [${checked.has(row.slug) ? "x" : " "}] ${row.name}`);
  });
  lines.push(HINTS);
  return lines.map(fit);
}

/**
 * The author checklist. Every exit path — confirm, cancel, EOF, a broken tty or
 * a signal — goes through the same cleanup: clear our own lines, show the
 * cursor, restore cooked mode.
 */
export async function pickAuthorsTui(rows: AuthorRow[], selected: string[], io: PickerIo): Promise<string[] | undefined> {
  const { input, output, signals } = io;
  const known = new Set(rows.map((row) => row.slug));
  const checked = new Set(selected.filter((slug) => known.has(slug)));
  // No saved author list means all six, which is what the old chooser showed.
  if (!checked.size) for (const row of rows) checked.add(row.slug);

  const source = io.source ?? new ChunkSource(input);
  const ownsSource = io.source == null;
  const wasRaw = input.isRaw === true;
  let focus = 0;
  let drawn = 0;
  let buffer = "";

  const clearFrame = (): string => {
    const up = drawn > 0 ? `\x1b[${drawn - 1}A` : "";
    drawn = 0;
    return `${up}\r\x1b[J`;
  };
  const draw = (): void => {
    const lines = frameLines(rows, checked, focus, output.columns ?? 0);
    const up = drawn > 0 ? `\x1b[${drawn - 1}A` : "";
    drawn = lines.length;
    output.write(`${up}\r\x1b[J${lines.join("\n")}`);
  };
  const onResize = () => { draw(); };
  const onSignal = () => { source.inject("\x03"); };

  try {
    // A terminal that is already raw belongs to whatever set it that way.
    if (!wasRaw) input.setRawMode?.(true);
    output.write(HIDE_CURSOR);
    draw();
    output.on?.("resize", onResize);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) signals?.on(signal, onSignal);

    for (;;) {
      if (!buffer) {
        const chunk = await source.next();
        if (chunk.kind === "eof") return undefined;
        if (chunk.kind !== "chunk") continue;
        buffer = chunk.value;
        continue;
      }
      const decoded = decode(buffer);
      if (decoded === "more") {
        const chunk = await source.next(ESCAPE_GRACE_MS);
        if (chunk.kind === "chunk") { buffer += chunk.value; continue; }
        if (chunk.kind === "eof") return undefined;
        return undefined; // a lone escape is the cancel key
      }
      buffer = decoded.rest;
      const key = decoded.key;
      if (key.kind === "cancel") return undefined;
      if (key.kind === "confirm") return rows.filter((row) => checked.has(row.slug)).map((row) => row.slug);
      if (key.kind === "up") focus = (focus + rows.length - 1) % rows.length;
      else if (key.kind === "down") focus = (focus + 1) % rows.length;
      else if (key.kind === "all") for (const row of rows) checked.add(row.slug);
      else if (key.kind === "none") checked.clear();
      else if (key.kind === "toggle") {
        const slug = rows[focus]?.slug;
        if (slug) { if (checked.has(slug)) checked.delete(slug); else checked.add(slug); }
      } else if (key.kind === "digit") {
        // Digits map to the roster, not to the focus, so the same key is always the same Stoic.
        const slug = rows[key.index]?.slug;
        if (slug) { if (checked.has(slug)) checked.delete(slug); else checked.add(slug); }
      }
      if (rows.length) draw();
    }
  } finally {
    if (ownsSource) source.close();
    else source.unshift(buffer);
    try { output.write(`${clearFrame()}${SHOW_CURSOR}`); } catch { /* the tty is already gone */ }
    if (!wasRaw) {
      try { input.setRawMode?.(false); } catch { /* the tty is already gone */ }
    }
    output.off?.("resize", onResize);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) signals?.off?.(signal, onSignal);
  }
}
const PLAIN_PROMPT = "Select Stoics [1-6, all, none, or a list; empty keeps the current set]: ";

/**
 * The numbered prompt. It is used when raw mode is unavailable or when the
 * caller asks for `--plain`, and it never blocks past the end of its input, so
 * a pipeline cannot hang.
 */
export async function pickAuthorsPlain(rows: AuthorRow[], selected: string[], io: PickerIo): Promise<string[] | undefined> {
  const { input, output } = io;
  const known = new Set(rows.map((row) => row.slug));
  const checked = new Set(selected.filter((slug) => known.has(slug)));
  if (!checked.size) for (const row of rows) checked.add(row.slug);
  const ordered = () => rows.filter((row) => checked.has(row.slug)).map((row) => row.slug);

  const source = io.source ?? new ChunkSource(input);
  const ownsSource = io.source == null;
  let pending = "";
  const readLine = async (): Promise<string | null> => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line;
      }
      const chunk = await source.next();
      if (chunk.kind === "chunk") { pending += chunk.value; continue; }
      // End of input: a last line without a newline still counts, then we stop.
      if (pending) { const line = pending; pending = ""; return line; }
      return null;
    }
  };

  output.write(`${HEADER}\n`);
  for (const [index, row] of rows.entries()) {
    output.write(`  ${index + 1} ${checked.has(row.slug) ? "[x]" : "[ ]"} ${row.name}\n`);
  }

  try {
    for (;;) {
      output.write(PLAIN_PROMPT);
      const line = await readLine();
      if (line == null) { output.write("\n"); return undefined; }
      const text = line.replace(/\r$/, "").trim().toLowerCase();
      const pick: string[] = [];
      let retry = false;
      if (!text || text === "keep" || text === "current") pick.push(...ordered());
      else if (text === "all" || text === "a" || text === "*") pick.push(...rows.map((row) => row.slug));
      else if (text === "none" || text === "n") pick.length = 0;
      else if (text === "q" || text === "quit" || text === "cancel") return undefined;
      else {
        for (const token of text.split(/[,\s]+/).filter(Boolean)) {
          const position = Number(token);
          const row = Number.isInteger(position) && position >= 1 && position <= rows.length
            ? rows[position - 1]
            : rows.find((candidate) => candidate.slug === token);
          if (!row) { retry = true; break; }
          if (!pick.includes(row.slug)) pick.push(row.slug);
        }
      }
      if (retry) {
        output.write(`omastoic: pick 1-${rows.length}, all, none, or a comma separated list\n`);
        continue;
      }
      output.write(`${pick.length ? pick.join(", ") : "none (the whole roster stays in rotation)"}\n`);
      // Roster order, whatever order the numbers and slugs were typed in.
      return rows.filter((row) => pick.includes(row.slug)).map((row) => row.slug);
    }
  } finally {
    // The prompts that follow read the same terminal.
    if (ownsSource) source.close();
    else source.unshift(pending);
  }
}
/** `--plain`, or a tty that cannot go raw, gets the numbered prompt. */
export async function pickAuthors(rows: AuthorRow[], selected: string[], options: PickOptions): Promise<string[] | undefined> {
  if (options.plain || !rawTtyUsable(options.input, options.output)) return pickAuthorsPlain(rows, selected, options);
  return pickAuthorsTui(rows, selected, options);
}
