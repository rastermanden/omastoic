import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import qs.Commons as Commons

// Settings panel for the forms `omastoic config` already owns: which Stoics are
// in rotation, seconds per quote, and one of your own quotes.
//
// The host mounts this as the plugin's `panel` entry point and injects `shell`
// and `manifest`; `omarchy-shell shell toggle <id>` (or `omastoic ui`) reaches
// open()/close(). Nothing here reads or writes ~/.config/omastoic: every read is
// `omastoic panel state` and every write is `omastoic panel apply <json>`, so the
// CLI keeps its one validator, one lock and one daemon restart.
Item {
  id: root

  property var shell: null
  property var manifest: null

  property bool opened: false

  // The plugin's own CLI wrapper lives at <plugin>/bin/omastoic, one level up
  // from this file. The host keeps `__sourceDir` on the manifest it hands a
  // third-party plugin ("keep __sourceDir: third-party plugins find their
  // bundled scripts through it"), so the panel does not have to guess the
  // install path. A bare `Panel` outside the host (the smoke harness) falls
  // back to the file's own location.
  readonly property string command: {
    var dir = manifest && manifest.__sourceDir ? String(manifest.__sourceDir) : ""
    if (dir !== "") return dir.replace(/\/+$/, "") + "/bin/omastoic"
    return String(Qt.resolvedUrl("../bin/omastoic")).replace(/^file:\/\//, "")
  }
  readonly property string pluginId: (manifest && manifest.id) ? String(manifest.id) : "io.github.rastermanden.omastoic"

  // Saved state as `panel state` reports it.
  property var settings: ({})
  property var roster: []
  property string summary: ""
  property int customQuotes: 0
  property bool busy: false
  property string error: ""

  // Edits, written only when Save is pressed.
  property var selectedAuthors: []
  property int interval: 60
  property string newAuthor: "marcus"
  property string newCitation: ""
  property string newText: ""

  readonly property bool quoteReady: newAuthor !== "" && newCitation !== "" && newText !== ""

  readonly property var allSlugs: roster.map(function(author) { return author.slug })

  function setAuthors(list) {
    selectedAuthors = list
    stoicsPicker.values = list
  }

  function open(payloadJson) {
    opened = true
    reload()
    Qt.callLater(function() { if (root.opened) keyCatcher.forceActiveFocus() })
  }

  function close() {
    opened = false
  }

  function dismiss() {
    if (shell && typeof shell.hide === "function") shell.hide(root.pluginId)
    else close()
  }

  function reload() {
    if (stateProcess.running) return
    busy = true
    error = ""
    stateProcess.running = true
  }

  // One saved state, rendered. Called for `panel state` and for the state that
  // `panel apply` echoes back, so the panel never shows an unsaved value.
  //
  // The kit's inputs keep their own copy of the value and drop an incoming
  // binding the first time the user edits them, so the saved state is pushed
  // into them imperatively instead of bound.
  function adoptState(text) {
    var parsed
    try {
      parsed = JSON.parse(String(text || ""))
    } catch (failure) {
      error = "Could not read the omastoic state."
      return
    }
    if (!parsed || typeof parsed !== "object") {
      error = "Could not read the omastoic state."
      return
    }
    var saved = parsed.settings && parsed.settings.authors instanceof Array ? parsed.settings.authors : []
    settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : ({})
    roster = parsed.authors instanceof Array ? parsed.authors : []
    summary = String(parsed.summary || "")
    customQuotes = Number(parsed.customQuotes) || 0
    interval = Number(settings.interval) || 60
    newCitation = ""
    newText = ""
    if (roster.length && !roster.some(function(author) { return author.slug === root.newAuthor }))
      newAuthor = roster[0].slug

    setAuthors(saved.length ? saved.slice() : allSlugs)
    secondsField.field.value = interval
    authorField.text = newAuthor
    citationField.text = ""
    textField.text = ""
  }

  function toggleAll() {
    setAuthors(selectedAuthors.length ? [] : allSlugs)
  }

  function save() {
    if (busy) return
    var payload = { interval: interval, authors: selectedAuthors }
    if (quoteReady) {
      payload.addQuote = { author: newAuthor, citation: newCitation, text: newText }
    }
    busy = true
    error = ""
    applyProcess.command = [command, "panel", "apply", JSON.stringify(payload)]
    applyProcess.running = true
  }

  Process {
    id: stateProcess
    command: [root.command, "panel", "state"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.adoptState(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (String(text || "").trim() !== "") root.error = String(text).trim()
    }
    onExited: function(exitCode) {
      root.busy = false
      if (exitCode !== 0 && root.error === "") root.error = "omastoic panel state failed."
    }
  }

  Process {
    id: applyProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (String(text || "").trim() !== "") root.adoptState(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (String(text || "").trim() !== "") root.error = String(text).trim()
    }
    onExited: function(exitCode) {
      root.busy = false
      if (exitCode === 0) root.error = ""
      else if (root.error === "") root.error = "omastoic panel apply failed."
    }
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
      color: Qt.rgba(0, 0, 0, 0.55)

      MouseArea {
        anchors.fill: parent
        onClicked: root.dismiss()
      }
    }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true

      Keys.onEscapePressed: root.dismiss()

      Rectangle {
        id: card

        anchors.centerIn: parent
        width: Math.min(Style.space(460), keyCatcher.width - Style.space(48))
        height: content.implicitHeight + Style.spacing.popupPadding * 2
        radius: Style.cornerRadius
        color: Commons.Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Commons.Color.popups.border

        // Only the scrim outside the card dismisses the panel.
        MouseArea { anchors.fill: parent; onClicked: {} }

        Column {
          id: content

          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: Style.spacing.popupPadding
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Stoics"
            meta: root.summary
            detail: root.busy ? "Saving…" : "Screensaver settings"
            foreground: Commons.Color.popups.text
          }

          PanelSeparator { foreground: Commons.Color.popups.text }

          PanelSectionHeader {
            text: "In rotation"
            foreground: Commons.Color.popups.text
          }

          Toggle {
            width: parent.width
            label: "All six Stoics"
            description: "Off keeps only the Stoics picked below."
            checked: root.selectedAuthors.length === root.roster.length && root.roster.length > 0
            foreground: Commons.Color.popups.text
            onClicked: root.toggleAll()
          }

          MultiSelect {
            id: stoicsPicker
            width: parent.width
            label: "Stoics"
            values: root.selectedAuthors
            options: root.roster.map(function(author) {
              return { value: author.slug, label: author.name, description: author.dates }
            })
            noSelectionText: "All six"
            onChanged: function(values) { root.selectedAuthors = values }
          }

          NumberField {
            id: secondsField
            label: "Seconds per quote"
            value: root.interval
            from: 1
            to: 3600
            stepSize: 5
            foreground: Commons.Color.popups.text
            onModified: function(value) { root.interval = value }
          }

          PanelSeparator { foreground: Commons.Color.popups.text }

          PanelSectionHeader {
            text: "Your own quote" + (root.customQuotes > 0 ? " · " + root.customQuotes + " added" : "")
            foreground: Commons.Color.popups.text
          }

          TextField {
            id: authorField
            width: parent.width
            placeholderText: "Author slug, for example marcus"
            text: "marcus"
            foreground: Commons.Color.popups.text
            onTextChanged: root.newAuthor = text
          }

          TextField {
            id: citationField
            width: parent.width
            placeholderText: "Citation, for example Meditations IX.1"
            foreground: Commons.Color.popups.text
            onTextChanged: root.newCitation = text
          }

          TextField {
            id: textField
            width: parent.width
            placeholderText: "The line itself"
            foreground: Commons.Color.popups.text
            onTextChanged: root.newText = text
          }

          Row {
            spacing: Style.space(10)

            Button {
              text: "Save"
              bordered: true
              enabled: !root.busy
              foreground: Commons.Color.popups.text
              onClicked: root.save()
            }

            Button {
              text: "Reload"
              bordered: true
              enabled: !root.busy
              foreground: Commons.Color.popups.text
              onClicked: root.reload()
            }
          }

          Text {
            width: parent.width
            visible: root.error !== ""
            text: root.error
            color: Commons.Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }
      }
    }
  }
}
