// The quote checklist for `omastoic config`: the same raw-mode widget the Stoic
// picker uses, plus a filter line and paging for a Stoic's whole book. The quote
// id is the key, so a choice survives a re-filter, a redraw and a config write.

import { ChunkSource, rawTtyUsable, type PickOptions, type PickerIo } from "./author-picker.ts";

export type QuoteRow = { id: string; citation: string; text: string };

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** How long a trailing escape byte waits for the rest of an arrow sequence. */
const ESCAPE_GRACE_MS = 20;
const FALLBACK_COLUMNS = 80;
const FALLBACK_PAGE = 8;
/** Digits reach nine rows, so a page never shows more than nine. */
const MAX_PAGE = 8;
/** A filter is a search, not a second quote. */
const MAX_FILTER = 64;

/** The id is the stable key; the citation and the first words identify the line. */
export function quoteChoiceLabel(row: QuoteRow): string {
  const text = row.text.length > 60 ? `${row.text.slice(0, 59)}…` : row.text;
  return `${row.id}  ${row.citation}  ${text}`;
}

type Key =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "turn"; delta: number }
  | { kind: "toggle" }
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "digit"; index: number }
  | { kind: "filter" }
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
      if (third === "C") return { key: { kind: "turn", delta: 1 }, rest: buffer.slice(3) };
      if (third === "D") return { key: { kind: "turn", delta: -1 }, rest: buffer.slice(3) };
      const sequence = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(buffer);
      if (!sequence) return "more";
      const rest = buffer.slice(sequence[0].length);
      if (sequence[0] === "\x1b[6~") return { key: { kind: "turn", delta: 1 }, rest };
      if (sequence[0] === "\x1b[5~") return { key: { kind: "turn", delta: -1 }, rest };
      return { key: { kind: "ignore" }, rest };
    }
    return { key: { kind: "cancel" }, rest: buffer.slice(1) };
  }
  const rest = buffer.slice(1);
  if (first === "\r" || first === "\n") return { key: { kind: "confirm" }, rest };
  if (first === "\x03" || first === "\x04") return { key: { kind: "cancel" }, rest };
  if (first === " ") return { key: { kind: "toggle" }, rest };
  if (first === "x" || first === "X") return { key: { kind: "toggle" }, rest };
  if (first === "j" || first === "J") return { key: { kind: "down" }, rest };
  if (first === "k" || first === "K") return { key: { kind: "up" }, rest };
  if (first === "a" || first === "A") return { key: { kind: "all" }, rest };
  if (first === "n" || first === "N") return { key: { kind: "none" }, rest };
  if (first === "q" || first === "Q") return { key: { kind: "cancel" }, rest };
  if (first === "/") return { key: { kind: "filter" }, rest };
  if (first >= "1" && first <= "9") return { key: { kind: "digit", index: Number(first) - 1 }, rest };
  return { key: { kind: "ignore" }, rest };
}

const HINTS = "space/x toggle · 1-9 · j/k · / filter · a all · n none · enter save · q cancel";

type FilterKey =
  | { kind: "text"; value: string }
  | { kind: "backspace" }
  | { kind: "enter" }
  | { kind: "cancel" }
  | { kind: "escape" }
  | { kind: "navigate" };

/**
 * One key from the head of the buffer while the filter line has focus. Arrows,
 * page keys and other escape sequences do nothing here, but they must arrive
 * whole even when a read split them, so a fragment never becomes filter text or
 * a shortcut. Printable bytes are text; everything else is navigation.
 */
function decodeFilter(buffer: string): { key: FilterKey; rest: string } | "more" {
  const [first] = buffer;
  if (first === "\x1b") {
    if (buffer.length === 1) return "more";
    const sequence = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(buffer);
    if (sequence) return { key: { kind: "navigate" }, rest: buffer.slice(sequence[0].length) };
    // An escape at the head of a partial sequence is still waiting for its tail.
    if (buffer[1] === "[" || buffer[1] === "O") return "more";
    return { key: { kind: "escape" }, rest: buffer.slice(1) };
  }
  const rest = buffer.slice(1);
  if (first === "\r" || first === "\n") return { key: { kind: "enter" }, rest };
  if (first === "\x7f" || first === "\x08") return { key: { kind: "backspace" }, rest };
  if (first === "\x03" || first === "\x04") return { key: { kind: "cancel" }, rest };
  if (first >= " ") return { key: { kind: "text", value: first }, rest };
  return { key: { kind: "navigate" }, rest };
}

