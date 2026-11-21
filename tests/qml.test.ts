import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, failuresIn, lintableSource, root } from "../scripts/check-qml.ts";

// The panel's path comes from the manifest, so moving the entry point (it
// lives in ui/ - see docs/QUICKSHELL-UI.md) cannot leave these tests reading a
// stale file.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const panel = () => readFileSync(join(root, String(manifest.entryPoints.panel)), "utf8");

test("the panel is a summoned panel the host can open, close and query", () => {
  const source = panel();
  for (const needle of [
    "function open(",
    "function close()",
    "property bool opened",
    "property var shell: null",
    "property var manifest: null",
    "import qs.Ui",
    "import qs.Commons",
  ]) expect(source).toContain(needle);
});

test("the panel changes settings only through the CLI bridge", () => {
  const source = panel();
  // No settings-file writing from QML: read with `panel state`, write with `panel apply`.
  expect(source).not.toContain("config.json");
  expect(source).not.toContain("quotes.tsv");
  expect(source).toContain('"panel", "state"');
  expect(source).toContain('"panel", "apply"');
});

test("the settings panel applies changes itself and shows the quote", () => {
  const source = panel();
  expect(source).toContain('text: "Omastoic"');
  expect(source).toContain('label: "Preview"');
  expect(source).toContain("id: quoteSlot");
  expect(source).toContain("height: Math.max(Style.font.body * 1.35 * 3, quotePreviewText.implicitHeight)");
  expect(source).toContain("anchors.verticalCenter: quoteSlot.verticalCenter");
  expect(source).toContain("elide: Text.ElideRight");
  expect(source).not.toContain("fontSizeMode");
  expect(source).toContain("lineHeightMode: Text.FixedHeight");
  expect(source).toContain("font.pixelSize: root.portraitFont");
  expect(source).toContain("lineHeight: root.portraitLine");
  expect(source).toContain("portraitFont = Number(parsed.portraitFont)");
  expect(source).not.toContain("preview.portraitFont");
  expect(source).not.toContain("preview.portraitLine");
  expect(source).not.toContain("maximumLineCount: 4");
  expect(source).toContain("focusable: true");
  expect(source).toContain("component RingButton");
  expect(source).toContain("border.color: Commons.Color.accent");
  expect(source).toContain("Every ");
  expect(source).toContain("seconds");
  expect(source).toContain("Add your own quote");
  expect(source).toContain("Add an author");
  expect(source).toContain("addAuthor");
  expect(source).toContain("removeQuote");
  expect(source).not.toContain("authors.tsv");
  expect(source).toContain("intervalApplied");
  expect(source).toContain("placeholderTextColor");
  expect(source).toContain("Commons.Color.accent");
  expect(source).not.toContain("Qt.darker");
  expect(source).not.toContain("MultiSelect");
  expect(source).not.toContain("Toggle {");
  expect(source).not.toContain('text: "Save"');
  expect(source).not.toContain('text: "Reload"');
  expect(source).not.toContain("Search");
  expect(source).not.toContain("Author slug");
  expect(source).toContain("anchors.top: parent.top");
  expect(source).toContain("restoreCommitted");
  expect(source).toContain("previewTimer");
  expect(source).toContain("implicitHeight: Style.font.bodySmall * 2");
});

function portraitFullyVisible(top: number, height: number, contentY: number, viewport: number) {
  return top >= contentY - 0.5 && top + height <= contentY + viewport + 0.5;
}

test("a partial portrait is hidden and focused fields still scroll into view", () => {
  expect(portraitFullyVisible(0, 80, 0, 400)).toBe(true);
  expect(portraitFullyVisible(0, 80, 4, 400)).toBe(false);
  expect(portraitFullyVisible(0, 80, 80, 400)).toBe(false);
  expect(portraitFullyVisible(100, 80, 100, 400)).toBe(true);
  const source = panel();
  expect(source).toContain("function portraitFullyVisible(top, height, contentY, viewport)");
  expect(source).toContain("return top >= contentY - 0.5 && top + height <= contentY + viewport + 0.5");
  expect(source).toContain("opacity: portraitFullyVisible(");
  expect(source).toContain("scroller.contentY = Math.max(0, bottom - scroller.height + 8)");
});

