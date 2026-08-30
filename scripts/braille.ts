#!/usr/bin/env bun
// Encode a 1-bit ASCII PBM (P1) on stdin into Unicode braille art on stdout.
// Each braille cell packs a 2x4 pixel block, so the art keeps four times the
// vertical detail a block-character encoder would.

const DOTS = [
  [0x01, 0x02, 0x04, 0x40], // left column, top to bottom
  [0x08, 0x10, 0x20, 0x80], // right column
];

const text = await Bun.stdin.text();
const tokens = text
  .split("\n")
  .map((line) => line.replace(/#.*/, ""))
  .join(" ")
  .trim()
  .split(/\s+/);

if (tokens[0] !== "P1") {
  console.error("braille: expected an ASCII PBM (P1) on stdin");
  process.exit(1);
}

const width = Number(tokens[1]);
const height = Number(tokens[2]);
const pixels = tokens.slice(3);
const on = (x: number, y: number) =>
  x < width && y < height && pixels[y * width + x] === "1";

const rows: string[] = [];
for (let y = 0; y < height; y += 4) {
  let row = "";
  for (let x = 0; x < width; x += 2) {
    let code = 0;
    for (let dx = 0; dx < 2; dx++)
      for (let dy = 0; dy < 4; dy++)
        if (on(x + dx, y + dy)) code |= DOTS[dx][dy];
    row += code === 0 ? " " : String.fromCharCode(0x2800 + code);
  }
  rows.push(row.replace(/\s+$/, ""));
}

// Trim fully blank rows off the top and bottom; the caller places the art.
while (rows.length && rows[0].trim() === "") rows.shift();
while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();

console.log(rows.join("\n"));
