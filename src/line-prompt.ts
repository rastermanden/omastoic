// The prompts `omastoic config` needs after the pickers, without gum: a single
// editable line, a ctrl-d multi-line block for a quote, and a y/n question.
// The text block ends on ctrl-d; no editor is ever launched, so a headless
// terminal can still finish the flow.

import { ChunkSource, rawTtyUsable, type PickerIo } from "./author-picker.ts";

export type LinePrompt = { header: string; value?: string; charLimit?: number };

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** How long a trailing escape byte waits for the rest of an arrow sequence. */
const ESCAPE_GRACE_MS = 20;
const FALLBACK_COLUMNS = 80;
const MAX_FIELD = 4096;
const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;

type Frame = {
  source: ChunkSource;
  draw(lines: string[]): void;
  done(): void;
};

function clip(text: string, columns: number | undefined): string {
  const width = Number.isInteger(columns) && (columns ?? 0) > 4 ? (columns as number) - 1 : FALLBACK_COLUMNS - 1;
  return text.length > width ? text.slice(0, width) : text;
}

/**
 * Take the terminal for one prompt. Everything a prompt needs back — the raw
 * mode it found, the cursor, the resize and signal listeners and the stdin
 * reader — is released by `done()`, which every exit path calls.
 */
function startFrame(io: PickerIo, redraw: () => void): Frame {
  const { input, output, signals, source: shared } = io;
  const source = shared ?? new ChunkSource(input);
  const ownsSource = shared == null;
  const wasRaw = input.isRaw === true;
  const onResize = () => redraw();
  // SIGINT is a user cancelling; SIGTERM and SIGHUP mean the process must die.
  let fatal: string | null = null;
  const onSignal = (signal: string) => {
    if (signal === "SIGTERM" || signal === "SIGHUP") fatal = signal;
    source.inject("\x03");
  };
  // A stream reports only that the event fired, so each listener knows its name.
  const signalListeners = Object.fromEntries(SIGNALS.map((signal) => [signal, () => onSignal(signal)])) as Record<(typeof SIGNALS)[number], () => void>;
  let drawn = 0;

  // A terminal that is already raw belongs to whatever set it that way.
  if (!wasRaw) input.setRawMode?.(true);
  output.write(HIDE_CURSOR);
  output.on?.("resize", onResize);
  for (const signal of SIGNALS) signals?.on(signal, signalListeners[signal]);

  return {
    source,
    draw(lines) {
      const up = drawn > 0 ? `\x1b[${drawn - 1}A` : "";
      drawn = lines.length;
      output.write(`${up}\r\x1b[J${lines.join("\n")}`);
    },
    done() {
      if (ownsSource) source.close();
      try {
        const up = drawn > 0 ? `\x1b[${drawn - 1}A` : "";
        output.write(`${up}\r\x1b[J${SHOW_CURSOR}`);
      } catch { /* the tty is already gone */ }
      if (!wasRaw) {
        try { input.setRawMode?.(false); } catch { /* the tty is already gone */ }
      }
      output.off?.("resize", onResize);
      for (const signal of SIGNALS) signals?.off?.(signal, signalListeners[signal]);
      // The terminal is back, so the signal can now take its normal course.
      if (fatal) io.fatal?.(fatal);
    },
  };
}

/** Buffered reads for the piped prompts, so no byte of a pipe is lost. */
function lineReader(source: ChunkSource): { line(): Promise<string | null>; rest(): Promise<string | null> } {
  let pending = "";
  return {
    async line() {
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          // Whatever followed the answer belongs to the next prompt in the run.
          if (pending) { source.unshift(pending); pending = ""; }
          return line.replace(/\r$/, "");
        }
        const chunk = await source.next();
        if (chunk.kind === "chunk") { pending += chunk.value; continue; }
        if (pending) { const line = pending; pending = ""; return line.replace(/\r$/, ""); }
        return null;
      }
    },
    async rest() {
      for (;;) {
        const chunk = await source.next();
        if (chunk.kind === "chunk") { pending += chunk.value; continue; }
        if (!pending) return null;
        const text = pending;
        pending = "";
        return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      }
    },
  };
}

/** One character from the stream, or null when the input ended. */
async function nextChar(source: ChunkSource, buffer: { value: string }): Promise<string | null> {
  while (!buffer.value) {
    const chunk = await source.next();
    if (chunk.kind === "eof") return null;
    if (chunk.kind !== "chunk") continue;
    buffer.value = chunk.value;
  }
  const char = buffer.value[0]!;
  buffer.value = buffer.value.slice(1);
  return char;
}

