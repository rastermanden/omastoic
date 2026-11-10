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

// Loads the panel, waits for the state, edits it, saves, then reports.
const HARNESS = `import QtQuick
import Quickshell
import "ui"

ShellRoot {
  Item {
    Panel {
      id: panel
      onSummaryChanged: console.log("summary:", panel.summary)
      onErrorChanged: console.log("error:", panel.error)
    }
    Timer {
      interval: 500; running: true; repeat: false
      onTriggered: panel.open("")
    }
    Timer {
      interval: 1800; running: true; repeat: false
      onTriggered: {
        console.log("loaded:", panel.interval, panel.selectedAuthors.join(","), panel.customQuotes, "error=" + panel.error, "list=" + panel.shownQuotes.map(function(quote) { return quote.id }).join(","), "rotating=" + panel.rotatingCount)
        panel.quoteFilter = "zeno"
        console.log("filtered:", panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.quoteFilter = ""
        panel.quoteSource = "mine"
        console.log("mine:", panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.quoteSource = "stoics"
        console.log("stoics:", panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.quoteSource = "all"
        panel.quoteState = "off"
        console.log("off:", panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.quoteState = "on"
        console.log("on:", panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.quoteState = "any"
        // Unsaved picks move the list: drop Marcus, add Zeno.
        panel.selectedAuthors = ["seneca", "zeno"]
        panel.quoteState = "on"
        console.log("picked:", panel.picksChanged, panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.selectedAuthors = ["marcus", "seneca"]
        console.log("unpicked:", panel.picksChanged, panel.shownQuotes.map(function(quote) { return quote.id }).join(","))
        panel.quoteState = "any"
        // A partial pick turns "all" on; "all" turned off picks nobody, and nobody blocks Save.
        panel.toggleAll()
        console.log("toggled on:", panel.selectedAuthors.join(","), panel.allPicked)
        panel.toggleAll()
        console.log("toggled off:", panel.selectedAuthors.length, panel.blocker !== "")
        // A half-filled quote blocks Save and survives it.
        panel.selectedAuthors = ["marcus"]
        panel.newCitation = "Meditations IX.1"
        panel.save()
        console.log("half quote:", panel.busy, panel.newCitation, panel.blocker)
        // Names become slugs; a Stoic's full name becomes that Stoic's slug.
        panel.newAuthor = "Marcus Aurelius"
        console.log("name author:", panel.authorSlug)
        panel.newAuthor = "Tomas Sowell"
        console.log("other author:", panel.authorSlug)
        panel.interval = 30
        panel.selectedAuthors = ["marcus", "seneca", "zeno"]
        panel.newCitation = "Meditations IX.1"
        panel.newText = "A line the panel added."
        panel.save()
      }
    }
    Timer {
      interval: 3200; running: true; repeat: false
      onTriggered: {
        console.log("saved:", panel.interval, panel.selectedAuthors.join(","), panel.error, panel.notice)
        // A switch saves one quote at once and leaves unsaved edits alone.
        panel.interval = 45
        panel.keep("q01", false)
        console.log("switched:", panel.quotes[0].kept, panel.busy)
      }
    }
    Timer {
      interval: 4400; running: true; repeat: false
      onTriggered: console.log("after switch:", panel.interval, panel.busy, panel.notice === "")
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
      "summary:",
      "loaded: 90 marcus,seneca 1 error= list=c01,q01,q02 rotating=2",
      "filtered: q02",
      "mine: c01",
      "stoics: q01,q02",
      "off: q02",
      "on: c01,q01",
      "picked: true q02",
      "unpicked: false c01,q01",
      "toggled on: marcus,seneca,zeno true",
      "toggled off: 0 true",
      "half quote: false Meditations IX.1 Your quote needs quote text",
      "name author: marcus",
      "other author: tomas-sowell",
      "switched: false true",
      "after switch: 45 false true",
      "saved: 30 marcus,seneca,zeno  Saved. Your quote is at the top of the quote list and in rotation.",
    ]) {
      if (!result.log.includes(needle)) {
        console.error(`qml smoke: missing ${JSON.stringify(needle)}`);
        process.exit(1);
      }
    }
    const [saved, switched] = result.payload.split("\n");
    if (JSON.stringify(JSON.parse(switched || "null")) !== '{"keep":{"q01":false}}') {
      console.error("qml smoke: unexpected switch payload");
      process.exit(1);
    }
    const payload = JSON.parse(saved || "null");
    const header = readFileSync(join(root, "manifest.json"), "utf8");
    if (payload?.interval !== 30 || payload?.authors?.length !== 3 || payload?.addQuote?.citation !== "Meditations IX.1" || payload?.addQuote?.author !== "tomas-sowell") {
      console.error("qml smoke: unexpected apply payload");
      process.exit(1);
    }
    console.log(`qml smoke: the panel runs, renders and saves (${JSON.parse(header).id})`);
  }
}
