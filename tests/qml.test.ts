import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  expect(source).toContain('"panel", "pick-image", "--watch-stdin"');
  expect(source).toContain('"panel", "preview-portrait"');
  expect(source).toContain("stdinEnabled: true");
});

test("the settings panel applies changes itself and shows the quote", () => {
  const source = panel();
  expect(source).toContain('text: "Omastoic"');
  expect(source).toContain('label: "Preview"');
  expect(source).toContain("id: quoteSlot");
  expect(source).toContain("height: Math.ceil(Style.font.body * 1.35) * 3");
  expect(source).toContain("id: citationSlot");
  expect(source).toContain("anchors.verticalCenter: quoteSlot.verticalCenter");
  expect(source).toContain("elide: Text.ElideRight");
  expect(source).not.toContain("fontSizeMode");
  expect(source).toContain("lineHeightMode: Text.FixedHeight");
  expect(source).toContain("font.pixelSize: root.portraitFont");
  expect(source).toContain("lineHeight: root.portraitLine");
  expect(source).toContain("portraitFont = Number(parsed.portraitFont)");
  expect(source).toContain("previewPortraitFont = Number(parsed.previewPortraitFont)");
  expect(source).toContain("font.pixelSize: root.previewPortraitFont");
  expect(source).toContain("lineHeight: root.previewPortraitLine");
  expect(source).toContain("id: authorPortraitPreviewBox");
  expect(source).toContain("id: authorPortraitPreviewText");
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
  expect(source).toContain("replaceAuthor");
  expect(source).toContain("removeAuthor");
  expect(source).toContain('label: "Choose image"');
  expect(source).toContain("chooseAuthorImage()");
  expect(source).toContain("visible: root.opened && !root.pickingImage");
  expect(source).toContain("WlrLayershell.keyboardFocus: root.pickingImage ? WlrKeyboardFocus.None : WlrKeyboardFocus.Exclusive");
  expect(source).toContain("Could not open the file picker. Type a path instead.");
  expect(source).toContain("Choose a JPEG or PNG saved on this computer.");
  expect(source).toContain("Accessible.name: host.label");
  expect(source).toContain('Accessible.name: root.editingAuthorSlug !== "" ? "New portrait image path" : "Portrait image path"');
  expect(source).toContain("confirmRemoveAuthor");
  expect(source).toContain("requestRemoveAuthor");
  expect(source).toContain('"Remove?"');
  expect(source).toContain('root.confirmRemoveAuthor = ""');
  expect(source).toContain("modelData.custom === true");
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
  expect(source).not.toContain("Short id");
  expect(source).not.toContain("Replace author");
  expect(source).toContain('"Save changes"');
  expect(source).toContain('"Edit "');
  expect(source).toContain("component QuoteArea");
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
  expect(source).toContain("opacity: root.portraitFullyVisible(");
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
  expect(source).toContain("border.color: host.destructive ? Commons.Color.urgent : (inner.activeFocus ? Commons.Color.accent : root.ink)");
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

test("kit noise is reported but only Style and Commons.Color unqualified lookups are filtered", () => {
  expect(failuresIn('Warning: f.qml:1:1: Member "popupPadding" not found on type "QObject" [missing-property]')).toEqual([]);
  expect(failuresIn("Warning: f.qml:1:1: Type Toggel is not a type [unresolved-type]")).toHaveLength(1);
  expect(failuresIn("Warning: f.qml:1:1: Expected token '{' [syntax]")).toHaveLength(1);

  // Host kit singletons (`Style` and `Commons.Color`) are filtered.
  expect(failuresIn([
    "Warning: f.qml:4:17: Unqualified access [unqualified]",
    "  border.color: Commons.Color.accent",
    "                ^^^^^^^",
    "Warning: f.qml:5:16: Unqualified access [unqualified]",
    "  font.family: Style.font.family",
    "               ^^^^^",
  ].join("\n"))).toEqual([]);

  // Any other unqualified access fails, including bare warnings without source context.
  expect(failuresIn("Warning: f.qml:1:1: Unqualified access [unqualified]")).toHaveLength(1);
  expect(failuresIn([
    "Warning: f.qml:6:21: Unqualified access [unqualified]",
    "  property int bad: mysteryValue",
    "                    ^^^^^^^^^^^^",
  ].join("\n"))).toHaveLength(1);
  expect(failuresIn([
    "Warning: f.qml:7:11: Unqualified access [unqualified]",
    "  text: modelData.name",
    "        ^^^^^^^^^",
  ].join("\n"))).toHaveLength(1);

  // Near-miss names are not treated as the host kit singletons.
  for (const [source, caret] of [
    ["  property var x: Commons.Other.accent", "                  ^^^^^^^"],
    ["  property var x: Commons.ColorScheme.accent", "                  ^^^^^^^"],
    ["  property var x: Commons", "                  ^^^^^^^"],
    ["  property var x: CommonsHelper.Color.accent", "                  ^^^^^^^^^^^^^"],
    ["  property var x: StyleHelper.font", "                  ^^^^^^^^^^^"],
    ["  property var x: foo.Style.font", "                      ^^^^^"],
  ]) {
    expect(failuresIn(`Warning: f.qml:1:1: Unqualified access [unqualified]\n${source}\n${caret}`), source).toHaveLength(1);
  }

  // On a mixed line (including tabs in either qmllint or formatted placement, and UTF-8), only Commons.Color is filtered.
  const mixed = [
    "Warning: f.qml:4:21: Unqualified access [unqualified]",
    "\tproperty color c1: badFlag ? Commons.Color.accent : otherBad",
    "\t                   ^^^^^^^",
    "Warning: f.qml:4:31: Unqualified access [unqualified]",
    "\tproperty color c1: badFlag ? Commons.Color.accent : otherBad",
    "                             \t^^^^^^^",
    "Warning: f.qml:4:54: Unqualified access [unqualified]",
    "\tproperty color c1: badFlag ? Commons.Color.accent : otherBad",
    "\t                                                    ^^^^^^^^",
    "Warning: f.qml:5:32: Unqualified access [unqualified]",
    '  property string a: "✓ — …" + Commons.Color.accent',
    "                               ^^^^^^^",
    "Warning: f.qml:6:32: Unqualified access [unqualified]",
    '  property string b: "✓ — …" + badVar',
    "                               ^^^^^^",
  ].join("\n");
  expect(failuresIn(mixed)).toEqual([
    "Warning: f.qml:4:21: Unqualified access [unqualified]",
    "Warning: f.qml:4:54: Unqualified access [unqualified]",
    "Warning: f.qml:6:32: Unqualified access [unqualified]",
  ]);

  // Dotted Qt plugin warning IDs and bracketless Error lines still fail.
  expect(failuresIn("Warning: f.qml:8:1: Bad reuse [Quick.attached-property-reuse]")).toHaveLength(1);
  expect(failuresIn("Error: f.qml:8:1: Fatal parse error")).toHaveLength(1);

  // Echoed source lines ending in brackets are not mistaken for warning headers.
  expect(failuresIn([
    "Warning: f.qml:9:10: Member \"foo\" not found on type \"QObject\" [missing-property]",
    "  text: items[idx]",
    "        ^^^^^",
  ].join("\n"))).toEqual([]);
});

test("real qmllint allows Style and Commons.Color but fails unqualified access in our QML", () => {
  const scratch = mkdtempSync(join(tmpdir(), "omastoic-qml-test-"));
  try {
    const kitOnly = join(scratch, "KitOnly.qml");
    writeFileSync(kitOnly, [
      "import QtQuick",
      "import qs.Commons",
      "import qs.Commons as Commons",
      "Item {",
      "  property color accent: Commons.Color.accent",
      "  property int radius: Style.cornerRadius",
      "}",
      "",
    ].join("\n"));

    const kitResult = check([kitOnly]);
    if (kitResult.skipped) {
      console.log(`skipping real qmllint unqualified check: ${kitResult.skipped}`);
      return;
    }
    expect(kitResult.failures).toEqual([]);
    expect(kitResult.code).toBe(0);

    const broken = join(scratch, "Broken.qml");
    writeFileSync(broken, [
      "import QtQuick",
      "import qs.Commons",
      "import qs.Commons as Commons",
      "Item {",
      "  property color c1: badFlag ? Commons.Color.accent : otherBad",
      "  property int bad: mysteryValue",
      "}",
      "",
    ].join("\n"));

    const brokenResult = check([broken]);
    expect(brokenResult.failures).toHaveLength(3);
    expect(brokenResult.failures.every((line) => line.endsWith("[unqualified]"))).toBe(true);
    expect(brokenResult.failures.some((line) => line.includes(":5:22:"))).toBe(true);
    expect(brokenResult.failures.some((line) => line.includes(":5:55:"))).toBe(true);
    expect(brokenResult.failures.some((line) => line.includes(":6:21:"))).toBe(true);

    // An unqualified access early in our real panel also fails the check.
    const brokenPanel = join(scratch, "Panel.qml");
    writeFileSync(brokenPanel, panel().replace("property int interval: 60", "property int interval: mysteryValue"));
    const panelResult = check([brokenPanel]);
    expect(panelResult.failures).toHaveLength(1);
    expect(panelResult.failures[0]).toContain("[unqualified]");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

function blockContaining(source: string, headerPattern: RegExp, innerNeedle: string): string | null {
  const regex = new RegExp(headerPattern.source, headerPattern.flags.includes("g") ? headerPattern.flags : `${headerPattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    const open = source.indexOf("{", match.index);
    if (open === -1) continue;
    const body = delegateBody(source, open);
    if (body.includes(innerNeedle)) return body;
  }
  return null;
}

test("cancel handler for Remove? sits inside the scrolling content and clears on focus loss", () => {
  const source = panel();

  const scrollerBody = blockContaining(source, /Flickable\s*\{/, "id: scroller");
  expect(scrollerBody).not.toBeNull();
  const backdropPos = scrollerBody!.search(/\bid:\s*contentBackdrop\b/);
  const contentPos = scrollerBody!.search(/\bid:\s*content\b/);
  expect(backdropPos).toBeGreaterThan(-1);
  expect(contentPos).toBeGreaterThan(-1);
  expect(backdropPos).toBeLessThan(contentPos);

  const backdropBody = blockContaining(scrollerBody!, /MouseArea\s*\{/, "id: contentBackdrop");
  expect(backdropBody).not.toBeNull();
  expect(backdropBody!).toContain("width: scroller.width");
  expect(backdropBody!).toContain("height: Math.max(scroller.height, content.implicitHeight)");
  expect(backdropBody!).toContain('onClicked: root.confirmRemoveAuthor = ""');

  const ringButtonBody = blockContaining(source, /component\s+RingButton\s*:\s*Item\s*\{/, "id: host");
  expect(ringButtonBody).not.toBeNull();
  expect(ringButtonBody!).toContain("property bool keepsRemoveConfirm: false");
  expect(ringButtonBody!).toContain("signal focusLost()");
  expect(ringButtonBody!).toContain('if (!host.keepsRemoveConfirm) root.confirmRemoveAuthor = ""');
  expect(ringButtonBody!).toContain("else host.focusLost()");

  const disabledArea = blockContaining(ringButtonBody!, /MouseArea\s*\{/, "enabled: !host.available");
  expect(disabledArea).not.toBeNull();
  expect(disabledArea!).toContain('onClicked: if (!host.keepsRemoveConfirm) root.confirmRemoveAuthor = ""');

  const customActionsBody = blockContaining(source, /Row\s*\{/, "id: customActions");
  expect(customActionsBody).not.toBeNull();
  expect(customActionsBody!).toContain("visible: authorRow.modelData.custom === true");
  const removeButtonBody = blockContaining(customActionsBody!, /RingButton\s*\{/, "requestRemoveAuthor");
  expect(removeButtonBody).not.toBeNull();
  expect(removeButtonBody!).toContain("keepsRemoveConfirm: true");
  expect(removeButtonBody!).toContain('onFocusLost: if (root.confirmRemoveAuthor === authorRow.modelData.slug) root.confirmRemoveAuthor = ""');

  const escapeBody = blockContaining(source, /Keys\.onEscapePressed\s*:\s*\{/, "root.dismiss()");
  expect(escapeBody).not.toBeNull();
  expect(escapeBody!).toContain('if (root.confirmRemoveAuthor !== "")');
  expect(escapeBody!).toContain('root.confirmRemoveAuthor = ""');
});

function qmlTestRunner(): string | null {
  const onPath = Bun.which("qmltestrunner");
  if (onPath) return onPath;
  return existsSync("/usr/lib/qt6/bin/qmltestrunner") ? "/usr/lib/qt6/bin/qmltestrunner" : null;
}

test("clicking blank space inside scroller, controls, or another row cancels Remove? while second press removes", () => {
  const runner = qmlTestRunner();
  if (!runner) {
    console.log("skipping Qt Quick Remove? interaction test: qmltestrunner is not installed");
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "omastoic-qmltest-"));
  try {
    const write = (rel: string, content: string) => {
      const full = join(scratch, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    };

    write("MockQuickshell/qmldir", "module MockQuickshell\nPlaceholder 1.0 Placeholder.qml\n");
    write("MockQuickshell/Placeholder.qml", "import QtQuick\nQtObject {}\n");

    write("MockQuickshell/Io/qmldir", "module MockQuickshell.Io\nProcess 1.0 Process.qml\nStdioCollector 1.0 StdioCollector.qml\n");
    write(
      "MockQuickshell/Io/Process.qml",
      `import QtQuick
Item {
  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property QtObject stdout: null
  property QtObject stderr: null
  signal exited(int exitCode)
}
`,
    );
    write(
      "MockQuickshell/Io/StdioCollector.qml",
      `import QtQuick
QtObject {
  property bool waitForEnd: true
  property string text: ""
  signal streamFinished()
}
`,
    );

    write("MockQuickshell/Wayland/qmldir", "module MockQuickshell.Wayland\nPanelWindow 1.0 PanelWindow.qml\n");
    write(
      "MockQuickshell/Wayland/PanelWindow.qml",
      `import QtQuick
Item {
  property color color: "transparent"
  property int exclusionMode: 0
}
`,
    );

    write("MockCommons/qmldir", "module MockCommons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\n");
    write(
      "MockCommons/Style.qml",
      `pragma Singleton
import QtQuick
QtObject {
  property real cornerRadius: 6
  property var font: ({ family: "sans-serif", body: 14, bodySmall: 12, heading: 18 })
  property var spacing: ({ popupPadding: 14 })
  function space(n) { return n }
}
`,
    );
    write(
      "MockCommons/Color.qml",
      `pragma Singleton
import QtQuick
QtObject {
  property color accent: "#7aa2f7"
  property color urgent: "#f7768e"
  property var menu: ({ scrim: "#80000000" })
  property var popups: ({ background: "#1a1b26", border: "#414868", text: "#c0caf5" })
}
`,
    );

    write(
      "MockUi/qmldir",
      "module MockUi\nButton 1.0 Button.qml\nTextField 1.0 TextField.qml\nNumberField 1.0 NumberField.qml\nPanelSeparator 1.0 PanelSeparator.qml\nPanelSectionHeader 1.0 PanelSectionHeader.qml\n",
    );
    write(
      "MockUi/Button.qml",
      `import QtQuick
Item {
  id: root
  property string text: ""
  property bool selected: false
  property bool focusable: true
  property bool bordered: true
  property color foreground: "white"
  property color accent: "#7aa2f7"
  signal clicked()
  signal rightClicked()
  implicitWidth: 80
  implicitHeight: 32
  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: function(mouse) {
      if (root.focusable) root.forceActiveFocus()
      if (mouse.button === Qt.RightButton) root.rightClicked()
      else root.clicked()
    }
  }
}
`,
    );
    write(
      "MockUi/TextField.qml",
      `import QtQuick
import QtQuick.Controls as QQC
QQC.TextField {
  property color foreground: "white"
  implicitWidth: 200
  implicitHeight: 32
}
`,
    );
    write(
      "MockUi/NumberField.qml",
      `import QtQuick
Item {
  property string label: ""
  property int value: 60
  property int from: 5
  property int to: 3600
  property int stepSize: 5
  property color foreground: "white"
  property QtObject field: QtObject { property int value: 60; property bool activeFocus: false; property QtObject contentItem: QtObject { property string text: "60" } }
  signal modified(int value)
  implicitWidth: 80
  implicitHeight: 32
}
`,
    );
    write("MockUi/PanelSeparator.qml", 'import QtQuick\nRectangle { property color foreground: "white"; width: parent ? parent.width : 100; height: 1 }\n');
    write("MockUi/PanelSectionHeader.qml", 'import QtQuick\nText { property color foreground: "white"; width: parent ? parent.width : 100 }\n');

    // Adapt only module imports and Quickshell Window attached flags while keeping layout & interaction code verbatim.
    const testPanelSource = panel()
      .replace(/^import Quickshell\.Io$/gm, "import MockQuickshell.Io")
      .replace(/^import Quickshell\.Wayland$/gm, "import MockQuickshell.Wayland")
      .replace(/^import Quickshell$/gm, "import MockQuickshell")
      .replace(/^import qs\.Commons as Commons$/gm, "import MockCommons as Commons")
      .replace(/^import qs\.Commons$/gm, "import MockCommons")
      .replace(/^import qs\.Ui$/gm, "import MockUi")
      .replace(/anchors\s*\{\s*top:\s*true;\s*bottom:\s*true;\s*left:\s*true;\s*right:\s*true\s*\}/, "anchors.fill: parent")
      .replace(/^\s*exclusionMode:.*$/gm, "")
      .replace(/^\s*WlrLayershell\..*$/gm, "");
    write("PanelUnderTest.qml", testPanelSource);

    write(
      "tst_panel.qml",
      `import QtQuick
import QtTest
import MockCommons as Commons

Item {
  id: harness
  width: 1280
  height: 800

  PanelUnderTest {
    id: panel
    anchors.fill: parent
  }

  TestCase {
    name: "RemoveConfirmCancellation"
    when: windowShown

    function findAll(node, pred, out) {
      if (!out) out = []
      if (!node) return out
      if (pred(node)) out.push(node)
      var kids = node.children || []
      for (var i = 0; i < kids.length; i++) findAll(kids[i], pred, out)
      return out
    }

    function findOne(node, pred) {
      var list = findAll(node, pred)
      return list.length > 0 ? list[0] : null
    }

    function seedPanel() {
      panel.opened = true
      panel.saving = false
      panel.notice = ""
      panel.pendingApplyNotice = ""
      panel.rotationNotice = ""
      panel.error = ""
      panel.errorScope = ""
      panel.closeAuthorForm()
      panel.closeQuoteForm()
      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      if (scroller) scroller.contentY = 0
      var ok = panel.adoptState(JSON.stringify({
        settings: { authors: ["marcus", "musonius", "hierocles"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "121–180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "musonius", name: "Musonius Rufus", dates: "c. 30–100", custom: true, portrait: "⣿", citation: "VI", text: "Train." },
          { slug: "hierocles", name: "Hierocles", dates: "", custom: true, portrait: "⣿", citation: "Elem", text: "Circles." },
        ],
      }))
      compare(ok, true)
      waitForRendering(panel)
    }

    function removeButtons() {
      return findAll(panel, function(item) {
        return item.hasOwnProperty("keepsRemoveConfirm") && item.keepsRemoveConfirm === true && item.visible
      })
    }

    function test_remove_confirm_cancels_everywhere_outside_and_second_press_removes() {
      seedPanel()

      // Only the 2 custom authors have visible Remove buttons; bundled marcus does not.
      var allRemoveBtns = findAll(panel, function(item) {
        return item.hasOwnProperty("keepsRemoveConfirm") && item.keepsRemoveConfirm === true
      })
      compare(allRemoveBtns.length, 3)
      var removes = removeButtons()
      compare(removes.length, 2)

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)

      var musoniusRemove = removes[0]
      var hieroclesRemove = removes[1]

      // 1. First click arms musonius without removing.
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      compare(musoniusRemove.label, "Remove?")
      compare(panel.saving, false)

      // 2. Clicking blank space or non-interactive header INSIDE the scrolling card cancels Remove?.
      mouseClick(scroller, 20, 20)
      compare(panel.confirmRemoveAuthor, "")
      compare(musoniusRemove.label, "Remove")

      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      mouseClick(scroller, scroller.width - 10, scroller.height - 10)
      compare(panel.confirmRemoveAuthor, "")

      // 3. Clicking blank space after Flickable scrolls AND clicking a TextField or disabled RingButton both cancel Remove?.
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorBtn !== null)
      mouseClick(addAuthorBtn)
      waitForRendering(panel)
      if (scroller.contentHeight > scroller.height) scroller.contentY = Math.min(40, scroller.contentHeight - scroller.height)
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      mouseClick(scroller, scroller.width - 12, 20)
      compare(panel.confirmRemoveAuthor, "")

      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      var nameField = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      verify(nameField !== null)
      mouseClick(nameField)
      compare(panel.confirmRemoveAuthor, "")

      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      panel.notice = "Saving…"
      wait(0)
      var disabledAddAuthor = findOne(panel, function(item) { return item.label === "Add author" && item.visible && !item.available })
      verify(disabledAddAuthor !== null)
      panel.reveal(disabledAddAuthor)
      waitForRendering(panel)
      mouseClick(disabledAddAuthor)
      compare(panel.opened, true)
      compare(panel.confirmRemoveAuthor, "")
      panel.notice = ""
      wait(0)

      var cancelAddBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelAddBtn !== null)
      panel.reveal(cancelAddBtn)
      wait(20)
      mouseClick(cancelAddBtn)
      scroller.contentY = 0
      wait(20)

      // 4. Clicking Edit cancels Remove?.
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      var editButtons = findAll(panel, function(item) { return item.label === "Edit" && item.visible })
      compare(editButtons.length, 2)
      mouseClick(editButtons[0])
      compare(panel.confirmRemoveAuthor, "")
      var cancelEditBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelEditBtn !== null)
      panel.reveal(cancelEditBtn)
      waitForRendering(panel)
      mouseClick(cancelEditBtn)
      compare(panel.opened, true)
      scroller.contentY = 0
      waitForRendering(panel)

      // 5. Clicking another author row (marcus) cancels Remove?.
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      var marcusRow = findOne(panel, function(item) { return item.Accessible && item.Accessible.name === "Marcus Aurelius" })
      verify(marcusRow !== null)
      mouseClick(marcusRow, 20, marcusRow.height / 2)
      compare(panel.confirmRemoveAuthor, "")

      // Reset any pending debounced apply so we cleanly observe the second-press remove commit.
      panel.saving = false
      panel.notice = ""

      // 6. Clicking a different custom author's Remove switches confirm to that author instead of removing.
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      mouseClick(hieroclesRemove)
      compare(panel.confirmRemoveAuthor, "hierocles")

      // 7. Escape cancels Remove? without closing the panel and clears focus from Remove.
      var hieroclesInner = findOne(hieroclesRemove, function(item) { return item.hasOwnProperty("focusable") })
      verify(hieroclesInner !== null)
      compare(hieroclesInner.activeFocus, true)
      keyClick(Qt.Key_Escape)
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.opened, true)
      compare(hieroclesInner.activeFocus, false)

      // 8. Second click on the same armed Remove? button commits removal.
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      compare(panel.saving, false)
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.saving, true)
    }

    function test_form_error_placement_clears_on_close_and_empty_pick_hint_visible() {
      seedPanel()
      wait(0)

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)

      // Open Add author and simulate a failed submit ("already exists").
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorBtn !== null)
      mouseClick(addAuthorBtn)
      waitForRendering(panel)

      panel.addingAuthor = true
      panel.saving = true
      var applyRunObj = {
        exited: true,
        exitCode: 1,
        stdout: "",
        stderr: 'omastoic: "musonius" already exists. Use Edit on that author to update it.',
        streamsLeft: 0,
      }
      panel.settleRun(applyRunObj, "Could not save that.")
      waitForRendering(panel)

      compare(panel.error, '"musonius" already exists. Use Edit on that author to update it.')
      compare(panel.errorScope, "author")
      compare(panel.statusText, "")

      // Error renders inside the pinned author footer, directly above the submit button, and stays visible inside the card.
      var card = findOne(panel, function(item) { return item.objectName === "panelCard" })
      var footer = findOne(panel, function(item) { return item.objectName === "authorFooter" && item.visible })
      var authorErr = findOne(panel, function(item) {
        return item.text === panel.error && item.visible
      })
      var submitBtn = findOne(panel, function(item) { return item.label === "Add author" && item.visible })
      verify(card !== null && footer !== null && authorErr !== null && submitBtn !== null)
      var errInCard = authorErr.mapToItem(card, 0, 0)
      var submitInCard = submitBtn.mapToItem(card, 0, 0)
      verify(errInCard.y < submitInCard.y)
      verify(errInCard.y >= scroller.y + scroller.height - 1)
      verify(submitInCard.y + submitBtn.height <= card.height + 1)

      // Cancel the form: no error remains; opening Edit on another author shows no error.
      var cancelAddBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelAddBtn !== null)
      panel.reveal(cancelAddBtn)
      wait(20)
      mouseClick(cancelAddBtn)
      wait(20)
      compare(panel.error, "")
      compare(panel.errorScope, "")
      compare(authorErr.visible, false)

      var editButtons = findAll(panel, function(item) { return item.label === "Edit" && item.visible })
      verify(editButtons.length >= 1)
      mouseClick(editButtons[0])
      waitForRendering(panel)
      compare(panel.error, "")
      compare(authorErr.visible, false)

      var cancelBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelBtn !== null)
      mouseClick(cancelBtn)
      waitForRendering(panel)

      // Unticking the last selected author shows the empty-pick hint fully inside the 1280x800 viewport.
      scroller.contentY = 0
      panel.selectedAuthors = ["marcus"]
      panel.toggleAuthor("marcus")
      waitForRendering(panel)
      compare(panel.authorListHint, "Pick at least one author.")
      var hintItem = findOne(panel, function(item) {
        return item.text === "Pick at least one author." && item.visible
      })
      verify(hintItem !== null)
      var hintInViewport = hintItem.mapToItem(scroller, 0, 0)
      verify(hintInViewport.y >= 0)
      verify(hintInViewport.y + hintItem.height <= scroller.height)
    }

    function test_layout_stability_scroll_restore_and_urgent_remove_confirm() {
      panel.opened = true
      panel.closeAuthorForm()
      panel.closeQuoteForm()
      var ok = panel.adoptState(JSON.stringify({
        settings: { authors: ["marcus", "musonius", "hierocles"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "II.1", text: "Begin." },
          {
            slug: "musonius",
            name: "Musonius Rufus",
            dates: "c. AD 30 – 100",
            custom: true,
            portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿",
            citation: "Lectures VI: A Very Long Citation That Used To Wrap Onto A Second Line And Shift Every Row Below It",
            text: "A much longer four-line or five-line quotation that exceeds three lines in the narrow preview header column and used to push the list down whenever the preview switched to this author.",
          },
          { slug: "hierocles", name: "Hierocles", dates: "", custom: true, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Elements", text: "Draw the circles inward." },
        ],
      }))
      compare(ok, true)
      waitForRendering(panel)

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)

      var marcusRow = findOne(panel, function(item) { return item.Accessible && item.Accessible.name === "Marcus Aurelius" })
      var musoniusRow = findOne(panel, function(item) { return item.Accessible && item.Accessible.name === "Musonius Rufus" })
      var hieroclesRow = findOne(panel, function(item) { return item.Accessible && item.Accessible.name === "Hierocles" })
      verify(marcusRow !== null && musoniusRow !== null && hieroclesRow !== null)

      var marcusY0 = marcusRow.mapToItem(scroller, 0, 0).y
      var musoniusY0 = musoniusRow.mapToItem(scroller, 0, 0).y
      var hieroclesY0 = hieroclesRow.mapToItem(scroller, 0, 0).y

      // 1. Toggling Marcus off switches the header preview to Musonius's long quote + long citation; rows do not shift.
      mouseClick(marcusRow, 20, marcusRow.height / 2)
      wait(0)
      verify(Math.abs(marcusRow.mapToItem(scroller, 0, 0).y - marcusY0) <= 1)
      verify(Math.abs(musoniusRow.mapToItem(scroller, 0, 0).y - musoniusY0) <= 1)
      verify(Math.abs(hieroclesRow.mapToItem(scroller, 0, 0).y - hieroclesY0) <= 1)

      // Toggling Musonius off switches to Hierocles (short quote); rows still do not shift.
      mouseClick(musoniusRow, 20, musoniusRow.height / 2)
      wait(0)
      verify(Math.abs(marcusRow.mapToItem(scroller, 0, 0).y - marcusY0) <= 1)
      verify(Math.abs(musoniusRow.mapToItem(scroller, 0, 0).y - musoniusY0) <= 1)
      verify(Math.abs(hieroclesRow.mapToItem(scroller, 0, 0).y - hieroclesY0) <= 1)

      // Unticking the last author shows the hint without moving any row.
      mouseClick(hieroclesRow, 20, hieroclesRow.height / 2)
      wait(0)
      compare(panel.authorListHint, "Pick at least one author.")
      verify(Math.abs(marcusRow.mapToItem(scroller, 0, 0).y - marcusY0) <= 1)
      verify(Math.abs(musoniusRow.mapToItem(scroller, 0, 0).y - musoniusY0) <= 1)

      // 2. Remove -> Remove? keeps the same width and leaves Edit at the exact same x position, with urgent styling.
      var editBtn = findOne(musoniusRow, function(item) { return item.label === "Edit" && item.visible })
      var removeBtn = findOne(musoniusRow, function(item) { return item.keepsRemoveConfirm === true && item.visible })
      verify(editBtn !== null && removeBtn !== null)
      var editXBefore = editBtn.mapToItem(musoniusRow, 0, 0).x
      var removeWidthBefore = removeBtn.width
      compare(removeBtn.destructive, false)

      mouseClick(removeBtn)
      wait(0)
      compare(removeBtn.label, "Remove?")
      compare(removeBtn.destructive, true)
      compare(removeBtn.width, removeWidthBefore)
      compare(editBtn.mapToItem(musoniusRow, 0, 0).x, editXBefore)

      var chrome = findOne(removeBtn, function(item) { return item.border && item.border.width === 2 })
      verify(chrome !== null)
      compare(String(chrome.border.color), "#f7768e")

      // Catppuccin Latte (light theme) uses the light theme's urgent colour (#d20f39) on Remove? border, fill, and inner accent.
      var savedAccent = Commons.Color.accent
      var savedUrgent = Commons.Color.urgent
      var savedPopups = Commons.Color.popups
      Commons.Color.accent = "#1e66f5"
      Commons.Color.urgent = "#d20f39"
      Commons.Color.popups = { background: "#eff1f5", border: "#bcc0cc", text: "#4c4f69" }
      wait(20)
      compare(String(chrome.border.color), "#d20f39")
      compare(chrome.border.width, 2)
      verify(Math.abs(chrome.color.r - Commons.Color.urgent.r) < 0.01)
      verify(Math.abs(chrome.color.g - Commons.Color.urgent.g) < 0.01)
      verify(Math.abs(chrome.color.b - Commons.Color.urgent.b) < 0.01)
      verify(Math.abs(chrome.color.a - 0.20) < 0.01)
      var removeInner = findOne(removeBtn, function(item) { return item.hasOwnProperty("focusable") })
      verify(removeInner !== null)
      compare(String(removeInner.accent), "#d20f39")
      Commons.Color.accent = savedAccent
      Commons.Color.urgent = savedUrgent
      Commons.Color.popups = savedPopups
      wait(20)

      // 3. Opening Edit and pressing Cancel restores contentY so the row stays under the pointer.
      scroller.contentY = 0
      wait(0)
      var rowYBeforeEdit = musoniusRow.mapToItem(scroller, 0, 0).y
      mouseClick(editBtn)
      wait(20)
      var cancelBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelBtn !== null)
      panel.reveal(cancelBtn)
      wait(20)
      mouseClick(cancelBtn)
      wait(20)
      compare(panel.authorOpen, false)
      compare(scroller.contentY, 0)
      compare(musoniusRow.mapToItem(scroller, 0, 0).y, rowYBeforeEdit)
    }

    function test_author_forms_wording_advanced_slug_plain_count_and_multiline_quote() {
      panel.opened = true
      panel.closeAuthorForm()
      panel.closeQuoteForm()
      var ok = panel.adoptState(JSON.stringify({
        settings: { authors: ["marcus", "musonius"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [
          { id: "c01", author: "marcus", name: "Marcus Aurelius", citation: "Desk note", text: "One line." },
          { id: "c02", author: "musonius", name: "Musonius Rufus", citation: "Lectures VI", text: "Two lines." },
        ],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "musonius", name: "Musonius Rufus", dates: "c. AD 30 – 100", custom: true, portrait: "⣿", citation: "VI", text: "Train." },
        ],
      }))
      compare(ok, true)
      wait(20)

      // 1. Custom count reads as plain secondary text (not a bordered RingButton).
      var countLabel = findOne(panel, function(item) {
        return item.text === "▸ 2 custom quotes" && item.visible
      })
      verify(countLabel !== null)
      compare(countLabel.parent.border.width, 0)
      compare(findOne(panel, function(item) { return item.label === "2 of your own" }), null)

      // 2. Edit form uses Edit <name> + Save changes + Cancel.
      var editBtn = findOne(panel, function(item) { return item.label === "Edit" && item.visible })
      verify(editBtn !== null)
      mouseClick(editBtn)
      wait(20)
      verify(findOne(panel, function(item) { return item.text === "Edit Musonius Rufus" && item.visible }) !== null)
      verify(findOne(panel, function(item) { return item.label === "Save changes" && item.visible }) !== null)
      verify(findOne(panel, function(item) { return item.label === "Cancel" && item.visible }) !== null)
      compare(findOne(panel, function(item) { return item.label === "Replace author" }), null)
      compare(findOne(panel, function(item) { return item.label === "Close" && item.visible }), null)

      var cancelEdit = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      panel.reveal(cancelEdit)
      wait(20)
      mouseClick(cancelEdit)
      wait(20)
      compare(panel.authorOpen, false)

      // 3. Add an author keeps its own label, hides slug under Advanced, derives slug from Name, and shows Cancel.
      var addAuthorTrigger = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorTrigger !== null)
      mouseClick(addAuthorTrigger)
      wait(20)
      compare(addAuthorTrigger.label, "Add an author")
      compare(findOne(panel, function(item) { return item.label === "Close" && item.visible }), null)
      verify(findOne(panel, function(item) { return item.label === "Add author" && item.visible }) !== null)
      verify(findOne(panel, function(item) { return item.label === "Cancel" && item.visible }) !== null)

      // Author id field is hidden until Advanced is opened.
      var slugField = findOne(panel, function(item) { return item.objectName === "authorSlugField" })
      verify(slugField !== null)
      compare(slugField.visible, false)

      // Fill Name, Image, Citation, and a 300-character Quote without opening Advanced.
      var nameField = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      var imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      var citationField = findOne(panel, function(item) { return item.objectName === "authorCitationField" && item.visible })
      var quoteArea = findOne(panel, function(item) { return item.hasOwnProperty("viewportHeight") && item.visible })
      verify(nameField !== null && imageField !== null && citationField !== null && quoteArea !== null)

      nameField.text = "John Locke"
      compare(panel.newAuthorSlug, "john-locke")
      imageField.text = "/tmp/locke.png"
      citationField.text = "An Essay Concerning Human Understanding"
      var quote300 = "Reading furnishes the mind only with materials of knowledge; it is thinking makes what we read ours. We are of the ruminating kind, and it is not enough to cram ourselves with a great load of collections; unless we chew them over again, they will not give us strength and nourishment for our daily work."
      verify(quote300.length >= 300)
      quoteArea.text = quote300
      wait(20)

      // 300-character quote fits completely inside the multiline QuoteArea without clipping.
      verify(quoteArea.contentHeight <= quoteArea.viewportHeight + 1)
      compare(panel.authorReady, true)

      // Tab moves focus out of QuoteArea without inserting a tab character.
      quoteArea.takeFocus()
      wait(10)
      compare(quoteArea.editFocused, true)
      keyClick(Qt.Key_Tab)
      wait(10)
      compare(quoteArea.editFocused, false)
      compare(quoteArea.text.indexOf("\t"), -1)

      // Ctrl+Return submits the form with the derived slug without opening Advanced.
      quoteArea.takeFocus()
      wait(10)
      keyClick(Qt.Key_Return, Qt.ControlModifier)
      wait(10)
      compare(panel.saving, true)
      compare(panel.addingAuthor, true)
      panel.saving = false
      panel.addingAuthor = false
      panel.notice = ""

      // Opening Advanced reveals the editable Author id field with the derived slug.
      var advToggle = findOne(panel, function(item) { return item.text === "▸ Advanced" && item.visible })
      verify(advToggle !== null)
      panel.reveal(advToggle)
      wait(20)
      mouseClick(advToggle)
      wait(20)
      compare(panel.authorAdvancedOpen, true)
      compare(slugField.visible, true)
      compare(slugField.text, "john-locke")
    }

    function test_review_fixes_cancel_mid_save_scrolled_hint_error_reveal_and_id_collision() {
      panel.opened = true
      panel.closeAuthorForm()
      panel.closeQuoteForm()
      var ok = panel.adoptState(JSON.stringify({
        settings: { authors: ["chrysippus"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Letters 1", text: "Claim yourself." },
          { slug: "epictetus", name: "Epictetus", dates: "c. AD 50 – 135", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Enchiridion 1", text: "Some things are in our control." },
          { slug: "zeno", name: "Zeno of Citium", dates: "c. 334 – 262 BC", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Frag", text: "Well-being is realized by small steps." },
          { slug: "cleanthes", name: "Cleanthes", dates: "c. 330 – 230 BC", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Hymn", text: "Lead me, Zeus." },
          { slug: "chrysippus", name: "Chrysippus", dates: "c. 279 – 206 BC", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Frag", text: "Live in agreement." },
        ],
      }))
      compare(ok, true)
      wait(20)

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)

      // #112: Cancelling an author form mid-save still displays a subsequent CLI failure in the visible status line.
      panel.openAddAuthor()
      wait(20)
      panel.addingAuthor = true
      panel.saving = true
      panel.closeAuthorForm()
      wait(20)
      panel.settleRun({
        exited: true,
        exitCode: 1,
        stdout: "",
        stderr: "omastoic: portrait image could not be read",
        streamsLeft: 0,
      }, "Could not save that.")
      wait(20)
      compare(panel.error, "Portrait image could not be read")
      compare(panel.errorScope, "")
      compare(panel.statusText, "Portrait image could not be read")
      var visibleErr = findOne(panel, function(item) {
        return item.text === "Portrait image could not be read" && item.visible
      })
      verify(visibleErr !== null)

      // #115 & #122: Bundled author id collision capitalizes the panel error and automatically expands Advanced.
      panel.openAddAuthor()
      wait(20)
      compare(panel.authorAdvancedOpen, false)
      var nameField = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      verify(nameField !== null)
      nameField.text = "Seneca"
      compare(panel.newAuthorSlug, "seneca")
      panel.addingAuthor = true
      panel.saving = true
      panel.settleRun({
        exited: true,
        exitCode: 1,
        stdout: "",
        stderr: 'omastoic: author "seneca" is already a bundled author',
        streamsLeft: 0,
      }, "Could not save that.")
      wait(20)
      compare(panel.error, 'Author "seneca" is already a bundled author')
      compare(panel.authorAdvancedOpen, true)
      var slugField = findOne(panel, function(item) { return item.objectName === "authorSlugField" && item.visible })
      verify(slugField !== null)

      // #114 (author form): Triggering an author form error keeps BOTH error and submit button inside the pinned footer within panelCard.
      var card = findOne(panel, function(item) { return item.objectName === "panelCard" })
      var submitBtn = findOne(panel, function(item) { return item.label === "Add author" && item.visible })
      verify(card !== null && submitBtn !== null)
      panel.error = ""
      panel.errorScope = ""
      wait(20)
      panel.submitAuthor()
      wait(20)
      var authorErr = findOne(panel, function(item) { return item.text === panel.error && item.visible })
      verify(authorErr !== null)
      var errInCard = authorErr.mapToItem(card, 0, 0)
      var submitInCard = submitBtn.mapToItem(card, 0, 0)
      verify(errInCard.y >= scroller.y + scroller.height - 1 && errInCard.y + authorErr.height <= card.height + 1)
      verify(submitInCard.y >= scroller.y + scroller.height - 1 && submitInCard.y + submitBtn.height <= card.height + 1)

      panel.closeAuthorForm()
      wait(20)

      // #114 (quote form): Triggering a quote form error with Add quote at the bottom edge keeps BOTH error and submit button inside the viewport.
      panel.toggleQuoteForm()
      wait(20)
      var quoteSubmitBtn = findOne(panel, function(item) { return item.label === "Add quote" && item.visible })
      verify(quoteSubmitBtn !== null)
      panel.error = ""
      panel.errorScope = ""
      wait(20)
      var quoteSubmitBottom = quoteSubmitBtn.mapToItem(scroller.contentItem, 0, 0).y + quoteSubmitBtn.height
      scroller.contentY = Math.max(0, quoteSubmitBottom - scroller.height)
      wait(20)
      panel.addQuote()
      wait(20)
      var quoteErr = findOne(panel, function(item) { return item.text === panel.error && item.visible })
      verify(quoteErr !== null)
      var quoteErrInView = quoteErr.mapToItem(scroller, 0, 0)
      var quoteSubmitInView = quoteSubmitBtn.mapToItem(scroller, 0, 0)
      verify(quoteErrInView.y >= -1 && quoteErrInView.y + quoteErr.height <= scroller.height + 1)
      verify(quoteSubmitInView.y >= -1 && quoteSubmitInView.y + quoteSubmitBtn.height <= scroller.height + 1)

      // #113: Unticking the last selected author while a form is open scrolls the empty-pick hint into view.
      panel.toggleAuthor("chrysippus")
      wait(20)
      compare(panel.authorListHint, "Pick at least one author.")
      var hintItem = findOne(panel, function(item) {
        return item.text === "Pick at least one author." && item.visible
      })
      verify(hintItem !== null)
      var hintInView = hintItem.mapToItem(scroller, 0, 0)
      verify(hintInView.y >= 0 && hintInView.y + hintItem.height <= scroller.height)

      // #118: A non-ASCII author name opens Advanced immediately and clicking Add author never dead-ends if Advanced is re-collapsed.
      panel.closeQuoteForm()
      panel.openAddAuthor()
      wait(20)
      var nonAsciiName = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      var nonAsciiImage = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      var nonAsciiCitation = findOne(panel, function(item) { return item.objectName === "authorCitationField" && item.visible })
      var nonAsciiQuote = findOne(panel, function(item) { return item.hasOwnProperty("viewportHeight") && item.visible })
      verify(nonAsciiName !== null && nonAsciiImage !== null && nonAsciiCitation !== null && nonAsciiQuote !== null)
      nonAsciiName.text = "Ἐπίκτητος"
      wait(20)
      compare(panel.newAuthorSlug, "")
      compare(panel.authorAdvancedOpen, true)
      nonAsciiImage.text = "/tmp/epictetus.png"
      nonAsciiCitation.text = "Enchiridion 1"
      nonAsciiQuote.text = "Some things are in our control."
      // Even if the user re-collapses Advanced, Add author remains clickable and re-opens Advanced with guidance.
      panel.authorAdvancedOpen = false
      wait(20)
      var addBtn = findOne(panel, function(item) { return item.label === "Add author" && item.visible })
      verify(addBtn !== null)
      compare(addBtn.available, true)
      panel.reveal(addBtn)
      wait(20)
      mouseClick(addBtn)
      wait(20)
      compare(panel.authorAdvancedOpen, true)
      compare(panel.errorScope, "author")
      verify(panel.error.indexOf("Author id") !== -1)
    }

    function test_opening_add_forms_scrolls_first_field_into_view_including_after_cancel() {
      panel.opened = true
      panel.closeAuthorForm()
      panel.closeQuoteForm()
      var ok = panel.adoptState(JSON.stringify({
        settings: { authors: ["marcus", "seneca", "epictetus", "zeno", "cleanthes", "chrysippus", "locke", "hume", "kant", "musonius"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Letters 1", text: "Claim yourself." },
          { slug: "epictetus", name: "Epictetus", dates: "c. AD 50 – 135", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Enchiridion 1", text: "Some things are in our control." },
          { slug: "zeno", name: "Zeno of Citium", dates: "c. 334 – 262 BC", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Frag", text: "Well-being is realized by small steps." },
          { slug: "cleanthes", name: "Cleanthes", dates: "c. 330 – 230 BC", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Hymn", text: "Lead me, Zeus." },
          { slug: "chrysippus", name: "Chrysippus", dates: "c. 279 – 206 BC", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Frag", text: "Live in agreement." },
          { slug: "locke", name: "John Locke", dates: "1632 – 1704", custom: true, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Essay I", text: "Reading furnishes the mind." },
          { slug: "hume", name: "David Hume", dates: "1711 – 1776", custom: true, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Treatise", text: "Custom is the great guide." },
          { slug: "kant", name: "Immanuel Kant", dates: "1724 – 1804", custom: true, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Critique", text: "Dare to know." },
          { slug: "musonius", name: "Musonius Rufus", dates: "c. AD 30 – 100", custom: true, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "Lectures VI", text: "Train." },
        ],
      }))
      compare(ok, true)
      wait(20)

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)

      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      var addQuoteBtn = findOne(panel, function(item) { return item.label === "Add your own quote" && item.visible })
      verify(addAuthorBtn !== null && addQuoteBtn !== null)

      // Scroll so Add an author / Add your own quote sit right at the bottom edge of the 1280x800 viewport.
      panel.reveal(addAuthorBtn)
      wait(20)

      // 1. Single click on Add an author brings Name field into view; Cancel then click again repeats reliably.
      for (var round = 0; round < 2; round++) {
        mouseClick(addAuthorBtn)
        wait(30)
        compare(panel.authorOpen, true)
        var nameField = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
        verify(nameField !== null)
        var namePos = nameField.mapToItem(scroller, 0, 0)
        verify(namePos.y >= -1 && namePos.y + nameField.height <= scroller.height + 1)

        var cancelAuthor = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
        verify(cancelAuthor !== null)
        mouseClick(cancelAuthor)
        wait(30)
        compare(panel.authorOpen, false)
      }

      // 2. Single click on Add your own quote (right after Cancel) brings Citation field into view; repeat after Cancel.
      for (var qround = 0; qround < 2; qround++) {
        mouseClick(addQuoteBtn)
        wait(30)
        compare(panel.quoteOpen, true)
        var citeField = findOne(panel, function(item) { return item.objectName === "quoteCitationField" && item.visible })
        verify(citeField !== null)
        var citePos = citeField.mapToItem(scroller, 0, 0)
        verify(citePos.y >= -1 && citePos.y + citeField.height <= scroller.height + 1)

        var cancelQuote = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
        verify(cancelQuote !== null)
        mouseClick(cancelQuote)
        wait(30)
        compare(panel.quoteOpen, false)
      }
    }

    function test_preview_button_right_aligned_with_and_without_portrait() {
      panel.opened = true
      panel.saving = false
      panel.notice = ""
      panel.closeAuthorForm()
      panel.closeQuoteForm()
      var ok = panel.adoptState(JSON.stringify({
        settings: { authors: ["marcus"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿\n⣿\n⣿\n⣿\n⣿\n⣿\n⣿", citation: "II.1", text: "Begin." },
          { slug: "noportrait", name: "No Portrait", dates: "", custom: true, portrait: "", citation: "Note 1", text: "Plain words." },
        ],
      }))
      compare(ok, true)
      wait(20)

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      var previewBtn = findOne(panel, function(item) { return item.label === "Preview" && item.visible })
      verify(scroller !== null && previewBtn !== null)

      // With portrait: Preview button aligns with the right edge of the header content.
      compare(panel.hasPortrait, true)
      var rightWithPortrait = previewBtn.mapToItem(scroller, 0, 0).x + previewBtn.width
      verify(Math.abs(rightWithPortrait - scroller.width) <= 1)

      // Without portrait: select only the portraitless author; Preview stays right-aligned at the exact same right edge.
      panel.selectedAuthors = ["noportrait"]
      wait(20)
      compare(panel.hasPortrait, false)
      var rightWithoutPortrait = previewBtn.mapToItem(scroller, 0, 0).x + previewBtn.width
      verify(Math.abs(rightWithoutPortrait - scroller.width) <= 1)
      verify(Math.abs(rightWithoutPortrait - rightWithPortrait) <= 1)
    }

    function findProcessFor(subcommand) {
      return findOne(panel, function(item) {
        return item.hasOwnProperty("command") && Array.isArray(item.command) && item.command.indexOf(subcommand) !== -1
      })
    }

    function completeProcess(proc, exitCode, stdoutText, stderrText, exitFirst) {
      proc.running = false
      if (exitFirst) {
        proc.exited(exitCode)
        proc.stdout.text = stdoutText
        proc.stdout.streamFinished()
        proc.stderr.text = stderrText
        proc.stderr.streamFinished()
      } else {
        proc.stdout.text = stdoutText
        proc.stdout.streamFinished()
        proc.stderr.text = stderrText
        proc.stderr.streamFinished()
        proc.exited(exitCode)
      }
    }

    function resetPanelState() {
      panel.close()
      panel.closeAuthorForm()
      panel.quoteOpen = false
      panel.listOpen = false
      panel.saving = false
      panel.addingAuthor = false
      panel.replacingAuthor = false
      panel.addingQuote = false
      panel.notice = ""
      panel.pendingApplyNotice = ""
      panel.rotationNotice = ""
      panel.error = ""
      panel.errorScope = ""
      panel.authorListHint = ""
      panel.hasFormReturnY = false
      panel.formReturnContentY = 0
      panel.pendingAuthor = null
      panel.pendingReplaceAuthor = null
      panel.pendingRemoveAuthor = ""
      panel.applyQueued = false
      var applyProc = findProcessFor("apply")
      if (applyProc) applyProc.running = false
      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      if (scroller) scroller.contentY = 0
      seedPanel()
    }

    function init() {
      resetPanelState()
    }

    function test_choose_image_works_for_add_replace_cancel_and_no_portal_fallback() {
      var panelWindow = findOne(panel, function(item) {
        return item.hasOwnProperty("exclusionMode")
      })
      verify(panelWindow !== null)
      compare(panelWindow.visible, true)

      // 1. Add form: Choose image button exists, hides overlay while picking, writes path (even when exited fires before streams), and submits via addAuthor.
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorBtn !== null)
      mouseClick(addAuthorBtn)
      waitForRendering(panel)

      var chooseBtn = findOne(panel, function(item) { return item.label === "Choose image" && item.visible })
      verify(chooseBtn !== null)
      compare(chooseBtn.available, true)

      var imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      verify(imageField !== null)
      verify(chooseBtn.x >= imageField.x + imageField.width)

      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      compare(panel.pickingImage, true)
      compare(panelWindow.visible, false)

      var pickProc = panel.activePickProcess
      verify(pickProc !== null)
      compare(pickProc.running, true)
      compare(pickProc.stdinEnabled, true)
      compare(pickProc.command[pickProc.command.length - 3], "panel")
      compare(pickProc.command[pickProc.command.length - 2], "pick-image")
      compare(pickProc.command[pickProc.command.length - 1], "--watch-stdin")

      // Clicking again while already picking is ignored and does not replace activePickProcess.
      panel.chooseAuthorImage()
      compare(panel.activePickProcess, pickProc)

      completeProcess(pickProc, 0, "/home/test/Pictures/Cleanthes Portrait.png\\n", "", true)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(imageField.text, "/home/test/Pictures/Cleanthes Portrait.png")
      compare(panel.newAuthorImage, "/home/test/Pictures/Cleanthes Portrait.png")
      compare(panel.error, "")
      wait(0)
      compare(imageField.activeFocus, true)

      // Fill remaining Add author fields and verify the picked path flows into panel apply addAuthor.
      var nameField = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      var citeField = findOne(panel, function(item) { return item.objectName === "authorCitationField" && item.visible })
      var quoteField = findOne(panel, function(item) { return item.objectName === "authorTextField" && item.visible })
      verify(nameField !== null && citeField !== null && quoteField !== null)
      nameField.text = "Posidonius"
      citeField.text = "Fragments 1"
      quoteField.text = "Live in study of the truth."
      compare(panel.authorReady, true)

      var submitAddBtn = findOne(panel, function(item) { return item.label === "Add author" && item.visible })
      verify(submitAddBtn !== null)
      panel.reveal(submitAddBtn)
      waitForRendering(panel)
      mouseClick(submitAddBtn)
      var applyProc = findProcessFor("apply")
      verify(applyProc !== null)
      var addPayload = JSON.parse(applyProc.command[applyProc.command.length - 1])
      compare(addPayload.addAuthor.slug, "posidonius")
      compare(addPayload.addAuthor.image, "/home/test/Pictures/Cleanthes Portrait.png")

      // 2. Cancelling the picker leaves field and pending state unchanged (empty, non-empty with existing notice, and edit form).
      resetPanelState()
      addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      mouseClick(addAuthorBtn)
      waitForRendering(panel)
      imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      chooseBtn = findOne(panel, function(item) { return item.label === "Choose image" && item.visible })

      // 2a. Empty field cancel
      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      verify(pickProc !== null)
      completeProcess(pickProc, 1, "", "", false)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(imageField.text, "")
      compare(panel.newAuthorImage, "")
      compare(panel.pendingAuthor, null)
      compare(panel.error, "")
      compare(panel.notice, "")

      // 2b. Non-empty field + pre-existing notice cancel
      imageField.text = "/existing/keep-me.jpg"
      panel.notice = "Keep existing notice."
      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      completeProcess(pickProc, 1, "", "", false)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(imageField.text, "/existing/keep-me.jpg")
      compare(panel.newAuthorImage, "/existing/keep-me.jpg")
      compare(panel.pendingAuthor, null)
      compare(panel.error, "")
      compare(panel.notice, "Keep existing notice.")

      // 3. No-portal fallback (exit 2): keeps typed path, shows short notice, reveals statusSlot, stays usable, clears when typing or closing form.
      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      completeProcess(pickProc, 2, "", "omastoic: portal file chooser failed\\n", false)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(imageField.text, "/existing/keep-me.jpg")
      compare(panel.newAuthorImage, "/existing/keep-me.jpg")
      compare(panel.error, "")
      compare(panel.notice, "Could not open the file picker. Type a path instead.")
      compare(chooseBtn.available, true)
      wait(0)
      compare(imageField.activeFocus, true)
      imageField.text = "/typed/fallback.png"
      compare(panel.notice, "")

      // 3b. Unsupported remote/non-local selection (exit 3) shows a distinct local-file notice, not the portal-unavailable notice.
      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      completeProcess(pickProc, 3, "", "omastoic: selected file is not a local path\\n", false)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(imageField.text, "/typed/fallback.png")
      compare(panel.error, "")
      compare(panel.notice, "Choose a JPEG or PNG saved on this computer.")
      imageField.text = "/typed/local.png"
      compare(panel.notice, "")

      // 3c. Process failing to start (running flips false without exited) recovers cleanly instead of staying hidden.
      mouseClick(chooseBtn)
      compare(panel.pickingImage, true)
      compare(panelWindow.visible, false)
      pickProc = panel.activePickProcess
      verify(pickProc !== null)
      pickProc.running = false
      wait(0)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(panel.notice, "Could not open the file picker. Type a path instead.")

      // Switching away to quote form clears pickerUnavailableNotice and closes authorForm cleanly.
      var addQuoteBtn = findOne(panel, function(item) { return item.label === "Add your own quote" && item.visible })
      verify(addQuoteBtn !== null)
      panel.reveal(addQuoteBtn)
      waitForRendering(panel)
      mouseClick(addQuoteBtn)
      compare(panel.authorOpen, false)
      compare(panel.notice, "")

      // 4. Replace/Edit form: cancel leaves state unchanged, accepted pick writes patch.image for replaceAuthor.
      resetPanelState()
      var editButtons = findAll(panel, function(item) { return item.label === "Edit" && item.visible })
      compare(editButtons.length, 2)
      mouseClick(editButtons[0])
      waitForRendering(panel)
      var replaceImageField = findOne(panel, function(item) { return item.placeholderText === "Leave empty to keep current portrait" && item.visible })
      chooseBtn = findOne(panel, function(item) { return item.label === "Choose image" && item.visible })
      verify(replaceImageField !== null && chooseBtn !== null)
      compare(panel.authorReady, false)

      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      completeProcess(pickProc, 1, "", "", false)
      compare(replaceImageField.text, "")
      compare(panel.authorReady, false)
      compare(panel.pendingReplaceAuthor, null)

      mouseClick(chooseBtn)
      compare(panel.pickingImage, true)
      pickProc = panel.activePickProcess
      completeProcess(pickProc, 0, "/home/test/Pictures/musonius-new.jpg\\n", "", false)
      compare(panel.pickingImage, false)
      compare(replaceImageField.text, "/home/test/Pictures/musonius-new.jpg")
      compare(panel.authorReady, true)

      var submitReplaceBtn = findOne(panel, function(item) { return item.label === "Save changes" && item.visible })
      verify(submitReplaceBtn !== null)
      panel.reveal(submitReplaceBtn)
      waitForRendering(panel)
      mouseClick(submitReplaceBtn)
      applyProc = findProcessFor("apply")
      verify(applyProc !== null)
      var replacePayload = JSON.parse(applyProc.command[applyProc.command.length - 1])
      compare(replacePayload.replaceAuthor.slug, "musonius")
      compare(replacePayload.replaceAuthor.image, "/home/test/Pictures/musonius-new.jpg")

      // 5. Closing while picking and starting a fresh pick isolates the two processes so stale signals cannot corrupt the new pick.
      resetPanelState()
      addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      mouseClick(addAuthorBtn)
      waitForRendering(panel)
      imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      chooseBtn = findOne(panel, function(item) { return item.label === "Choose image" && item.visible })
      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      var firstProc = panel.activePickProcess
      verify(firstProc !== null)
      compare(panel.pickingImage, true)
      panel.cancelImagePick()
      compare(panel.pickingImage, false)
      compare(firstProc.running, false)

      // Start second pick BEFORE stale firstProc emits exited/streamFinished.
      mouseClick(chooseBtn)
      var secondProc = panel.activePickProcess
      verify(secondProc !== null && secondProc !== firstProc)
      compare(panel.pickingImage, true)
      completeProcess(firstProc, 0, "/stale/first.png\\n", "", false)
      compare(panel.pickingImage, true)
      compare(panelWindow.visible, false)
      compare(imageField.text, "")

      // Now complete the second pick cleanly.
      completeProcess(secondProc, 0, "/fresh/second.png\\n", "", false)
      compare(panel.pickingImage, false)
      compare(panelWindow.visible, true)
      compare(imageField.text, "/fresh/second.png")

      // 6. Async Quickshell startup: cancelImagePick() while proc.running is still false does not destroy proc prematurely,
      //    and stops it immediately when proc.running transitions to true.
      mouseClick(chooseBtn)
      var asyncProc = panel.activePickProcess
      verify(asyncProc !== null)
      asyncProc.running = false
      panel.cancelImagePick()
      compare(panel.pickingImage, false)
      compare(asyncProc.cancelled, true)
      asyncProc.running = true
      compare(asyncProc.running, false)
    }

    function test_remove_last_selected_author_shows_notice_matches_rotation_and_keeps_untick_guard() {
      panel.opened = true
      panel.saving = false
      panel.notice = ""
      panel.pendingApplyNotice = ""
      panel.rotationNotice = ""
      panel.error = ""
      panel.errorScope = ""
      panel.closeAuthorForm()
      panel.closeQuoteForm()

      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)
      scroller.contentY = 0

      // Seed with ONLY the custom author hierocles selected.
      compare(panel.adoptState(JSON.stringify({
        settings: { authors: ["hierocles"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿", citation: "Letters 1", text: "Claim yourself." },
          { slug: "hierocles", name: "Hierocles", dates: "", custom: true, portrait: "⣿", citation: "Elements", text: "Circles." },
        ],
      })), true)
      wait(20)
      compare(panel.selectedAuthors.join(","), "hierocles")
      compare(panel.preview.slug, "hierocles")

      // Click Remove -> Remove? on Hierocles.
      var removes = removeButtons()
      compare(removes.length, 1)
      mouseClick(removes[0])
      compare(panel.confirmRemoveAuthor, "hierocles")
      mouseClick(removes[0])
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.saving, true)

      var applyProc = findProcessFor("apply")
      verify(applyProc !== null)
      var removePayload = JSON.parse(applyProc.command[applyProc.command.length - 1])
      compare(removePayload.removeAuthor, "hierocles")
      compare(removePayload.authors, undefined)

      // Settle with explicit fallback rotation to Marcus Aurelius and clear notice.
      var fallbackNotice = "Removed Hierocles. Rotation is now Marcus Aurelius."
      completeProcess(applyProc, 0, JSON.stringify({
        settings: { authors: ["marcus"], interval: 60 },
        notice: fallbackNotice,
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿", citation: "Letters 1", text: "Claim yourself." },
        ],
      }), "", false)
      wait(20)

      compare(panel.saving, false)
      compare(panel.selectedAuthors.join(","), "marcus")
      compare(panel.committedAuthors.join(","), "marcus")
      compare(panel.preview.slug, "marcus")
      compare(panel.notice, fallbackNotice)
      compare(panel.statusText, fallbackNotice)

      var noticeItem = findOne(panel, function(item) {
        return item.text === fallbackNotice && item.visible
      })
      verify(noticeItem !== null)
      var noticeInView = noticeItem.mapToItem(scroller, 0, 0)
      verify(noticeInView.y >= -1 && noticeInView.y + noticeItem.height <= scroller.height + 1)

      // Only Marcus Aurelius's row has a visible checkmark; Seneca's row does not.
      var marcusRow = findOne(panel, function(item) { return item.Accessible && item.Accessible.name === "Marcus Aurelius" })
      var senecaRow = findOne(panel, function(item) { return item.Accessible && item.Accessible.name === "Seneca" })
      verify(marcusRow !== null && senecaRow !== null)
      var marcusCheck = findOne(marcusRow, function(item) { return item.text === "✓" })
      var senecaCheck = findOne(senecaRow, function(item) { return item.text === "✓" })
      verify(marcusCheck !== null && senecaCheck !== null)
      compare(marcusCheck.visible, true)
      compare(senecaCheck.visible, false)

      // Unticking the now-sole selected author still preserves the #102 guard and hint.
      panel.toggleAuthor("marcus")
      wait(20)
      compare(panel.selectedAuthors.join(","), "marcus")
      compare(panel.authorListHint, "Pick at least one author.")
      compare(panel.notice, "")

      // Uncommitted untick before removing the remaining custom author flushes the untick first, then removes.
      compare(panel.adoptState(JSON.stringify({
        settings: { authors: ["seneca", "hierocles"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿", citation: "Letters 1", text: "Claim yourself." },
          { slug: "hierocles", name: "Hierocles", dates: "", custom: true, portrait: "⣿", citation: "Elements", text: "Circles." },
        ],
      })), true)
      wait(20)
      panel.toggleAuthor("seneca")
      compare(panel.selectedAuthors.join(","), "hierocles")
      removes = removeButtons()
      compare(removes.length, 1)
      mouseClick(removes[0])
      mouseClick(removes[0])
      var flushPayload = JSON.parse(applyProc.command[applyProc.command.length - 1])
      compare(flushPayload.authors.join(","), "hierocles")
      compare(flushPayload.removeAuthor, undefined)
      compare(panel.applyQueued, true)

      completeProcess(applyProc, 0, JSON.stringify({
        settings: { authors: ["hierocles"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿", citation: "Letters 1", text: "Claim yourself." },
          { slug: "hierocles", name: "Hierocles", dates: "", custom: true, portrait: "⣿", citation: "Elements", text: "Circles." },
        ],
      }), "", false)
      var secondPayload = JSON.parse(applyProc.command[applyProc.command.length - 1])
      compare(secondPayload.removeAuthor, "hierocles")
      compare(secondPayload.authors, undefined)

      // Removing a selected author when another selected author remains keeps that other author and shows normal "Saved".
      completeProcess(applyProc, 0, JSON.stringify({
        settings: { authors: ["marcus"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", citation: "II.1", text: "Begin." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿", citation: "Letters 1", text: "Claim yourself." },
        ],
      }), "", false)
      wait(20)
      compare(panel.selectedAuthors.join(","), "marcus")
      compare(panel.notice, "Saved")
      compare(panel.rotationNotice, "")
    }

    function test_author_form_live_portrait_preview_and_cancel_writes_nothing() {
      var existingApply = findProcessFor("apply")
      if (existingApply) existingApply.command = []

      compare(panel.adoptState(JSON.stringify({
        settings: { authors: ["marcus", "musonius"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        previewPortraitFont: 6,
        previewPortraitLine: 8.4,
        intervalApplied: true,
        custom: [],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "AD 121 – 180", custom: false, portrait: "⣿", fullPortrait: "⣿⣿\\n⣿⣿", citation: "II.1", text: "Begin." },
          { slug: "musonius", name: "Musonius Rufus", dates: "c. 30–100", custom: true, portrait: "⣿", fullPortrait: "⣶⣶\\n⣶⣶", citation: "VI", text: "Train." },
        ],
      })), true)
      waitForRendering(panel)

      var previewBox = findOne(panel, function(item) { return item.objectName === "authorPortraitPreviewBox" })
      var previewCaption = findOne(panel, function(item) { return item.objectName === "authorPortraitPreviewCaption" })
      var previewText = findOne(panel, function(item) { return item.objectName === "authorPortraitPreviewText" })
      var previewErrorText = findOne(panel, function(item) { return item.objectName === "authorPortraitPreviewErrorText" })
      verify(previewBox !== null && previewCaption !== null && previewText !== null && previewErrorText !== null)

      // 1. Add form: hidden until an image path is entered, then shows live braille before saving.
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorBtn !== null)
      mouseClick(addAuthorBtn)
      waitForRendering(panel)
      compare(previewBox.visible, false)

      var imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      verify(imageField !== null)
      imageField.text = "/tmp/john-locke.jpg"
      wait(0)
      compare(previewBox.visible, true)
      compare(panel.portraitPreviewLoading, true)
      compare(previewCaption.text, "Rendering preview…")
      compare(findProcessFor("apply"), null)

      // Trigger debounced preview run and complete it.
      tryVerify(function() { return panel.activePortraitPreviewProcess !== null })
      var previewProc = panel.activePortraitPreviewProcess
      verify(previewProc !== null)
      compare(previewProc.command[1], "panel")
      compare(previewProc.command[2], "preview-portrait")
      compare(JSON.parse(previewProc.command[previewProc.command.length - 1]).image, "/tmp/john-locke.jpg")
      completeProcess(previewProc, 0, JSON.stringify({
        portrait: "⣤⣶\\n⣿⡟",
        cols: 34,
        rows: 20,
        fontPx: 6,
        lineHeight: 8.4,
      }), "", false)
      wait(10)

      compare(panel.portraitPreviewLoading, false)
      compare(previewCaption.text, "Portrait preview")
      compare(previewText.visible, true)
      compare(previewText.text, "⣤⣶\\n⣿⡟")
      compare(previewErrorText.visible, false)
      compare(panel.error, "")
      compare(panel.notice, "")
      compare(panel.saving, false)
      compare(findProcessFor("apply"), null)

      // 2. Preview error renders inside the preview box without setting panel.error or writing anything.
      imageField.text = "/tmp/does-not-exist.jpg"
      tryVerify(function() { return panel.activePortraitPreviewProcess !== null })
      previewProc = panel.activePortraitPreviewProcess
      verify(previewProc !== null)
      completeProcess(previewProc, 1, "", "omastoic: image file not found: /tmp/does-not-exist.jpg\\n", false)
      wait(10)

      compare(panel.portraitPreviewLoading, false)
      compare(previewText.visible, false)
      compare(previewErrorText.visible, true)
      compare(previewErrorText.text, "Image file not found: /tmp/does-not-exist.jpg")
      compare(panel.error, "")
      compare(panel.saving, false)

      // 3. Stale out-of-order preview completion is ignored when path changes mid-flight.
      imageField.text = "/tmp/first.jpg"
      panel.runPortraitPreview("/tmp/first.jpg")
      var staleProc = panel.activePortraitPreviewProcess
      verify(staleProc !== null)
      imageField.text = "/tmp/second.jpg"
      panel.runPortraitPreview("/tmp/second.jpg")
      var freshProc = panel.activePortraitPreviewProcess
      verify(freshProc !== null && freshProc !== staleProc)

      completeProcess(staleProc, 0, JSON.stringify({ portrait: "STALE", fontPx: 6, lineHeight: 8.4 }), "", false)
      wait(10)
      compare(panel.portraitPreviewLoading, true)
      verify(panel.portraitPreviewArt !== "STALE")

      completeProcess(freshProc, 0, JSON.stringify({ portrait: "⣀⣤\\n⢿⡿", fontPx: 6, lineHeight: 8.4 }), "", false)
      wait(10)
      compare(panel.portraitPreviewLoading, false)
      compare(previewText.text, "⣀⣤\\n⢿⡿")

      // 4. Cancel clears preview state and issues zero panel apply writes.
      var cancelBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelBtn !== null)
      panel.reveal(cancelBtn)
      wait(20)
      mouseClick(cancelBtn)
      wait(20)
      compare(panel.authorOpen, false)
      compare(panel.displayedAuthorPortrait, "")
      compare(panel.portraitPreviewError, "")
      compare(findProcessFor("apply"), null)

      // 5. Edit form: shows current portrait immediately, updates live on Choose image, reverts on clear, Cancel writes nothing.
      var editBtn = findOne(panel, function(item) { return item.label === "Edit" && item.visible })
      verify(editBtn !== null)
      mouseClick(editBtn)
      waitForRendering(panel)
      compare(previewBox.visible, true)
      compare(previewCaption.text, "Current portrait")
      compare(previewText.visible, true)
      compare(previewText.text, "⣶⣶\\n⣶⣶")

      var chooseBtn = findOne(panel, function(item) { return item.label === "Choose image" && item.visible })
      var replaceImageField = findOne(panel, function(item) { return item.placeholderText === "Leave empty to keep current portrait" && item.visible })
      verify(chooseBtn !== null && replaceImageField !== null)
      panel.reveal(chooseBtn)
      waitForRendering(panel)
      mouseClick(chooseBtn)
      var pickProc = panel.activePickProcess
      verify(pickProc !== null)
      completeProcess(pickProc, 0, "/tmp/david-hume.jpg\\n", "", false)

      // Immediate preview launch on picker acceptance without waiting 250ms debounce.
      compare(replaceImageField.text, "/tmp/david-hume.jpg")
      compare(panel.portraitPreviewLoading, true)
      var editPreviewProc = panel.activePortraitPreviewProcess
      verify(editPreviewProc !== null)
      completeProcess(editPreviewProc, 0, JSON.stringify({ portrait: "⠛⠿\\n⠿⠛", fontPx: 6, lineHeight: 8.4 }), "", false)
      wait(10)
      compare(previewCaption.text, "New portrait preview")
      compare(previewText.text, "⠛⠿\\n⠿⠛")
      compare(panel.saving, false)
      compare(findProcessFor("apply"), null)

      // Re-picking the same path after a failed preview immediately re-runs preview-portrait, and a tall 20-line portrait reveals cleanly inside scroller.
      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      verify(pickProc !== null)
      completeProcess(pickProc, 0, "/tmp/david-hume.jpg\\n", "", false)
      compare(panel.portraitPreviewLoading, true)
      var failedPickPreview = panel.activePortraitPreviewProcess
      verify(failedPickPreview !== null)
      completeProcess(failedPickPreview, 1, "", "omastoic: could not read image\\n", false)
      wait(10)
      compare(previewErrorText.visible, true)

      mouseClick(chooseBtn)
      pickProc = panel.activePickProcess
      verify(pickProc !== null)
      completeProcess(pickProc, 0, "/tmp/david-hume.jpg\\n", "", false)
      compare(panel.portraitPreviewLoading, true)
      var repickPreview = panel.activePortraitPreviewProcess
      verify(repickPreview !== null)
      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(scroller !== null)
      scroller.contentY = Math.max(0, previewBox.mapToItem(scroller.contentItem, 0, 0).y + previewBox.height - scroller.height)
      var twentyLines = Array.from({ length: 20 }, function() { return "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿" }).join("\\n")
      completeProcess(repickPreview, 0, JSON.stringify({ portrait: twentyLines, fontPx: 6, lineHeight: 8.4 }), "", false)
      wait(20)
      compare(previewText.visible, true)
      var boxInView = previewBox.mapToItem(scroller, 0, 0)
      verify(boxInView.y >= -1 && boxInView.y + previewBox.height <= scroller.height + 1)

      // Clearing the new image path returns cleanly to the author's current portrait.
      replaceImageField.text = ""
      wait(10)
      compare(previewCaption.text, "Current portrait")
      compare(previewText.text, "⣶⣶\\n⣶⣶")

      // Picking again then pressing Cancel leaves everything unwritten.
      replaceImageField.text = "/tmp/adam-smith.jpg"
      panel.runPortraitPreview("/tmp/adam-smith.jpg")
      var cancelPreviewProc = panel.activePortraitPreviewProcess
      verify(cancelPreviewProc !== null)
      completeProcess(cancelPreviewProc, 0, JSON.stringify({ portrait: "⣶⣿\\n⣿⣶", fontPx: 6, lineHeight: 8.4 }), "", false)
      wait(10)
      var cancelEditBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelEditBtn !== null)
      panel.reveal(cancelEditBtn)
      wait(20)
      mouseClick(cancelEditBtn)
      wait(20)
      compare(panel.authorOpen, false)
      compare(panel.displayedAuthorPortrait, "")
      compare(panel.saving, false)
      compare(findProcessFor("apply"), null)

      // 6. Submitting while a preview is still loading hides the empty preview box cleanly instead of leaving a stray caption.
      mouseClick(addAuthorBtn)
      waitForRendering(panel)
      var addName = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      var addImg = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      var addCite = findOne(panel, function(item) { return item.objectName === "authorCitationField" && item.visible })
      var addQuote = findOne(panel, function(item) { return item.hasOwnProperty("viewportHeight") && item.visible })
      verify(addName !== null && addImg !== null && addCite !== null && addQuote !== null)
      addName.text = "Adam Smith"
      addImg.text = "/tmp/adam-smith.jpg"
      addCite.text = "Moral Sentiments"
      addQuote.text = "Virtue is more to be feared than vice."
      wait(0)
      compare(previewBox.visible, true)
      compare(previewCaption.text, "Rendering preview…")
      panel.submitAuthor()
      wait(10)
      compare(panel.saving, true)
      compare(previewBox.visible, false)
      compare(previewCaption.text, "")
      panel.saving = false
      panel.addingAuthor = false
      panel.notice = ""
      panel.closeAuthorForm()
    }

    function test_author_footer_stays_visible_with_live_portrait_preview() {
      var card = findOne(panel, function(item) { return item.objectName === "panelCard" })
      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })
      verify(card !== null && scroller !== null)

      var assertFooterVisible = function(submitLabel) {
        var submitBtn = findOne(panel, function(item) { return item.label === submitLabel && item.visible })
        var cancelBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
        verify(submitBtn !== null && cancelBtn !== null)
        var submitPt = submitBtn.mapToItem(card, 0, 0)
        var cancelPt = cancelBtn.mapToItem(card, 0, 0)
        verify(submitPt.y >= scroller.y + scroller.height - 1 && submitPt.y + submitBtn.height <= card.height + 1)
        verify(cancelPt.y >= scroller.y + scroller.height - 1 && cancelPt.y + cancelBtn.height <= card.height + 1)
        return { submitBtn: submitBtn, cancelBtn: cancelBtn }
      }

      // 1. Add form with a tall 20-line live portrait preview: Add author and Cancel remain visible without scrolling.
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorBtn !== null)
      mouseClick(addAuthorBtn)
      waitForRendering(panel)
      var imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      verify(imageField !== null)
      imageField.text = "/tmp/tall-preview.png"
      panel.runPortraitPreview("/tmp/tall-preview.png")
      var previewProc = panel.activePortraitPreviewProcess
      verify(previewProc !== null)
      var twentyLines = Array.from({ length: 20 }, function() { return "⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿" }).join("\\n")
      completeProcess(previewProc, 0, JSON.stringify({ portrait: twentyLines, fontPx: 6, lineHeight: 8.4 }), "", false)
      waitForRendering(panel)
      scroller.contentY = 0
      wait(0)
      var addBtns = assertFooterVisible("Add author")

      // 2. Compact user-resized height with 20-line preview still keeps Add author and Cancel pinned inside panelCard.
      panel.userHeight = 440
      waitForRendering(panel)
      verify(scroller.contentHeight > scroller.height)
      scroller.contentY = 0
      wait(0)
      addBtns = assertFooterVisible("Add author")
      mouseClick(addBtns.cancelBtn)
      wait(20)
      compare(panel.authorOpen, false)
      panel.userHeight = 0
      waitForRendering(panel)

      // 3. Edit form with 20-line current portrait keeps Save changes and Cancel visible without scrolling.
      var editBtn = findOne(panel, function(item) { return item.label === "Edit" && item.visible })
      verify(editBtn !== null)
      mouseClick(editBtn)
      waitForRendering(panel)
      var replaceImg = findOne(panel, function(item) { return item.placeholderText === "Leave empty to keep current portrait" && item.visible })
      verify(replaceImg !== null)
      replaceImg.text = "/tmp/tall-edit.png"
      panel.runPortraitPreview("/tmp/tall-edit.png")
      var editPreviewProc = panel.activePortraitPreviewProcess
      verify(editPreviewProc !== null)
      completeProcess(editPreviewProc, 0, JSON.stringify({ portrait: twentyLines, fontPx: 6, lineHeight: 8.4 }), "", false)
      waitForRendering(panel)
      scroller.contentY = 0
      wait(0)
      var editBtns = assertFooterVisible("Save changes")
      mouseClick(editBtns.cancelBtn)
      wait(20)
      compare(panel.authorOpen, false)
    }

    function test_empty_submit_explains_missing_fields_and_placeholders_look_distinct() {
      var existingApply = findProcessFor("apply")
      if (existingApply) existingApply.command = []
      var borderFor = function(field) {
        return findOne(field.parent, function(item) { return item.hasOwnProperty("border") && item.enabled === false })
      }

      // 1. Add author: clicking Add author while fields are empty explains every missing field, highlights them, and focuses the first.
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      verify(addAuthorBtn !== null)
      mouseClick(addAuthorBtn)
      waitForRendering(panel)

      var nameField = findOne(panel, function(item) { return item.objectName === "authorNameField" && item.visible })
      var datesField = findOne(panel, function(item) { return item.objectName === "authorDatesField" && item.visible })
      var imageField = findOne(panel, function(item) { return item.objectName === "authorImageField" && item.visible })
      var citationField = findOne(panel, function(item) { return item.objectName === "authorCitationField" && item.visible })
      var quoteField = findOne(panel, function(item) { return item.objectName === "authorTextField" && item.visible })
      var submitBtn = findOne(panel, function(item) { return item.label === "Add author" && item.visible })
      verify(nameField && datesField && imageField && citationField && quoteField && submitBtn)

      // Placeholders look like prompts/examples and render italic while empty.
      compare(nameField.placeholderText, "Example: Musonius Rufus")
      compare(datesField.placeholderText, "Example: c. AD 30 – 100")
      compare(imageField.placeholderText, "Choose or type an image path")
      compare(citationField.placeholderText, "Example: Lectures VI")
      compare(quoteField.placeholderText, "Type the quote")
      compare(nameField.font.italic, true)
      compare(citationField.font.italic, true)

      compare(submitBtn.available, true)
      mouseClick(submitBtn)
      wait(20)
      compare(panel.errorScope, "author")
      compare(panel.error, "Fill in Name, Portrait image, Citation, and Quote.")
      compare(panel.missingAuthorFields.join(","), "name,image,citation,text")
      compare(findProcessFor("apply"), null)
      compare(nameField.activeFocus, true)
      compare(quoteField.invalid, true)
      compare(String(borderFor(nameField).border.color), String(Commons.Color.urgent))
      compare(String(borderFor(imageField).border.color), String(Commons.Color.urgent))
      compare(String(borderFor(citationField).border.color), String(Commons.Color.urgent))

      // Typing into Name removes its urgent highlight and italic styling while keeping remaining missing fields flagged.
      nameField.text = "David Hume"
      compare(nameField.font.italic, false)
      compare(panel.missingAuthorFields.join(","), "image,citation,text")
      imageField.text = "/tmp/hume.png"
      quoteField.text = "Reason is, and ought only to be the slave of the passions."
      wait(10)
      compare(panel.missingAuthorFields.join(","), "citation")

      // Submitting with only Citation missing names only Citation, focuses it, and typing Citation clears the error.
      mouseClick(submitBtn)
      wait(20)
      compare(panel.error, "Fill in Citation.")
      compare(panel.missingAuthorFields.join(","), "citation")
      compare(citationField.activeFocus, true)
      citationField.text = "Treatise II.3.3"
      wait(10)
      compare(panel.missingAuthorFields.length, 0)
      compare(panel.error, "")

      var cancelAuthorBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(cancelAuthorBtn !== null)
      mouseClick(cancelAuthorBtn)
      wait(20)

      // 2. Edit author: entering Citation without Quote highlights Quote and explains the pairing; clearing Citation clears the error.
      var editBtn = findOne(panel, function(item) { return item.label === "Edit" && item.visible })
      verify(editBtn !== null)
      mouseClick(editBtn)
      waitForRendering(panel)
      var editCite = findOne(panel, function(item) { return item.objectName === "authorCitationField" && item.visible })
      var editQuote = findOne(panel, function(item) { return item.objectName === "authorTextField" && item.visible })
      var saveBtn = findOne(panel, function(item) { return item.label === "Save changes" && item.visible })
      verify(editCite && editQuote && saveBtn)
      editCite.text = "Lectures IX"
      mouseClick(saveBtn)
      wait(20)
      compare(panel.error, "Fill in Quote to match the citation.")
      compare(panel.missingAuthorFields.join(","), "text")
      compare(editQuote.invalid, true)
      editCite.text = ""
      wait(10)
      compare(panel.error, "")
      compare(editQuote.invalid, false)
      var cancelEditBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      mouseClick(cancelEditBtn)
      wait(20)

      // 3. Add quote: clicking Add quote while Quote is missing explains it, highlights QuoteArea, and clears when typed.
      var addQuoteBtn = findOne(panel, function(item) { return item.label === "Add your own quote" && item.visible })
      verify(addQuoteBtn !== null)
      mouseClick(addQuoteBtn)
      waitForRendering(panel)
      var qCite = findOne(panel, function(item) { return item.objectName === "quoteCitationField" && item.visible })
      var qText = findOne(panel, function(item) { return item.objectName === "quoteTextField" && item.visible })
      var qSubmit = findOne(panel, function(item) { return item.label === "Add quote" && item.visible })
      verify(qCite && qText && qSubmit)
      compare(qCite.placeholderText, "Example: Meditations IV.17")
      compare(qText.placeholderText, "Type the quote")
      compare(qCite.font.italic, true)
      qCite.text = "Meditations IV.1"
      compare(qCite.font.italic, false)
      mouseClick(qSubmit)
      wait(20)
      compare(panel.errorScope, "quote")
      compare(panel.error, "Fill in Quote.")
      compare(panel.missingQuoteFields.join(","), "text")
      compare(qText.invalid, true)
      compare(qText.editFocused, true)
      qText.text = "Our inward power turns obstacles into fuel."
      wait(10)
      compare(panel.error, "")
      compare(qText.invalid, false)
      var cancelQuoteBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      mouseClick(cancelQuoteBtn)
      wait(20)
    }
  }
}
`,
    );

    const run = Bun.spawnSync(
      [runner, "-input", join(scratch, "tst_panel.qml"), "-import", scratch],
      {
        env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const combined = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    expect(run.exitCode, combined).toBe(0);
    expect(combined, combined).toContain("14 passed, 0 failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the panel exposes visible resize handles, min/max clamps, and size persistence outside config.json", () => {
  const source = panel();
  for (const needle of [
    "component ResizeHandle",
    "id: resizeCornerRight",
    "id: resizeGrip",
    "id: resizeCornerLeft",
    "id: resizeRight",
    "id: resizeLeft",
    "id: resizeBottom",
    "Qt.SizeFDiagCursor",
    "Qt.SizeBDiagCursor",
    "Qt.SizeHorCursor",
    "Qt.SizeVerCursor",
    "property real userWidth: 0",
    "property real userHeight: 0",
    "function clampedCardWidth(",
    "function clampedCardHeight(",
    "function minCardWidth(",
    "function minCardHeight(",
    "function maxCardWidth(",
    "function maxCardHeight(",
    "function adoptPanelSize(",
    "function persistPanelSize(",
    "function resetPanelSize(",
    '"panel", "size"',
    "PanelWindow {",
    "Commons.Color.menu.scrim",
    "Keys.onEscapePressed:",
  ]) {
    expect(source).toContain(needle);
  }
  expect(source).not.toContain("config.json");
});

test("dragging edges and corners resizes, clamps, reflows, persists, and keeps dismiss working", () => {
  const runner = qmlTestRunner();
  if (!runner) {
    console.log("skipping Qt Quick resize interaction test: qmltestrunner is not installed");
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "omastoic-qmlresize-"));
  try {
    const write = (rel: string, content: string) => {
      const full = join(scratch, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    };

    write("MockQuickshell/qmldir", "module MockQuickshell\nPlaceholder 1.0 Placeholder.qml\n");
    write("MockQuickshell/Placeholder.qml", "import QtQuick\nQtObject {}\n");

    write("MockQuickshell/Io/qmldir", "module MockQuickshell.Io\nProcess 1.0 Process.qml\nStdioCollector 1.0 StdioCollector.qml\n");
    write(
      "MockQuickshell/Io/Process.qml",
      `import QtQuick
Item {
  id: proc
  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property bool manualExit: false
  property var history: []
  property QtObject stdout: null
  property QtObject stderr: null
  signal exited(int exitCode)
  onRunningChanged: {
    if (running && command && command.length > 0) {
      history = history.concat([command.slice()])
      if (!manualExit) {
        running = false
        exited(0)
      }
    }
  }
  function finish(code, outText, errText) {
    if (!running) return
    running = false
    if (stdout) { stdout.text = outText || ""; stdout.streamFinished() }
    if (stderr) { stderr.text = errText || ""; stderr.streamFinished() }
    exited(code)
  }
}
`,
    );
    write(
      "MockQuickshell/Io/StdioCollector.qml",
      `import QtQuick
QtObject {
  property bool waitForEnd: true
  property string text: ""
  signal streamFinished()
}
`,
    );

    write("MockQuickshell/Wayland/qmldir", "module MockQuickshell.Wayland\nPanelWindow 1.0 PanelWindow.qml\n");
    write(
      "MockQuickshell/Wayland/PanelWindow.qml",
      `import QtQuick
Item {
  property color color: "transparent"
  property int exclusionMode: 0
}
`,
    );

    write("MockCommons/qmldir", "module MockCommons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\n");
    write(
      "MockCommons/Style.qml",
      `pragma Singleton
import QtQuick
QtObject {
  property real cornerRadius: 6
  property var font: ({ family: "sans-serif", body: 14, bodySmall: 12, heading: 18 })
  property var spacing: ({ popupPadding: 14 })
  function space(n) { return n }
}
`,
    );
    write(
      "MockCommons/Color.qml",
      `pragma Singleton
import QtQuick
QtObject {
  property color accent: "#7aa2f7"
  property color urgent: "#f7768e"
  property var menu: ({ scrim: "#80000000" })
  property var popups: ({ background: "#1a1b26", border: "#414868", text: "#c0caf5" })
}
`,
    );

    write(
      "MockUi/qmldir",
      "module MockUi\nButton 1.0 Button.qml\nTextField 1.0 TextField.qml\nNumberField 1.0 NumberField.qml\nPanelSeparator 1.0 PanelSeparator.qml\nPanelSectionHeader 1.0 PanelSectionHeader.qml\n",
    );
    write(
      "MockUi/Button.qml",
      `import QtQuick
Item {
  id: root
  property string text: ""
  property bool selected: false
  property bool focusable: true
  property bool bordered: true
  property color foreground: "white"
  property color accent: "#7aa2f7"
  signal clicked()
  signal rightClicked()
  implicitWidth: 80
  implicitHeight: 32
  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: function(mouse) {
      if (root.focusable) root.forceActiveFocus()
      if (mouse.button === Qt.RightButton) root.rightClicked()
      else root.clicked()
    }
  }
}
`,
    );
    write(
      "MockUi/TextField.qml",
      `import QtQuick
import QtQuick.Controls as QQC
QQC.TextField {
  property color foreground: "white"
  implicitWidth: 200
  implicitHeight: 32
}
`,
    );
    write(
      "MockUi/NumberField.qml",
      `import QtQuick
Item {
  property string label: ""
  property int value: 60
  property int from: 5
  property int to: 3600
  property int stepSize: 5
  property color foreground: "white"
  property QtObject field: QtObject { property int value: 60; property bool activeFocus: false; property QtObject contentItem: QtObject { property string text: "60" } }
  signal modified(int value)
  implicitWidth: 80
  implicitHeight: 32
}
`,
    );
    write("MockUi/PanelSeparator.qml", 'import QtQuick\nRectangle { property color foreground: "white"; width: parent ? parent.width : 100; height: 1 }\n');
    write("MockUi/PanelSectionHeader.qml", 'import QtQuick\nText { property color foreground: "white"; width: parent ? parent.width : 100 }\n');

    const testPanelSource = panel()
      .replace(/^import Quickshell\.Io$/gm, "import MockQuickshell.Io")
      .replace(/^import Quickshell\.Wayland$/gm, "import MockQuickshell.Wayland")
      .replace(/^import Quickshell$/gm, "import MockQuickshell")
      .replace(/^import qs\.Commons as Commons$/gm, "import MockCommons as Commons")
      .replace(/^import qs\.Commons$/gm, "import MockCommons")
      .replace(/^import qs\.Ui$/gm, "import MockUi")
      .replace(/anchors\s*\{\s*top:\s*true;\s*bottom:\s*true;\s*left:\s*true;\s*right:\s*true\s*\}/, "anchors.fill: parent")
      .replace(/^\s*exclusionMode:.*$/gm, "")
      .replace(/^\s*WlrLayershell\..*$/gm, "");
    write("PanelUnderTest.qml", testPanelSource);

    write(
      "tst_resize.qml",
      `import QtQuick
import QtTest

Item {
  id: harness
  width: 1200
  height: 900

  PanelUnderTest {
    id: panel
    anchors.fill: parent
  }

  TestCase {
    name: "PanelResize"
    when: windowShown

    function findAll(node, pred, out) {
      if (!out) out = []
      if (!node) return out
      if (pred(node)) out.push(node)
      var kids = node.children || []
      for (var i = 0; i < kids.length; i++) findAll(kids[i], pred, out)
      return out
    }

    function findOne(node, pred) {
      var list = findAll(node, pred)
      return list.length > 0 ? list[0] : null
    }

    function byName(name) {
      return findOne(panel, function(item) { return item.objectName === name })
    }

    function samplePayload(panelSize) {
      var data = {
        settings: { authors: ["marcus", "seneca", "epictetus", "musonius"], interval: 60 },
        portraitFont: 8,
        portraitLine: 11.2,
        intervalApplied: true,
        custom: [
          { id: "c01", author: "musonius", name: "Musonius Rufus", citation: "Lectures VI", text: "Train both mind and body." },
        ],
        samples: [
          { slug: "marcus", name: "Marcus Aurelius", dates: "121–180", custom: false, portrait: "⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿", citation: "Meditations II.1", text: "Begin the morning by saying to yourself." },
          { slug: "seneca", name: "Seneca", dates: "c. 4 BC – AD 65", custom: false, portrait: "⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿", citation: "Letters I.1", text: "Claim yourself for yourself." },
          { slug: "epictetus", name: "Epictetus", dates: "c. 50 – c. 135", custom: false, portrait: "⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿", citation: "Enchiridion 1", text: "Some things are in our control." },
          { slug: "musonius", name: "Musonius Rufus", dates: "c. 30–100", custom: true, portrait: "⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿\\n⣿⣿⣿⣿⣿⣿", citation: "Lectures VI", text: "Train both mind and body." },
        ],
      }
      if (panelSize !== undefined) data.panelSize = panelSize
      return JSON.stringify(data)
    }

    function seed(panelSize) {
      panel.open("")
      panel.notice = ""
      compare(panel.adoptState(samplePayload(panelSize)), true)
      wait(0)
    }

    function sizeCommands() {
      var procs = findAll(panel, function(item) {
        return item.hasOwnProperty("history") && item.history instanceof Array
      })
      var cmds = []
      for (var i = 0; i < procs.length; i++) {
        for (var j = 0; j < procs[i].history.length; j++) {
          var cmd = procs[i].history[j]
          if (cmd.length >= 4 && cmd[1] === "panel" && cmd[2] === "size") cmds.push(cmd)
        }
      }
      return cmds
    }

    function dragFrom(startX, startY, dx, dy, expectRender) {
      mousePress(harness, startX, startY, Qt.LeftButton)
      mouseMove(harness, startX + dx / 2, startY + dy / 2, -1, Qt.LeftButton)
      mouseMove(harness, startX + dx, startY + dy, -1, Qt.LeftButton)
      mouseRelease(harness, startX + dx, startY + dy, Qt.LeftButton)
      if (expectRender !== false) waitForRendering(panel)
      else wait(0)
    }

    function dragHandle(handle, dx, dy) {
      var startPt = handle.mapToItem(harness, handle.width / 2, handle.height / 2)
      dragFrom(startPt.x, startPt.y, dx, dy, true)
    }

    function test_drag_resize_clamping_reflow_persistence_and_dismiss() {
      seed(null)
      waitForRendering(panel)

      var card = byName("panelCard")
      var content = byName("panelContent")
      var cornerRight = byName("resizeCornerRight")
      var cornerLeft = byName("resizeCornerLeft")
      var grip = byName("resizeGrip")
      var edgeRight = byName("resizeRight")
      var edgeLeft = byName("resizeLeft")
      var edgeBottom = byName("resizeBottom")
      var scroller = findOne(panel, function(item) {
        return item.hasOwnProperty("contentY") && item.hasOwnProperty("flickableDirection")
      })

      verify(card !== null)
      verify(content !== null)
      verify(cornerRight !== null)
      verify(cornerLeft !== null)
      verify(grip !== null)
      verify(edgeRight !== null)
      verify(edgeLeft !== null)
      verify(edgeBottom !== null)
      verify(scroller !== null)

      // Visible grip and corner hit areas sit strictly outside scroller at Omarchy's popupPadding (14).
      compare(grip.visible, true)
      verify(grip.width > 0 && grip.height > 0)
      var gripTopLeft = grip.mapToItem(card, 0, 0)
      var cornerRightTL = cornerRight.mapToItem(card, 0, 0)
      var cornerLeftTR = cornerLeft.mapToItem(card, cornerLeft.width, 0)
      verify(gripTopLeft.x >= scroller.x + scroller.width || gripTopLeft.y >= scroller.y + scroller.height)
      verify(cornerRightTL.x >= scroller.x + scroller.width || cornerRightTL.y >= scroller.y + scroller.height)
      verify(cornerLeftTR.x <= scroller.x || cornerLeftTR.y >= scroller.y + scroller.height)

      // Default size: 520 wide, centered horizontally.
      compare(card.width, 520)
      var initialHeight = card.height
      verify(initialHeight > 320 && initialHeight < harness.height - 64)
      verify(Math.abs((card.x + card.width / 2) - harness.width / 2) <= 1)

      // 0. Inactive-axis jitter on single-axis edges keeps auto-size and spawns no size write.
      var cmdsBeforeJitter = sizeCommands().length
      var bottomMid = edgeBottom.mapToItem(harness, edgeBottom.width / 2, edgeBottom.height / 2)
      dragFrom(bottomMid.x, bottomMid.y, 25, 0, false)
      compare(panel.userWidth, 0)
      compare(panel.userHeight, 0)
      compare(card.width, 520)
      compare(card.height, initialHeight)
      compare(panel.opened, true)
      compare(sizeCommands().length, cmdsBeforeJitter)

      var rightMid = edgeRight.mapToItem(harness, edgeRight.width / 2, edgeRight.height / 2)
      dragFrom(rightMid.x, rightMid.y, 0, 25, false)
      compare(panel.userWidth, 0)
      compare(panel.userHeight, 0)
      compare(card.width, 520)
      compare(panel.opened, true)
      compare(sizeCommands().length, cmdsBeforeJitter)

      var leftMid = edgeLeft.mapToItem(harness, edgeLeft.width / 2, edgeLeft.height / 2)
      dragFrom(leftMid.x, leftMid.y, 0, -25, false)
      compare(panel.userWidth, 0)
      compare(panel.userHeight, 0)
      compare(card.width, 520)
      compare(panel.opened, true)
      compare(sizeCommands().length, cmdsBeforeJitter)

      // 0b. Dragging from the 6 px resizeOuterLip outside card resizes without falling through to scrim.
      var cardOrigin = card.mapToItem(harness, 0, 0)
      dragFrom(cardOrigin.x + card.width + 3, cardOrigin.y + card.height / 2, 40, 0, true)
      compare(panel.opened, true)
      verify(Math.abs(card.width - 600) <= 2)
      compare(panel.userHeight, 0)

      cardOrigin = card.mapToItem(harness, 0, 0)
      var heightBeforeOuterCorner = card.height
      dragFrom(cardOrigin.x + card.width + 3, cardOrigin.y + card.height + 3, -40, 30, true)
      compare(panel.opened, true)
      verify(Math.abs(card.width - 520) <= 2)
      verify(Math.abs(card.height - (heightBeforeOuterCorner + 30)) <= 2)

      // Reset cleanly before center-handle sequence so step 1 starts from default size.
      panel.resetPanelSize()
      waitForRendering(panel)
      compare(card.width, 520)
      compare(card.height, initialHeight)

      // 1. Drag bottom-right corner to widen and heighten card 1:1 with pointer.
      dragHandle(cornerRight, 80, 100)
      compare(panel.opened, true)
      verify(Math.abs(card.width - 680) <= 2)
      verify(Math.abs(card.height - (initialHeight + 100)) <= 2)
      verify(Math.abs((card.x + card.width / 2) - harness.width / 2) <= 1)
      var cmds = sizeCommands()
      verify(cmds.length >= 1)
      var persisted = JSON.parse(cmds[cmds.length - 1][3])
      verify(Math.abs(persisted.width - 680) <= 2)
      verify(Math.abs(persisted.height - (initialHeight + 100)) <= 2)

      // 2. Drag left edge outward: card grows symmetrically and stays centered.
      var widthBeforeLeft = card.width
      var heightBeforeLeft = card.height
      dragHandle(edgeLeft, -40, 0)
      verify(Math.abs(card.width - (widthBeforeLeft + 80)) <= 2)
      compare(card.height, heightBeforeLeft)
      verify(Math.abs((card.x + card.width / 2) - harness.width / 2) <= 1)

      // 3. Drag right edge inward: card narrows symmetrically.
      var widthBeforeRight = card.width
      dragHandle(edgeRight, -50, 0)
      verify(Math.abs(card.width - (widthBeforeRight - 100)) <= 2)

      // 4. Drag bottom edge up and down: height tracks without changing width.
      var widthBeforeBottom = card.width
      var heightBeforeBottom = card.height
      dragHandle(edgeBottom, 0, -60)
      compare(card.width, widthBeforeBottom)
      verify(Math.abs(card.height - (heightBeforeBottom - 60)) <= 2)

      // 4b. Drag bottom-left corner: both width and height change cleanly.
      var widthBeforeBL = card.width
      var heightBeforeBL = card.height
      dragHandle(cornerLeft, -30, 40)
      verify(Math.abs(card.width - (widthBeforeBL + 60)) <= 2)
      verify(Math.abs(card.height - (heightBeforeBL + 40)) <= 2)

      // 5. Drag far inward past minimum: clamps to 400 x 320 and content fits with no overflow.
      dragHandle(cornerRight, -500, -500)
      compare(card.width, 400)
      compare(card.height, 320)
      compare(content.width, scroller.width)
      compare(panel.opened, true)

      var previewBtn = findOne(panel, function(item) { return item.label === "Preview" && item.visible })
      var addQuoteBtn = findOne(panel, function(item) { return item.label === "Add your own quote" && item.visible })
      var addAuthorBtn = findOne(panel, function(item) { return item.label === "Add an author" && item.visible })
      var customEditBtn = findOne(panel, function(item) { return item.label === "Edit" && item.visible })
      var customRemoveBtn = findOne(panel, function(item) { return item.label === "Remove" && item.visible })
      verify(previewBtn !== null && addQuoteBtn !== null && addAuthorBtn !== null && customEditBtn !== null && customRemoveBtn !== null)
      var checkedButtons = [previewBtn, addQuoteBtn, addAuthorBtn, customEditBtn, customRemoveBtn]
      for (var btnIdx = 0; btnIdx < checkedButtons.length; btnIdx++) {
        var btn = checkedButtons[btnIdx]
        var pos = btn.mapToItem(scroller, 0, 0)
        verify(pos.x >= -1, btn.label + " x=" + pos.x)
        verify(pos.x + btn.width <= scroller.width + 1, btn.label + " right=" + (pos.x + btn.width) + " scroller=" + scroller.width)
      }

      // Scroll down while compact, then enlarge tall: contentY clamps so no blank tail remains.
      panel.reveal(addAuthorBtn)
      wait(0)
      mouseClick(addAuthorBtn)
      wait(0)
      verify(scroller.contentHeight > scroller.height)
      scroller.contentY = scroller.contentHeight - scroller.height
      wait(0)

      // 6. Drag far outward onto the scrim past max: clamps inside overlay margins and does not dismiss.
      dragHandle(cornerRight, 900, 900)
      compare(panel.opened, true)
      compare(card.width, harness.width - 48)
      compare(card.height, harness.height - 64)
      compare(content.width, scroller.width)
      verify(card.x >= 23 && card.x + card.width <= harness.width - 23)
      verify(card.y >= 31 && card.y + card.height <= harness.height - 31)
      verify(scroller.contentY <= Math.max(0, scroller.contentHeight - scroller.height) + 1)

      // Close author form so next checks start clean.
      var closeAuthorBtn = findOne(panel, function(item) { return item.label === "Cancel" && item.visible })
      verify(closeAuthorBtn !== null)
      mouseClick(closeAuthorBtn)
      wait(0)

      // 7. Double-clicking corner handle resets to auto size even if pointer jitters >=1 px before release.
      var countBeforeReset = sizeCommands().length
      var resetPt = cornerRight.mapToItem(harness, cornerRight.width / 2, cornerRight.height / 2)
      mousePress(harness, resetPt.x, resetPt.y, Qt.LeftButton)
      mouseRelease(harness, resetPt.x, resetPt.y, Qt.LeftButton)
      mousePress(harness, resetPt.x, resetPt.y, Qt.LeftButton)
      qtest_events.mouseDoubleClick(harness, resetPt.x, resetPt.y, Qt.LeftButton, Qt.NoModifier, -1)
      mouseMove(harness, resetPt.x + 5, resetPt.y + 5, -1, Qt.LeftButton)
      mouseRelease(harness, resetPt.x + 5, resetPt.y + 5, Qt.LeftButton)
      waitForRendering(panel)
      compare(panel.userWidth, 0)
      compare(panel.userHeight, 0)
      compare(card.width, 520)
      var afterReset = sizeCommands()
      compare(afterReset.length, countBeforeReset + 1)
      compare(JSON.parse(afterReset[afterReset.length - 1][3]).reset, true)

      // 7b. Reopening while sizeProcess is still in flight keeps the dragged size when stale stateProcess arrives later.
      var allProcs = findAll(panel, function(item) { return item.hasOwnProperty("manualExit") })
      var stateProc = findOne(panel, function(item) { return item.hasOwnProperty("manualExit") && item.command && item.command[2] === "state" })
      var sizeProc = findOne(panel, function(item) { return item.hasOwnProperty("manualExit") && item.command && item.command[2] === "size" })
      verify(stateProc !== null && sizeProc !== null && allProcs.length >= 2)
      stateProc.manualExit = true
      sizeProc.manualExit = true
      dragHandle(cornerRight, 80, 60)
      var draggedW = panel.userWidth
      verify(draggedW > 600)
      compare(sizeProc.running, true)
      panel.close()
      panel.open("")
      sizeProc.finish(0, "", "")
      stateProc.finish(0, samplePayload(null), "")
      compare(panel.userWidth, draggedW)
      stateProc.manualExit = false
      sizeProc.manualExit = false

      // 8. Reopening restores saved size, clamps oversized state, and falls back on missing/bad state.
      seed({ width: 760, height: 620 })
      compare(card.width, 760)
      compare(card.height, 620)

      seed({ width: 5000, height: 4000 })
      waitForRendering(panel)
      compare(card.width, harness.width - 48)
      compare(card.height, harness.height - 64)

      seed({ width: "bad", height: -10 })
      waitForRendering(panel)
      compare(card.width, 520)
      compare(panel.userHeight, 0)

      seed(null)
      compare(card.width, 520)
      compare(panel.userHeight, 0)

      // 9. Pressing a resize handle (center or outer lip) cancels Remove? confirm without closing; scrim click and Esc still dismiss.
      var removeBtn = findOne(panel, function(item) {
        return item.hasOwnProperty("keepsRemoveConfirm") && item.keepsRemoveConfirm === true && item.visible
      })
      verify(removeBtn !== null)
      mouseClick(removeBtn)
      compare(panel.confirmRemoveAuthor, "musonius")
      var handlePt = cornerRight.mapToItem(harness, cornerRight.width / 2, cornerRight.height / 2)
      mouseClick(harness, handlePt.x, handlePt.y)
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.opened, true)

      mouseClick(removeBtn)
      compare(panel.confirmRemoveAuthor, "musonius")
      var outerCardPos = card.mapToItem(harness, 0, 0)
      mouseClick(harness, outerCardPos.x + card.width + 3, outerCardPos.y + card.height + 3)
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.opened, true)

      // Scrim click outside card dismisses.
      mouseClick(harness, 10, 10)
      compare(panel.opened, false)

      // Reopen and press Escape to dismiss.
      seed(null)
      compare(panel.opened, true)
      keyClick(Qt.Key_Escape)
      compare(panel.opened, false)
    }
  }
}
`,
    );

    const run = Bun.spawnSync(
      [runner, "-input", join(scratch, "tst_resize.qml"), "-import", scratch],
      {
        env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const combined = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    expect(run.exitCode, combined).toBe(0);
    expect(combined, combined).toContain("3 passed, 0 failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