/**
 * A lone escape cancels, but an escape that starts an arrow or a function key
 * is swallowed whole so moving the cursor never ends the prompt.
 */
async function escapeIsSequence(source: ChunkSource, buffer: { value: string }): Promise<boolean> {
  if (!buffer.value) {
    const more = await source.next(ESCAPE_GRACE_MS);
    if (more.kind === "chunk") buffer.value += more.value;
    else return false;
  }
  const sequence = /^[[O]?\[?[0-9;]*[A-Za-z~]/.exec(buffer.value);
  if (!sequence) return false;
  buffer.value = buffer.value.slice(sequence[0].length);
  return true;
}

type EditKey =
  | { kind: "insert"; value: string }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "clear" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "ignore" };

/**
 * One key of an editable line. Escape sequences are decoded whole; a sequence
 * a read split waits for its tail, so no fragment is typed or cancels.
 */
function decodeEdit(buffer: string): { key: EditKey; rest: string } | "more" {
  const [first] = buffer;
  if (first === "\x1b") {
    if (buffer.length === 1) return "more";
    const sequence = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(buffer);
    if (!sequence) {
      // A partial sequence is not a cancel; it is still arriving.
      if (buffer[1] === "[" || buffer[1] === "O") return "more";
      return { key: { kind: "cancel" }, rest: buffer.slice(1) };
    }
    const rest = buffer.slice(sequence[0].length);
    const name = sequence[0];
    if (name === "\x1b[D" || name === "\x1bOD") return { key: { kind: "left" }, rest };
    if (name === "\x1b[C" || name === "\x1bOC") return { key: { kind: "right" }, rest };
    if (name === "\x1b[H" || name === "\x1bOH" || name === "\x1b[1~" || name === "\x1b[7~") return { key: { kind: "home" }, rest };
    if (name === "\x1b[F" || name === "\x1bOF" || name === "\x1b[4~" || name === "\x1b[8~") return { key: { kind: "end" }, rest };
    if (name === "\x1b[3~") return { key: { kind: "delete" }, rest };
    return { key: { kind: "ignore" }, rest };
  }
  const rest = buffer.slice(1);
  if (first === "\r" || first === "\n") return { key: { kind: "confirm" }, rest };
  if (first === "\x03" || first === "\x04") return { key: { kind: "cancel" }, rest };
  if (first === "\x7f" || first === "\x08") return { key: { kind: "backspace" }, rest };
  if (first === "\x15") return { key: { kind: "clear" }, rest };
  if (first >= " ") return { key: { kind: "insert", value: first }, rest };
  return { key: { kind: "ignore" }, rest };
}

/** A single editable line: enter accepts, ctrl-c, ctrl-d or escape cancel. */
export async function askLine(prompt: LinePrompt, io: PickerIo): Promise<string | undefined> {
  const { input, output } = io;
  if (!rawTtyUsable(input, output)) {
    const source = io.source ?? new ChunkSource(input);
    const ownsSource = io.source == null;
    try {
      output.write(`${prompt.header}: `);
      return (await lineReader(source).line()) ?? undefined;
    } finally {
      if (ownsSource) source.close();
    }
  }

  const limit = prompt.charLimit ?? MAX_FIELD;
  const chars = [...(prompt.value ?? "")];
  let cursor = chars.length;
  const label = `${prompt.header}: `;
  const width = (): number => (Number.isInteger(output.columns) && (output.columns ?? 0) > 4 ? (output.columns as number) - 1 : FALLBACK_COLUMNS - 1);
  let frame: Frame;
  const redraw = () => {
    // A line longer than the terminal scrolls under the cursor instead of hiding it.
    const caret = label.length + cursor;
    const room = width();
    const start = caret > room - 1 ? caret - (room - 1) : 0;
    const shown = (label + chars.join("")).slice(start, start + room);
    frame.draw([shown]);
    const back = start + shown.length - caret;
    if (back > 0) output.write(`\x1b[${back}D`);
  };
  frame = startFrame(io, redraw);
  // An editable line shows its caret; the prompts that only display text do not.
  output.write(SHOW_CURSOR);
  const buffer = { value: "" };
  try {
    redraw();
    for (;;) {
      if (!buffer.value) {
        const chunk = await frame.source.next();
        if (chunk.kind === "eof") return undefined;
        if (chunk.kind !== "chunk") continue;
        buffer.value = chunk.value;
        continue;
      }
      const decoded = decodeEdit(buffer.value);
      if (decoded === "more") {
        const more = await frame.source.next(ESCAPE_GRACE_MS);
        if (more.kind === "chunk") { buffer.value += more.value; continue; }
        // A lone escape still cancels.
        return undefined;
      }
      buffer.value = decoded.rest;
      const key = decoded.key;
      if (key.kind === "confirm") return chars.join("");
      if (key.kind === "cancel") return undefined;
      if (key.kind === "backspace") {
        if (cursor > 0) { chars.splice(cursor - 1, 1); cursor -= 1; }
      } else if (key.kind === "delete") {
        if (cursor < chars.length) chars.splice(cursor, 1);
      } else if (key.kind === "left") {
        if (cursor > 0) cursor -= 1;
      } else if (key.kind === "right") {
        if (cursor < chars.length) cursor += 1;
      } else if (key.kind === "home") {
        cursor = 0;
      } else if (key.kind === "end") {
        cursor = chars.length;
      } else if (key.kind === "clear") {
        chars.length = 0;
        cursor = 0;
      } else if (key.kind === "insert" && chars.length < limit) {
        chars.splice(cursor, 0, key.value);
        cursor += 1;
      }
      redraw();
    }
  } finally {
    io.source?.unshift(buffer.value);
    frame.done();
  }
}

/** A block of text: enter starts a new line, ctrl-d submits, ctrl-c cancels. */
export async function askText(prompt: LinePrompt, io: PickerIo): Promise<string | undefined> {
  const { input, output } = io;
  if (!rawTtyUsable(input, output)) {
    const source = io.source ?? new ChunkSource(input);
    const ownsSource = io.source == null;
    try {
      output.write(`${prompt.header}: `);
      return (await lineReader(source).rest()) ?? undefined;
    } finally {
      if (ownsSource) source.close();
    }
  }

  const limit = prompt.charLimit ?? MAX_FIELD;
  let text = prompt.value ?? "";
  let frame: Frame;
  const redraw = () => {
    const lines = [`${prompt.header}:`, ...text.split("\n").map((line) => clip(`| ${line}`, output.columns))];
    frame.draw(lines);
  };
  frame = startFrame(io, redraw);
  const buffer = { value: "" };
  try {
    redraw();
    for (;;) {
      const char = await nextChar(frame.source, buffer);
      // End of input is the same answer as ctrl-d.
      if (char == null) return text.replace(/\n+$/, "");
      if (char === "\x04") return text.replace(/\n+$/, "");
      if (char === "\x03") return undefined;
      if (char === "\x1b") {
        if (await escapeIsSequence(frame.source, buffer)) continue;
        return undefined;
      }
      if (char === "\r" || char === "\n") {
        if ([...text].length < limit) text += "\n";
      } else if (char === "\x15") {
        text = "";
      } else if (char === "\x7f" || char === "\x08") {
        text = [...text].slice(0, -1).join("");
      } else if (char >= " " && [...text].length < limit) {
        text += char;
      }
      redraw();
    }
  } finally {
    io.source?.unshift(buffer.value);
    frame.done();
  }
}

/** A y/n question: y confirms, n or enter declines, escape or a signal aborts. */
export async function askConfirm(prompt: string, io: PickerIo): Promise<boolean | undefined> {
  const { input, output } = io;
  const line = `${prompt} [y/N] `;
  if (!rawTtyUsable(input, output)) {
    const source = io.source ?? new ChunkSource(input);
    const ownsSource = io.source == null;
    try {
      output.write(line);
      const answer = (await lineReader(source).line())?.trim().toLowerCase();
      if (answer == null) return undefined;
      return answer === "y" || answer === "yes";
    } finally {
      if (ownsSource) source.close();
    }
  }

  let frame: Frame;
  frame = startFrame(io, () => frame.draw([clip(line, output.columns)]));
  const buffer = { value: "" };
  try {
    frame.draw([clip(line, output.columns)]);
    for (;;) {
      const char = await nextChar(frame.source, buffer);
      if (char == null) return undefined;
      if (char === "y" || char === "Y") return true;
      if (char === "\r" || char === "\n" || char === "n" || char === "N") return false;
      if (char === "\x03" || char === "\x04") return undefined;
      if (char === "\x1b") {
        if (await escapeIsSequence(frame.source, buffer)) continue;
        return undefined;
      }
    }
  } finally {
    io.source?.unshift(buffer.value);
    frame.done();
  }
}

