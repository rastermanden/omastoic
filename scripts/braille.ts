#!/usr/bin/env bun
// Encode a 1-bit ASCII PBM (P1) on stdin into Unicode braille art on stdout.
// Each braille cell packs a 2x4 pixel block, so the art keeps four times the
// vertical detail a block-character encoder would.

import { pbmToBraille } from "../src/portrait.ts";

try {
  console.log(pbmToBraille(await Bun.stdin.text()));
} catch (error) {
  console.error(`braille: ${(error as Error).message}`);
  process.exit(1);
}