test("hover stays distinct from focus and from the selected tint", () => {
  const source = panel();
  expect(source).toContain("hoverEnabled: true");
  expect(source).toContain("cursorShape: Qt.PointingHandCursor");
  expect(source).toContain("HoverHandler");
  expect(source).toContain("Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.16)");
  expect(source).toContain("Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08)");
  expect(source).toContain("border.color: activeFocus ? Commons.Color.accent : root.ink");
  expect(source).toContain("border.color: inner.activeFocus ? Commons.Color.accent : root.ink");
  expect(source).toContain("buttonHover.hovered && host.available");
  expect(source).toContain("enabled: !host.available");
  expect(source).toContain("selected: false");
  expect(source).toContain("Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.25)");
  expect(source).toContain("id: labelText");
  expect(source).toContain("color: root.ink");
});

test("author chips move focus with the arrow keys and never leave the grid", () => {
  const source = panel();
  expect(source).toContain("id: authorGrid");
  expect(source).toContain("id: authorChips");
  expect(source).toContain("columns: 3");
  expect(source).toContain("property int chipIndex: index");
  for (const key of ["Qt.Key_Left", "Qt.Key_Right", "Qt.Key_Up", "Qt.Key_Down"]) {
    expect(source).toContain(key);
  }
  // Movement stays inside the grid. The modulo guard keeps left and right in
  // the row, the target index stays within the model, and focus lands on the
  // chip through a method whose name does not collide with Item.focus.
  expect(source).toContain("chipIndex % columns");
  expect(source).toContain("target < root.samples.length");
  expect(source).toContain("authorChips.itemAt(target)");
  expect(source).toContain("chip.takeFocus()");
  expect(source).toContain("function takeFocus() { inner.forceActiveFocus() }");
  // `function focus()` on an Item-derived component does not shadow Item.focus,
  // so calling `.focus()` throws. The guard below fails the test if that name
  // ever comes back.
  expect(source).not.toContain("function focus()");
});

function delegateBody(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function delegatesUsingIndexWithoutDeclaringIt(source: string): string[] {
  const problems: string[] = [];
  const marker = /delegate\s*:\s*[A-Za-z0-9_.]+\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    const open = source.indexOf("{", match.index);
    const body = delegateBody(source, open);
    const usesIndex = /\bindex\b/.test(body);
    const requiresProperty = /required\s+property\b/.test(body);
    const declaresIndex = /required\s+property\s+int\s+index\b/.test(body);
    if (usesIndex && requiresProperty && !declaresIndex) problems.push(body.slice(0, 60).replace(/\s+/g, " "));
  }
  return problems;
}

test("a required-property delegate that reads index declares it", () => {
  const broken = "delegate: RingButton { required property var modelData property int chipIndex: index }";
  const fixed = "delegate: RingButton { required property var modelData required property int index property int chipIndex: index }";
  expect(delegatesUsingIndexWithoutDeclaringIt(broken)).toHaveLength(1);
  expect(delegatesUsingIndexWithoutDeclaringIt(fixed)).toEqual([]);
  expect(delegatesUsingIndexWithoutDeclaringIt(panel())).toEqual([]);
});

test("import rewriting only touches the qs prefix", () => {
  expect(lintableSource("import qs.Ui\nimport qs.Commons as Commons\nimport Quickshell\n")).toBe(
    "import Ui\nimport Commons\nimport Quickshell\n",
  );
});

test("kit noise is reported but is not a failure", () => {
  expect(failuresIn('Warning: f.qml:1:1: Member "popupPadding" not found on type "QObject" [missing-property]')).toEqual([]);
  expect(failuresIn('Warning: f.qml:1:1: Unqualified access [unqualified]')).toEqual([]);
  expect(failuresIn("Warning: f.qml:1:1: Type Toggel is not a type [unresolved-type]")).toHaveLength(1);
  expect(failuresIn("Warning: f.qml:1:1: Expected token '{' [syntax]")).toHaveLength(1);
});

test("the plugin's QML entry points compile against the host kit", () => {
  const result = check();
  if (result.skipped) {
    console.log(`skipping the QML compile check: ${result.skipped}`);
    return;
  }
  expect(result.failures).toEqual([]);
  expect(result.code).toBe(0);
});