function headerFor(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Quotes from ${trimmed}` : "Quotes";
}

/**
 * The quote checklist. Every exit path — confirm, cancel, EOF, a broken tty or a
 * signal — goes through the same cleanup: clear our own lines, show the cursor,
 * restore cooked mode, and hand stdin back to the prompts that follow.
 */
export async function pickQuotesTui(
  name: string,
  rows: QuoteRow[],
  selected: string[] | null,
  io: PickerIo,
): Promise<string[] | undefined> {
  const { input, output, signals } = io;
  const known = new Set(rows.map((row) => row.id));
  // No saved list means every quote, which is what the chooser showed before.
  const checked = new Set(selected == null ? rows.map((row) => row.id) : selected.filter((id) => known.has(id)));

  const source = io.source ?? new ChunkSource(input);
  const ownsSource = io.source == null;
  const wasRaw = input.isRaw === true;
  const header = headerFor(name);
  let filter = "";
  let typing = false;
  let focus = 0;
  let page = 0;
  let drawn = 0;
  let buffer = "";

  /** The screen height, or null when the terminal does not report one. */
  const terminalHeight = (): number | null => {
    const height = output.rows;
    return Number.isInteger(height) && (height ?? 0) > 0 ? (height as number) : null;
  };
  // Header, status and hints always share the screen with the quote rows, so a
  // page is only as tall as what the terminal actually has left.
  const pageSize = (): number => {
    const height = terminalHeight();
    if (height == null) return FALLBACK_PAGE;
    return Math.min(MAX_PAGE, Math.max(1, height - 3));
  };
  /** Moving up more rows than the screen has would paint over its top edge. */
  const upTo = (lines: number): string => {
    const moves = lines > 0 ? lines - 1 : 0;
    const height = terminalHeight();
    const allowed = height == null ? moves : Math.min(moves, height - 1);
    return allowed > 0 ? `\x1b[${allowed}A` : "";
  };
  const visible = (): QuoteRow[] => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => `${row.id} ${row.citation} ${row.text}`.toLowerCase().includes(needle));
  };
  const pageCount = (): number => Math.max(1, Math.ceil(visible().length / pageSize()));
  const followFocus = (): void => {
    page = Math.min(Math.floor(focus / pageSize()), pageCount() - 1);
  };

  const frameLines = (): string[] => {
    const width = Number.isInteger(output.columns) && (output.columns ?? 0) > 4 ? (output.columns as number) - 1 : FALLBACK_COLUMNS - 1;
    const clip = (line: string) => (line.length > width ? line.slice(0, width) : line);
    const list = visible();
    const size = pageSize();
    const start = page * size;
    const status = typing
      ? `/${filter}`
      : filter.trim()
        ? `filter: ${filter} (${list.length} of ${rows.length})`
        : `filter: none (${rows.length} ${rows.length === 1 ? "quote" : "quotes"})`;
    const paged = pageCount() > 1 ? `${status} · page ${Math.min(page + 1, pageCount())}/${pageCount()}` : status;
    const lines = [header, paged];
    const slice = list.slice(start, start + size);
    if (!slice.length) lines.push("(no quotes)");
    slice.forEach((row, offset) => {
      const position = offset + 1;
      const cursor = start + offset === focus ? ">" : " ";
      lines.push(`${cursor} ${position} [${checked.has(row.id) ? "x" : " "}] ${quoteChoiceLabel(row)}`);
    });
    lines.push(HINTS);
    const height = terminalHeight();
    if (height != null && lines.length > height) {
      // A screen too short for the hints drops them, then the status line; the
      // rows that remain are the ones the page size already fitted.
      lines.pop();
      if (lines.length > height && lines[1] === paged) lines.splice(1, 1);
      if (lines.length > height) lines.length = Math.max(1, height);
    }
    return lines.map(clip);
  };

  const clearFrame = (): string => {
    const up = upTo(drawn);
    drawn = 0;
    return `${up}\r\x1b[J`;
  };
  const draw = (): void => {
    const lines = frameLines();
    const up = upTo(drawn);
    drawn = lines.length;
    output.write(`${up}\r\x1b[J${lines.join("\n")}`);
  };
  const onResize = () => { followFocus(); draw(); };
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

      // While typing a filter, keys are text: no shortcut may steal them.
      if (typing) {
        const decoded = decodeFilter(buffer);
        if (decoded === "more") {
          const chunk = await source.next(ESCAPE_GRACE_MS);
          if (chunk.kind === "chunk") { buffer += chunk.value; continue; }
          // No tail arrived: this was a lone escape, the way out of the filter.
          buffer = "";
          filter = "";
          typing = false;
          focus = 0;
          page = 0;
          if (chunk.kind === "eof") return undefined;
          draw();
          continue;
        }
        buffer = decoded.rest;
        const key = decoded.key;
        if (key.kind === "cancel") return undefined;
        if (key.kind === "escape") {
          filter = "";
          typing = false;
          focus = 0;
          page = 0;
        } else if (key.kind === "enter") {
          typing = false;
          focus = 0;
          page = 0;
        } else if (key.kind === "backspace") {
          filter = [...filter].slice(0, -1).join("");
          focus = 0;
          page = 0;
        } else if (key.kind === "text") {
          if (filter.length < MAX_FILTER) {
            filter += key.value;
            focus = 0;
            page = 0;
          }
        } else if (key.kind === "navigate") {
          continue;
        }
        draw();
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
      const list = visible();
      const size = pageSize();

      if (key.kind === "cancel") return undefined;
      if (key.kind === "confirm") return rows.filter((row) => checked.has(row.id)).map((row) => row.id);
      if (key.kind === "filter") typing = true;
      else if (key.kind === "up") { if (list.length) focus = (focus + list.length - 1) % list.length; followFocus(); }
      else if (key.kind === "down") { if (list.length) focus = (focus + 1) % list.length; followFocus(); }
      else if (key.kind === "turn") {
        page = Math.min(Math.max(0, page + key.delta), pageCount() - 1);
        focus = Math.min(Math.max(0, list.length - 1), page * size);
      } else if (key.kind === "all") { for (const row of list) checked.add(row.id); }
      else if (key.kind === "none") checked.clear();
      else if (key.kind === "toggle") {
        const row = list[focus];
        if (row) { if (checked.has(row.id)) checked.delete(row.id); else checked.add(row.id); }
      } else if (key.kind === "digit") {
        // The number printed on screen is the key, so a filter or a page keeps them in step.
        const row = list[page * size + key.index];
        if (row) { if (checked.has(row.id)) checked.delete(row.id); else checked.add(row.id); }
      }
      draw();
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

const PLAIN_PROMPT = "Select quotes [1-9, ids, all, none; empty keeps the current set]: ";

/**
 * The numbered prompt. It is used when raw mode is unavailable or when the
 * caller asks for `--plain`, and it never blocks past the end of its input, so
 * a pipeline cannot hang.
 */
export async function pickQuotesPlain(
  name: string,
  rows: QuoteRow[],
  selected: string[] | null,
  io: PickerIo,
): Promise<string[] | undefined> {
  const { input, output } = io;
  const known = new Set(rows.map((row) => row.id));
  const checked = new Set(selected == null ? rows.map((row) => row.id) : selected.filter((id) => known.has(id)));
  const ordered = () => rows.filter((row) => checked.has(row.id)).map((row) => row.id);

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

  output.write(`${headerFor(name)}\n`);
  for (const [index, row] of rows.entries()) {
    output.write(`  ${index + 1} ${checked.has(row.id) ? "[x]" : "[ ]"} ${quoteChoiceLabel(row)}\n`);
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
      else if (text === "all" || text === "a" || text === "*") pick.push(...rows.map((row) => row.id));
      else if (text === "none" || text === "n") pick.length = 0;
      else if (text === "q" || text === "quit" || text === "cancel") return undefined;
      else {
        for (const token of text.split(/[,\s]+/).filter(Boolean)) {
          const position = Number(token);
          const row = Number.isInteger(position) && position >= 1 && position <= rows.length
            ? rows[position - 1]
            : rows.find((candidate) => candidate.id.toLowerCase() === token);
          if (!row) { retry = true; break; }
          if (!pick.includes(row.id)) pick.push(row.id);
        }
      }
      if (retry) {
        output.write(`omastoic: pick 1-${rows.length}, ids, all, or none\n`);
        continue;
      }
      output.write(`${pick.length ? pick.join(", ") : "none (no quotes stay in rotation)"}\n`);
      // Book order, whatever order the numbers and ids were typed in.
      return rows.filter((row) => pick.includes(row.id)).map((row) => row.id);
    }
  } finally {
    // The prompts that follow read the same terminal.
    if (ownsSource) source.close();
    else source.unshift(pending);
  }
}

/** `--plain`, or a tty that cannot go raw, gets the numbered prompt. */
export async function pickQuotes(
  name: string,
  rows: QuoteRow[],
  selected: string[] | null,
  options: PickOptions,
): Promise<string[] | undefined> {
  if (options.plain || !rawTtyUsable(options.input, options.output)) return pickQuotesPlain(name, rows, selected, options);
  return pickQuotesTui(name, rows, selected, options);
}
