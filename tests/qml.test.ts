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
  expect(source).toContain("replaceAuthor");
  expect(source).toContain("removeAuthor");
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
  expect(customActionsBody!).toContain("visible: modelData.custom === true");
  const removeButtonBody = blockContaining(customActionsBody!, /RingButton\s*\{/, "requestRemoveAuthor");
  expect(removeButtonBody).not.toBeNull();
  expect(removeButtonBody!).toContain("keepsRemoveConfirm: true");
  expect(removeButtonBody!).toContain('onFocusLost: if (root.confirmRemoveAuthor === modelData.slug) root.confirmRemoveAuthor = ""');

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
  property var spacing: ({ popupPadding: 16 })
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

Item {
  id: harness
  width: 800
  height: 900

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
      var nameField = findOne(panel, function(item) { return item.placeholderText === "Musonius Rufus" && item.visible })
      verify(nameField !== null)
      mouseClick(nameField)
      compare(panel.confirmRemoveAuthor, "")

      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      var disabledAddAuthor = findOne(panel, function(item) { return item.label === "Add author" && item.visible && !item.available })
      verify(disabledAddAuthor !== null)
      panel.reveal(disabledAddAuthor)
      waitForRendering(panel)
      mouseClick(disabledAddAuthor)
      compare(panel.opened, true)
      compare(panel.confirmRemoveAuthor, "")

      scroller.contentY = 0
      waitForRendering(panel)
      var closeAuthorBtn = findOne(panel, function(item) { return item.label === "Close" && item.visible })
      verify(closeAuthorBtn !== null)
      mouseClick(closeAuthorBtn)
      scroller.contentY = 0
      waitForRendering(panel)

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

      // 7. Escape cancels Remove? without closing the panel.
      keyClick(Qt.Key_Escape)
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.opened, true)

      // 8. Second click on the same armed Remove? button commits removal.
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "musonius")
      compare(panel.saving, false)
      mouseClick(musoniusRemove)
      compare(panel.confirmRemoveAuthor, "")
      compare(panel.saving, true)
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
    expect(combined, combined).toContain("3 passed, 0 failed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
