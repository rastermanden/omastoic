#!/usr/bin/env bun
// Load the panel in a real Quickshell process, against the host's kit, with a
// fake `bin/omastoic` that answers `panel state` and logs `panel apply`.
//
// This is an opt-in smoke test, not part of `bun test`: it needs a Wayland
// session and a Quickshell binary, and it maps (invisible) windows. It proves
// what qmllint cannot: that Quickshell instantiates the panel, runs the CLI,
// renders the reported state, and sends exactly the JSON the CLI expects.
//
//   bun scripts/qml-smoke.ts

import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryPoints, hostShell, root } from "./check-qml.ts";

export const STATE_JSON = {
  settings: { interval: 90, authors: ["marcus", "seneca"] },
  summary: "Marcus Aurelius, Seneca · every 90s",
  allAuthors: false,
  authors: [
    { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", selected: true },
    { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", selected: true },
    { slug: "zeno", name: "Zeno of Citium", dates: "c. 334 – 262 BC", selected: false },
  ],
  customQuotes: 1,
  quotes: [
    { id: "q01", author: "marcus", name: "Marcus Aurelius", citation: "Meditations II.5", text: "A bundled line.", custom: false, switchable: true, kept: true, inRotation: true },
    { id: "q02", author: "zeno", name: "Zeno of Citium", citation: "DL VII", text: "Not picked.", custom: false, switchable: true, kept: true, inRotation: false },
    { id: "c01", author: "marcus", name: "Marcus Aurelius", citation: "Meditations IX.1", text: "Your line.", custom: true, switchable: true, kept: true, inRotation: true },
  ],
  customQuotesError: "",
  configPath: "/dev/null",
  quotesPath: "/dev/null",
};

/** The fake CLI: answers state, logs the apply payload, echoes newer state. */
function fakeCli(stateJson: string, echo: string, dir: string): string {
  return `#!/bin/bash
set -eu
log="${join(dir, "apply.log")}"
case "\${1:-}:\${2:-}" in
  panel:state)
    # A successful run may still warn on stderr; the panel must not show it.
    echo "omastoic: ignoring unreadable /dev/null" >&2
    cat <<'JSON'
${stateJson}
JSON
    ;;
  panel:apply)
    printf '%s\\n' "\${3:-}" >> "$log"
    cat <<'JSON'
${echo}
JSON
    ;;
  *) echo "fake omastoic: $*" >&2; exit 1 ;;
esac
`;
}

/** A throwaway Quickshell config: our panel, the host kit, a fake CLI. */
export function fixture(): string {
  const host = hostShell();
  if (!host) throw new Error("no Omarchy shell to load the panel against");
  const dir = mkdtempSync(join(tmpdir(), "omastoic-panel-"));
  const panel = entryPoints().find((path) => path.endsWith("Panel.qml"));
  if (!panel) throw new Error("the manifest declares no Panel.qml entry point");
  // Keep the entry point's path inside the fixture: the panel finds its CLI at
  // <plugin>/bin/omastoic relative to where the host put the manifest's
  // __sourceDir.
  const relative = panel.slice(root.length + 1);
  mkdirSync(join(dir, relative, ".."), { recursive: true });
  cpSync(panel, join(dir, relative));
  for (const module of ["Commons", "Ui"]) symlinkSync(join(host, module), join(dir, module));
  mkdirSync(join(dir, "bin"));
  const applied = { ...STATE_JSON, settings: { interval: 30, authors: ["marcus", "seneca", "zeno"] }, summary: "Marcus Aurelius, Seneca, Zeno of Citium · every 30s", customQuotes: 2 };
  const cli = fakeCli(JSON.stringify(STATE_JSON, null, 2), JSON.stringify(applied, null, 2), dir);
  writeFileSync(join(dir, "bin/omastoic"), cli);
  chmodSync(join(dir, "bin/omastoic"), 0o755);
  writeFileSync(join(dir, "shell.qml"), HARNESS);
  return dir;
}

// Loads the panel, waits for the state, makes each kind of change, then reports.
// Every change saves at once; the fake CLI logs one payload per line, in order.
const HARNESS = `import QtQuick
import Quickshell
import "ui"

ShellRoot {
  Item {
    id: harness
    Panel {
      id: panel
      onErrorChanged: if (panel.error !== "") console.log("error:", panel.error)
    }
    function ids() { return panel.shownQuotes.map(function(quote) { return quote.id }).join(",") }
    Timer {
      interval: 500; running: true; repeat: false
      onTriggered: panel.open("")
    }
    Timer {
      interval: 1800; running: true; repeat: false
      onTriggered: {
        console.log("loaded:", panel.picked.join(","), panel.rotatingCount, harness.ids(), panel.mineOn)
        panel.listFilter = "on"; console.log("on:", harness.ids())
        panel.listFilter = "off"; console.log("off:", harness.ids())
        panel.listFilter = "mine"; console.log("mine:", harness.ids())
        panel.listFilter = "all"
        panel.search = "zeno"; console.log("search:", harness.ids())
        panel.search = ""
        // Names become slugs; a Stoic's short or full name becomes that Stoic's slug.
        panel.newAuthor = "Seneca"; console.log("slug:", panel.authorSlug)
        panel.newAuthor = "Marcus Aurelius"; console.log("slug:", panel.authorSlug)
        panel.newAuthor = "Tomas Sowell"; console.log("slug:", panel.authorSlug, panel.addBlocker)
        // Each change queues one save.
        panel.toggleStoic("seneca")
        panel.setPicked([])
        panel.keep("q01", false)
        console.log("flipped:", panel.quotes[0].kept)
        panel.toggleMine()
        panel.adding = true
        panel.newCitation = "Basic Economics"
        panel.newText = "There are no solutions, only trade-offs."
        panel.addQuote()
        panel.changeSeconds(45)
      }
    }
    Timer {
      interval: 4600; running: true; repeat: false
      onTriggered: console.log("done:", panel.busy, panel.queue.length, panel.adding, panel.listFilter, panel.error === "")
    }
  }
}
`;

/** Run the harness and return its log plus the payload the panel sent. */
export function smoke(timeoutMs = 8000): { skipped?: string; log: string; payload: string } {
  if (!Bun.which("quickshell")) return { skipped: "quickshell is not installed", log: "", payload: "" };
  if (!process.env.WAYLAND_DISPLAY) return { skipped: "no Wayland session", log: "", payload: "" };
  const dir = fixture();
  try {
    const run = Bun.spawnSync(["timeout", String(Math.ceil(timeoutMs / 1000)), "quickshell", "-p", join(dir, "shell.qml")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = `${run.stdout.toString()}${run.stderr.toString()}`;
    let payload = "";
    try {
      payload = readFileSync(join(dir, "apply.log"), "utf8").trim();
    } catch { /* the panel never saved */ }
    return { log, payload };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = smoke();
  if (result.skipped) {
    console.log(`qml smoke: skipped — ${result.skipped}`);
  } else {
    console.log(result.log.trim());
    for (const needle of [
      "loaded: marcus,seneca 2 c01,q01,q02 true",
      "on: c01,q01",
      "off: q02",
      "mine: c01",
      "search: q02",
      "slug: seneca",
      "slug: marcus",
      "slug: tomas-sowell Needs a citation and the quote.",
      "flipped: false",
      "done: false 0 false mine true",
    ]) {
      if (!result.log.includes(needle)) {
        console.error(`qml smoke: missing ${JSON.stringify(needle)}`);
        process.exit(1);
      }
    }
    const sent = result.payload.split("\n").map((line) => JSON.stringify(JSON.parse(line)));
    const expected = [
      { authors: ["marcus"], mineOnly: false },
      { mineOnly: true },
      { keep: { q01: false } },
      { keep: { c01: false } },
      { addQuote: { author: "tomas-sowell", citation: "Basic Economics", text: "There are no solutions, only trade-offs." } },
      { interval: 45 },
    ].map((payload) => JSON.stringify(payload));
    if (JSON.stringify(sent) !== JSON.stringify(expected)) {
      console.error(`qml smoke: unexpected payloads\n${sent.join("\n")}`);
      process.exit(1);
    }
    const header = readFileSync(join(root, "manifest.json"), "utf8");
    console.log(`qml smoke: the panel runs, renders and saves (${JSON.parse(header).id})`);
  }
}
