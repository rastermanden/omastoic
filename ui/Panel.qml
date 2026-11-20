import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import qs.Commons as Commons

// Settings for the choices `omastoic config` already owns.
// Every read is `panel state` and every write is `panel apply`, so the CLI
// stays the only validator. Changes apply on their own. There is no Save.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool opened: false

  readonly property string command: {
    var dir = manifest && manifest.__sourceDir ? String(manifest.__sourceDir) : ""
    if (dir !== "") return dir.replace(/\/+$/, "") + "/bin/omastoic"
    return String(Qt.resolvedUrl("../bin/omastoic")).replace(/^file:\/\//, "")
  }
  readonly property string pluginId: (manifest && manifest.id) ? String(manifest.id) : "io.github.rastermanden.omastoic"

  property var settings: ({})
  property var samples: []
  property int portraitFont: 8
  property real portraitLine: 13.592
  property var custom: []
  property bool intervalApplied: true
  property bool adopting: false
  property bool saving: false
  property bool applyQueued: false
  property var pendingQuote: null
  property string pendingRemove: ""
  property string notice: ""
  property string error: ""
  property bool quoteOpen: false
  onQuoteOpenChanged: if (quoteOpen) Qt.callLater(function() { root.reveal(quoteForm) })
  property bool listOpen: false
  readonly property bool busy: notice === "Loading…" || notice === "Saving…"
  readonly property string statusText: error !== "" ? error : notice

  property var selectedAuthors: []
  property var committedAuthors: []
  property int interval: 60
  property int committedInterval: 60
  property string newAuthor: "marcus"
  property string newCitation: ""
  property string newText: ""

  readonly property bool quoteReady: newAuthor !== "" && newCitation.trim() !== "" && newText.trim() !== ""
  readonly property var preview: {
    for (var i = 0; i < samples.length; i++) {
      if (selectedAuthors.indexOf(samples[i].slug) !== -1) return samples[i]
    }
    return null
  }
  readonly property color ink: Commons.Color.popups.text
  // 0.88 clears 4.5:1 for small text on Tokyo Night and Catppuccin Latte.
  // Placeholders stay lower so they read as hints, not as typed text.
  readonly property color quiet: Qt.rgba(ink.r, ink.g, ink.b, 0.88)
  readonly property color hint: Qt.rgba(ink.r, ink.g, ink.b, 0.7)

  function open(payloadJson) {
    opened = true
    quoteOpen = false
    listOpen = false
    reload()
    Qt.callLater(function() { if (root.opened) previewButton.focus() })
  }

  function close() { opened = false }

  function reveal(item) {
    if (!item) return
    var pos = item.mapToItem(scroller.contentItem, 0, 0)
    var top = pos.y
    var bottom = pos.y + item.height
    if (top < scroller.contentY) scroller.contentY = Math.max(0, top - 8)
    else if (bottom > scroller.contentY + scroller.height) scroller.contentY = Math.max(0, bottom - scroller.height + 8)
  }

  function portraitFullyVisible(top, height, contentY, viewport) {
    return top >= contentY - 0.5 && top + height <= contentY + viewport + 0.5
  }

  function dismiss() {
    if (shell && typeof shell.hide === "function") shell.hide(root.pluginId)
    else close()
  }

  function reload() {
    if (notice === "Saving…") return
    saving = false
    error = ""
    notice = "Loading…"
    resetRun(stateRun)
    stateProcess.running = true
  }

  function resetRun(run) {
    run.exited = false
    run.exitCode = 0
    run.stdout = ""
    run.stderr = ""
    run.streamsLeft = 2
  }

  function plainError(text, fallback) {
    var line = String(text || "").trim().split("\n")[0].replace(/^omastoic:\s*/, "")
    return line !== "" ? line : fallback
  }

  function restoreCommitted() {
    adopting = true
    selectedAuthors = committedAuthors.slice()
    interval = committedInterval
    if (secondsField.field) secondsField.field.value = committedInterval
    adopting = false
  }

  function settleRun(run, fallback) {
    if (!run.exited || run.streamsLeft > 0) return
    var failed = run.exitCode !== 0
    var adopted = !failed && adoptState(run.stdout)
    if (failed || !adopted) {
      if (saving) restoreCommitted()
      notice = ""
      error = failed ? plainError(run.stderr, fallback) : "Could not read the settings."
      applyQueued = false
    } else {
      error = ""
      notice = saving ? "Saved" : ""
      if (saving) savedTimer.restart()
    }
    saving = false
    if (applyQueued) {
      applyQueued = false
      applyNow()
    }
  }

  function adoptState(text) {
    var parsed
    try { parsed = JSON.parse(String(text || "")) }
    catch (failure) { return false }
    if (!parsed || typeof parsed !== "object") return false
    adopting = true
    var saved = parsed.settings && parsed.settings.authors instanceof Array ? parsed.settings.authors : []
    settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : ({})
    samples = parsed.samples instanceof Array ? parsed.samples : []
    portraitFont = Number(parsed.portraitFont) || 8
    portraitLine = Number(parsed.portraitLine) || 13.592
    custom = parsed.custom instanceof Array ? parsed.custom : []
    intervalApplied = parsed.intervalApplied !== false
    interval = Number(settings.interval) || 60
    var slugs = []
    var pool = saved.length ? saved : samples.map(function(author) { return author.slug })
    for (var i = 0; i < samples.length; i++) {
      if (pool.indexOf(samples[i].slug) !== -1) slugs.push(samples[i].slug)
    }
    selectedAuthors = slugs
    committedAuthors = slugs.slice()
    committedInterval = interval
    if (samples.length && !samples.some(function(author) { return author.slug === root.newAuthor }))
      newAuthor = samples[0].slug
    citationField.text = ""
    textField.text = ""
    if (secondsField.field) secondsField.field.value = interval
    adopting = false
    return true
  }

  function toggleAuthor(slug) {
    var next = []
    var found = false
    for (var i = 0; i < samples.length; i++) {
      var id = samples[i].slug
      var on = selectedAuthors.indexOf(id) !== -1
      if (id === slug) on = !on
      if (on) next.push(id)
      if (id === slug) found = true
    }
    if (!found) return
    if (!next.length) {
      error = ""
      notice = "Pick at least one Stoic."
      return
    }
    selectedAuthors = next
    scheduleApply()
  }

  function commitInterval() {
    if (!intervalApplied || !secondsField.field || !secondsField.field.contentItem) return
    var typed = parseInt(String(secondsField.field.contentItem.text), 10)
    if (typed >= 1 && typed <= 3600) interval = typed
  }

  function scheduleApply() {
    if (adopting || !opened) return
    error = ""
    applyTimer.restart()
  }

  function applyNow() {
    if (!opened) return
    commitInterval()
    if (!selectedAuthors.length) {
      error = ""
      notice = "Pick at least one Stoic."
      return
    }
    if (busy) { applyQueued = true; return }
    var payload = { authors: selectedAuthors }
    if (intervalApplied) payload.interval = interval
    if (pendingRemove !== "") {
      payload.removeQuote = pendingRemove
      pendingRemove = ""
      if (pendingQuote) applyQueued = true
    } else if (pendingQuote) {
      payload.addQuote = pendingQuote
      pendingQuote = null
    }
    saving = true
    error = ""
    notice = "Saving…"
    resetRun(applyRun)
    applyProcess.command = [command, "panel", "apply", JSON.stringify(payload)]
    applyProcess.running = true
  }

  function addQuote() {
    if (!quoteReady) {
      notice = "A quote needs a citation and the words."
      return
    }
    pendingQuote = { author: newAuthor, citation: newCitation.trim(), text: newText.trim() }
    quoteOpen = false
    applyNow()
  }

  function removeQuote(id) {
    pendingRemove = id
    applyNow()
  }

  component RingButton: Item {
    id: host
    property string label: ""
    property bool picked: false
    property bool available: true
    signal activated()
    implicitWidth: inner.implicitWidth
    implicitHeight: inner.implicitHeight
    function focus() { inner.forceActiveFocus() }
    HoverHandler {
      id: buttonHover
      cursorShape: host.available ? Qt.PointingHandCursor : Qt.ArrowCursor
    }
    Button {
      id: inner
      width: host.width
      height: host.height
      text: host.label
      selected: false
      enabled: host.available
      opacity: host.available ? 1 : 0.45
      focusable: true
      bordered: true
      foreground: root.ink
      onClicked: host.activated()
      onActiveFocusChanged: if (activeFocus) root.reveal(host)
    }
    MouseArea {
      anchors.fill: inner
      z: 2
      enabled: !host.available
      hoverEnabled: true
    }
    Rectangle {
      anchors.fill: inner
      anchors.margins: -2
      z: 1
      enabled: false
      color: host.picked
        ? Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.45)
        : (buttonHover.hovered && host.available ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08) : "transparent")
      radius: Style.cornerRadius
      border.width: inner.activeFocus ? 2 : (buttonHover.hovered && host.available ? 1 : 0)
      border.color: inner.activeFocus ? Commons.Color.accent : root.ink
    }
  }

  Timer { id: applyTimer; interval: 300; onTriggered: root.applyNow() }
  Timer {
    id: savedTimer
    interval: 2200
    onTriggered: { if (root.notice === "Saved") root.notice = "" }
  }

  QtObject { id: stateRun; property bool exited: false; property int exitCode: 0; property string stdout: ""; property string stderr: ""; property int streamsLeft: 0 }
  QtObject { id: applyRun; property bool exited: false; property int exitCode: 0; property string stdout: ""; property string stderr: ""; property int streamsLeft: 0 }

  Process {
    id: stateProcess
    command: [root.command, "panel", "state"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: { stateRun.stdout = String(text || ""); stateRun.streamsLeft--; root.settleRun(stateRun, "Could not load settings.") } }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: { stateRun.stderr = String(text || ""); stateRun.streamsLeft--; root.settleRun(stateRun, "Could not load settings.") } }
    onExited: function(exitCode) { stateRun.exitCode = exitCode; stateRun.exited = true; root.settleRun(stateRun, "Could not load settings.") }
  }

  Process {
    id: applyProcess
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: { applyRun.stdout = String(text || ""); applyRun.streamsLeft--; root.settleRun(applyRun, "Could not save that.") } }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: { applyRun.stderr = String(text || ""); applyRun.streamsLeft--; root.settleRun(applyRun, "Could not save that.") } }
    onExited: function(exitCode) { applyRun.exitCode = exitCode; applyRun.exited = true; root.settleRun(applyRun, "Could not save that.") }
  }

  Process {
    id: previewProcess
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { if (String(text || "").trim() !== "") root.error = root.plainError(text, "Could not open the preview.") }
    }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.error = ""
        root.notice = "Preview opened."
        previewTimer.restart()
      } else if (root.notice === "Opening preview…") {
        root.notice = ""
      }
    }
  }

  Timer {
    id: previewTimer
    interval: 2500
    onTriggered: { if (root.notice === "Preview opened.") root.notice = "" }
  }

  PanelWindow {
    id: window
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omastoic-panel"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive

    Rectangle {
      anchors.fill: parent
      color: Commons.Color.menu.scrim
      MouseArea { anchors.fill: parent; onClicked: root.dismiss() }
    }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.onEscapePressed: root.dismiss()
      Keys.onPressed: function(event) {
        if ((event.key === Qt.Key_S) && (event.modifiers & Qt.ControlModifier)) {
          root.applyNow()
          event.accepted = true
        }
      }

      Rectangle {
        id: card
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: Style.space(32)
        width: Math.min(Style.space(520), keyCatcher.width - Style.space(48))
        height: Math.min(content.implicitHeight + Style.spacing.popupPadding * 2, keyCatcher.height - Style.space(64))
        radius: Style.cornerRadius
        color: Commons.Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Commons.Color.popups.border
        MouseArea { anchors.fill: parent; onClicked: {} }

        Flickable {
          id: scroller
          anchors.fill: parent
          anchors.margins: Style.spacing.popupPadding
          contentHeight: content.implicitHeight
          clip: true
          flickableDirection: Flickable.VerticalFlick

          Column {
            id: content
            width: parent.width
            spacing: Style.space(12)

            Row {
              width: parent.width
              spacing: Style.space(14)

              Item {
                id: portraitSlot
                width: portraitText.implicitWidth
                height: portraitText.implicitHeight
                opacity: portraitFullyVisible(portraitSlot.mapToItem(scroller.contentItem, 0, 0).y, portraitSlot.height, scroller.contentY, scroller.height) ? 1 : 0
                Text {
                  id: portraitText
                  text: root.preview ? root.preview.portrait : ""
                  color: root.ink
                  font.family: Style.font.family
                  font.pixelSize: root.portraitFont
                  lineHeightMode: Text.FixedHeight
                  lineHeight: root.portraitLine
                  wrapMode: Text.NoWrap
                }
              }

              Column {
                width: parent.width - Style.space(110)
                spacing: Style.space(4)

                Row {
                  width: parent.width
                  spacing: Style.space(8)
                  Column {
                    width: parent.width - previewButton.implicitWidth - Style.space(8)
                    spacing: Style.space(2)
                    Text {
                      text: "Omastoic"
                      color: root.ink
                      font.family: Style.font.family
                      font.pixelSize: Style.font.heading
                      font.bold: true
                    }
                    Text {
                      text: "Screensaver"
                      color: root.quiet
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                  }
                  RingButton {
                    id: previewButton
                    label: "Preview"
                    onActivated: {
                      root.error = ""
                      root.notice = "Opening preview…"
                      previewProcess.command = root.preview && root.preview.id
                        ? [root.command, "preview", "--quote", root.preview.id]
                        : [root.command, "preview"]
                      previewProcess.running = true
                    }
                  }
                }

                Item {
                  id: quoteSlot
                  width: parent.width
                  height: Style.font.body * 1.35 * 3
                  clip: true
                  Text {
                    width: parent.width
                    anchors.verticalCenter: quoteSlot.verticalCenter
                    text: root.preview ? root.preview.text : "Pick at least one Stoic."
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    lineHeight: 1.35
                    wrapMode: Text.WordWrap
                    maximumLineCount: 3
                  }
                }
                Text {
                  width: parent.width
                  visible: root.preview !== null
                  text: root.preview ? (root.preview.name + ", " + root.preview.citation) : ""
                  color: root.quiet
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }
                Text {
                  width: parent.width
                  text: root.intervalApplied ? ("Every " + root.interval + " seconds") : "A new quote each time the screensaver starts"
                  color: root.quiet
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }
              }
            }

            PanelSeparator { foreground: root.ink }

            PanelSectionHeader { text: "Who is in rotation"; foreground: root.ink }

            Repeater {
              model: root.samples
              delegate: Rectangle {
                required property var modelData
                width: parent.width
                implicitHeight: row.implicitHeight + Style.space(8)
                radius: Style.cornerRadius
                color: {
                  var on = root.selectedAuthors.indexOf(modelData.slug) !== -1
                  if (on) return Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.16)
                  if (rowPress.containsMouse) return Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08)
                  return "transparent"
                }
                border.width: activeFocus ? Math.max(2, Style.space(2)) : (rowPress.containsMouse ? Math.max(1, Style.space(1)) : 0)
                border.color: activeFocus ? Commons.Color.accent : root.ink
                activeFocusOnTab: true
                Accessible.name: modelData.name
                Accessible.role: Accessible.CheckBox

                Row {
                  id: row
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.margins: Style.space(6)
                  spacing: Style.space(8)
                  Rectangle {
                    width: Style.space(16)
                    height: Style.space(16)
                    radius: Style.space(3)
                    anchors.verticalCenter: parent.verticalCenter
                    color: root.selectedAuthors.indexOf(modelData.slug) !== -1 ? Commons.Color.accent : "transparent"
                    border.width: Math.max(1, Style.space(1))
                    border.color: root.selectedAuthors.indexOf(modelData.slug) !== -1 ? Commons.Color.accent : root.ink
                    Text {
                      anchors.centerIn: parent
                      visible: root.selectedAuthors.indexOf(modelData.slug) !== -1
                      text: "✓"
                      color: Commons.Color.popups.background
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                    }
                  }
                  Column {
                    width: parent.width - Style.space(80)
                    Text {
                      text: modelData.name
                      color: root.ink
                      font.family: Style.font.family
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      text: modelData.dates
                      color: root.quiet
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                  }
                }

                MouseArea {
                  id: rowPress
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleAuthor(modelData.slug)
                }
                Keys.onPressed: function(event) {
                  if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    root.toggleAuthor(modelData.slug)
                    event.accepted = true
                  }
                }
              }
            }

            Text {
              width: parent.width
              visible: root.intervalApplied
              text: "Seconds each quote stays up"
              color: root.quiet
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Item {
              width: secondsField.implicitWidth
              height: secondsField.implicitHeight
              visible: root.intervalApplied
              NumberField {
                id: secondsField
                label: ""
                value: root.interval
                from: 5
                to: 3600
                stepSize: 5
                foreground: root.ink
                onModified: function(value) { root.interval = value; root.scheduleApply() }
                onActiveFocusChanged: if (activeFocus) root.reveal(secondsField)
              }
              Rectangle {
                anchors.fill: parent
                anchors.margins: -2
                enabled: false
                color: "transparent"
                radius: Style.cornerRadius
                border.width: secondsField.field && secondsField.field.activeFocus ? 2 : 0
                border.color: Commons.Color.accent
              }
            }

            PanelSeparator { foreground: root.ink }

            RingButton {
              label: root.quoteOpen ? "Close" : "Add your own quote"
              onActivated: root.quoteOpen = !root.quoteOpen
            }

            Column {
              id: quoteForm
              width: parent.width
              visible: root.quoteOpen
              spacing: Style.space(8)

              Text {
                text: "Who said it"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Grid {
                width: parent.width
                columns: 3
                rowSpacing: Style.space(6)
                columnSpacing: Style.space(6)
                Repeater {
                  model: root.samples
                  delegate: RingButton {
                    required property var modelData
                    width: Math.floor((parent.width - Style.space(12)) / 3)
                    label: modelData.name
                    picked: root.newAuthor === modelData.slug
                    onActivated: root.newAuthor = modelData.slug
                  }
                }
              }
              Text {
                text: "Citation"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: citationField.implicitHeight
                TextField {
                  id: citationField
                  width: parent.width
                  placeholderText: "Meditations IV.17"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: root.newCitation = text
                  Keys.onReturnPressed: root.addQuote()
                  onActiveFocusChanged: if (activeFocus) root.reveal(citationField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: citationField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                text: "Quote"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: textField.implicitHeight
                TextField {
                  id: textField
                  width: parent.width
                  placeholderText: "The line itself"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: root.newText = text
                  Keys.onReturnPressed: root.addQuote()
                  onActiveFocusChanged: if (activeFocus) root.reveal(textField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: textField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                width: parent.width
                visible: root.newCitation.trim() !== "" || root.newText.trim() !== ""
                text: {
                  var who = ""
                  for (var i = 0; i < root.samples.length; i++) {
                    if (root.samples[i].slug === root.newAuthor) who = root.samples[i].name
                  }
                  var cite = root.newCitation.trim()
                  var line = root.newText.trim()
                  return who + (cite !== "" ? ", " + cite : "") + (line !== "" ? " — " + line : "")
                }
                color: root.ink
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
              }
              RingButton {
                label: "Add quote"
                available: root.quoteReady && !root.busy
                onActivated: root.addQuote()
              }
            }

            RingButton {
              visible: root.custom.length > 0
              label: root.custom.length === 1 ? "1 of your own" : (root.custom.length + " of your own")
              onActivated: root.listOpen = !root.listOpen
            }

            Column {
              width: parent.width
              visible: root.listOpen && root.custom.length > 0
              spacing: Style.space(6)
              Repeater {
                model: root.custom
                delegate: Row {
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(8)
                  Text {
                    width: parent.width - Style.space(96)
                    text: modelData.name + ", " + modelData.citation
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                  }
                  RingButton {
                    label: "Remove"
                    onActivated: root.removeQuote(modelData.id)
                  }
                }
              }
            }

            Item {
              width: parent.width
              implicitHeight: Style.font.bodySmall * 2 + Style.space(4)
              Text {
                width: parent.width
                text: root.statusText
                color: root.error !== "" ? Commons.Color.urgent : root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }
            }
          }
        }
      }
    }
  }
}
