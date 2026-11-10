import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import qs.Commons as Commons

// Settings panel for what `omastoic config` already owns: which Stoics are in
// rotation, seconds per quote, each quote's switch, and your own quotes.
//
// The host mounts this as the plugin's `panel` entry point and injects `shell`
// and `manifest`; `omarchy-shell shell toggle <id>` (or `omastoic ui`) reaches
// open()/close(). Nothing here reads or writes ~/.config/omastoic: every read is
// `omastoic panel state` and every write is `omastoic panel apply <json>`, so the
// CLI keeps its one validator, one lock and one daemon restart.
//
// Every change saves at once. Writes queue one at a time, the row flips before
// the CLI answers, and the state the CLI echoes back is what stays on screen.
Item {
  id: root

  property var shell: null
  property var manifest: null

  property bool opened: false

  // The plugin's own CLI wrapper lives at <plugin>/bin/omastoic, one level up
  // from this file. The host keeps `__sourceDir` on the manifest it hands a
  // third-party plugin, so the panel does not have to guess the install path.
  // A bare `Panel` outside the host (the smoke harness) falls back to the
  // file's own location.
  readonly property string command: {
    var dir = manifest && manifest.__sourceDir ? String(manifest.__sourceDir) : ""
    if (dir !== "") return dir.replace(/\/+$/, "") + "/bin/omastoic"
    return String(Qt.resolvedUrl("../bin/omastoic")).replace(/^file:\/\//, "")
  }
  readonly property string pluginId: (manifest && manifest.id) ? String(manifest.id) : "io.github.rastermanden.omastoic"

  // Saved state as `panel state` reports it.
  property var settings: ({})
  property var roster: []
  property var quotes: []
  property string summary: ""
  property bool loaded: false

  // Status line: "Loading…"/"Saving…" while the CLI runs, "Saved" for a moment after.
  property string busyLabel: ""
  readonly property bool busy: busyLabel !== ""
  property string error: ""
  property string notice: ""

  // Stoics as the chips show them: none picked means only your own quotes.
  readonly property var picked: settings.mineOnly ? []
    : settings.authors instanceof Array && settings.authors.length ? settings.authors
    : roster.map(function(author) { return author.slug })
  readonly property var mine: quotes.filter(function(quote) { return quote.custom })
  readonly property var mineSwitchable: mine.filter(function(quote) { return quote.switchable })
  readonly property bool mineOn: mine.some(function(quote) { return quote.kept })
  readonly property int rotatingCount: quotes.filter(function(quote) { return quote.inRotation }).length

  // The list: "all", "on", "off" or "mine", plus the search box.
  property string listFilter: "all"
  property string search: ""
  property var expanded: ({})
  // The list follows the chips: picked Stoics' quotes plus your own.
  readonly property var pickedQuotes: quotes.filter(function(quote) {
    return quote.custom || !quote.switchable || picked.indexOf(quote.author) !== -1
  })
  readonly property int pickedOnCount: pickedQuotes.filter(function(quote) { return quote.inRotation }).length
  readonly property var shownQuotes: {
    const needle = search.trim().toLowerCase()
    const book = pickedQuotes.filter(function(quote) { return !quote.custom })
    const ordered = mine.slice().reverse().concat(book)
    return ordered.filter(function(quote) {
      if (listFilter === "on" && !quote.inRotation) return false
      if (listFilter === "off" && quote.inRotation) return false
      if (listFilter === "mine" && !quote.custom) return false
      return needle === "" || (quote.text + " " + quote.name + " " + quote.citation).toLowerCase().indexOf(needle) !== -1
    })
  }

  // The add form, closed until "+ Add quote".
  property bool adding: false
  property string newAuthor: ""
  property string newCitation: ""
  property string newText: ""
  // The quote file keys authors by slug: "Tomas Sowell" becomes tomas-sowell,
  // and a Stoic's full or short name becomes that Stoic's slug.
  readonly property string authorSlug: {
    const typed = newAuthor.trim().toLowerCase()
    const stoic = roster.find(function(author) {
      const name = String(author.name).toLowerCase()
      return name === typed || name.split(" ")[0] === typed || author.slug === typed
    })
    return stoic ? stoic.slug : slugOf(typed)
  }
  function slugOf(typed) { return typed.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64) }
  readonly property string addBlocker: {
    const missing = []
    if (authorSlug === "") missing.push("an author")
    if (newCitation.trim() === "") missing.push("a citation")
    if (newText.trim() === "") missing.push("the quote")
    if (!missing.length) return ""
    return "Needs " + (missing.length === 1 ? missing[0] : missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1]) + "."
  }

  // One line that matches the tags below it.
  readonly property string headline: {
    if (!loaded) return ""
    const who = picked.length === 0 ? "Only your own quotes"
      : picked.length === roster.length ? "All six Stoics"
      : roster.filter(function(author) { return picked.indexOf(author.slug) !== -1 }).map(shortName).join(", ")
    return who + " · " + rotatingCount + " of " + quotes.length + " quotes in rotation · every " + (Number(settings.interval) || 60) + "s"
  }

  function shortName(author) { return String(author.name).split(" ")[0] }

  function open(payloadJson) {
    opened = true
    reload()
    Qt.callLater(function() { if (root.opened) keyCatcher.forceActiveFocus() })
  }

  function close() {
    opened = false
    adding = false
  }

  function dismiss() {
    if (shell && typeof shell.hide === "function") shell.hide(root.pluginId)
    else close()
  }

  // --- writes -------------------------------------------------------------------

  property var queue: []

  function reload() {
    send({ kind: "state" })
  }

  function send(job) {
    queue = queue.concat([job])
    if (!stateProcess.running && !applyProcess.running) runNext()
  }

  function runNext() {
    if (!queue.length) return
    const job = queue[0]
    queue = queue.slice(1)
    error = ""
    resetRun(run)
    run.job = job
    if (job.kind === "state") {
      busyLabel = loaded ? "Refreshing…" : "Loading…"
      stateProcess.running = true
    } else {
      busyLabel = "Saving…"
      applyProcess.command = [command, "panel", "apply", JSON.stringify(job.payload)]
      applyProcess.running = true
    }
  }

  // A run is done once it has exited and both streams have been read;
  // Quickshell does not promise the order. Only a failed run shows its stderr:
  // a successful one may still warn there (an unreadable settings file, say).
  function resetRun(r) {
    r.exited = false
    r.exitCode = 0
    r.stdout = ""
    r.stderr = ""
    r.streamsLeft = 2
  }

  function settle() {
    if (!run.exited || run.streamsLeft > 0) return
    const job = run.job
    busyLabel = ""
    if (run.exitCode !== 0) {
      error = run.stderr.trim() !== "" ? run.stderr.trim() : "omastoic could not " + (job.kind === "state" ? "read" : "save") + " the settings."
      // Drop the optimistic flip: show what is really saved.
      queue = []
      if (job.kind !== "state") Qt.callLater(reload)
    } else if (!adoptState(run.stdout)) {
      error = "Could not read the omastoic state."
    } else if (job.kind !== "state") {
      notice = job.done || "Saved"
      noticeTimer.restart()
      if (job.added) {
        adding = false
        newCitation = ""
        newText = ""
        citationField.text = ""
        textField.text = ""
        listFilter = "mine"
        quoteView.positionViewAtBeginning()
      }
    }
    runNext()
  }

  // One saved state, rendered. The kit's inputs keep their own copy of the
  // value, so saved values are pushed into them instead of bound.
  function adoptState(text) {
    var parsed
    try {
      parsed = JSON.parse(String(text || ""))
    } catch (failure) {
      return false
    }
    if (!parsed || typeof parsed !== "object" || !(parsed.quotes instanceof Array)) return false
    settings = parsed.settings && typeof parsed.settings === "object" ? Object.assign({}, parsed.settings, { mineOnly: !!parsed.mineOnly }) : ({})
    roster = parsed.authors instanceof Array ? parsed.authors : []
    quotes = parsed.quotes
    summary = String(parsed.summary || "")
    if (!intervalTimer.running) secondsField.field.value = Number(settings.interval) || 60
    loaded = true
    return true
  }

  function flip(ids, on) {
    quotes = quotes.map(function(quote) {
      return ids.indexOf(quote.id) !== -1 ? Object.assign({}, quote, { kept: on, inRotation: on && quote.inRotation }) : quote
    })
  }

  function keep(id, on) {
    const change = {}
    change[id] = on
    flip([id], on)
    send({ kind: "apply", payload: { keep: change }, done: on ? "Switched on" : "Switched off" })
  }

  function toggleStoic(slug) {
    const next = picked.indexOf(slug) === -1 ? picked.concat([slug]) : picked.filter(function(s) { return s !== slug })
    setPicked(next)
  }

  function setPicked(next) {
    // Nobody picked means only your own quotes; an empty list would mean every Stoic.
    settings = Object.assign({}, settings, { authors: next, mineOnly: next.length === 0 })
    send({
      kind: "apply",
      payload: next.length ? { authors: next, mineOnly: false } : { mineOnly: true },
      done: next.length ? "Saved" : "Only your own quotes now",
    })
  }

  function toggleMine() {
    const on = !mineOn
    const change = {}
    mineSwitchable.forEach(function(quote) { change[quote.id] = on })
    flip(Object.keys(change), on)
    send({ kind: "apply", payload: { keep: change }, done: on ? "Your quotes are on" : "Your quotes are off" })
  }

  function addQuote() {
    if (addBlocker !== "" || adding === false) return
    send({
      kind: "apply",
      payload: { addQuote: { author: authorSlug, citation: newCitation.trim(), text: newText.trim() } },
      done: "Added. It is in rotation.",
      added: true,
    })
  }

  QtObject {
    id: run
    property var job: null
    property bool exited: false
    property int exitCode: 0
    property string stdout: ""
    property string stderr: ""
    property int streamsLeft: 0
  }

  Process {
    id: stateProcess
    command: [root.command, "panel", "state"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { run.stdout = String(text || ""); run.streamsLeft--; root.settle() }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { run.stderr = String(text || ""); run.streamsLeft--; root.settle() }
    }
    onExited: function(exitCode) { run.exitCode = exitCode; run.exited = true; root.settle() }
  }

  Process {
    id: applyProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { run.stdout = String(text || ""); run.streamsLeft--; root.settle() }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { run.stderr = String(text || ""); run.streamsLeft--; root.settle() }
    }
    onExited: function(exitCode) { run.exitCode = exitCode; run.exited = true; root.settle() }
  }

  // Seconds save once the number stops changing.
  property int pendingSeconds: 60
  function changeSeconds(value) {
    pendingSeconds = value
    intervalTimer.restart()
  }

  Timer {
    id: intervalTimer
    interval: 700
    onTriggered: root.send({ kind: "apply", payload: { interval: root.pendingSeconds }, done: "Every " + root.pendingSeconds + "s" })
  }

  Timer {
    id: noticeTimer
    interval: 1800
    onTriggered: root.notice = ""
  }

  // --- view ---------------------------------------------------------------------

  component Caption: Text {
    color: Qt.darker(Commons.Color.popups.text, 1.4)
    font.family: Style.font.family
    font.pixelSize: Style.font.bodySmall
    wrapMode: Text.WordWrap
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

      Keys.onEscapePressed: root.adding ? root.adding = false : root.dismiss()

      Rectangle {
        id: card

        readonly property real pad: Style.spacing.popupPadding
        anchors.centerIn: parent
        width: Math.min(Style.space(520), keyCatcher.width - Style.space(48))
        height: Math.min(content.implicitHeight + pad * 2, keyCatcher.height - Style.space(48))
        radius: Style.cornerRadius
        color: Commons.Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Commons.Color.popups.border

        // Only the scrim outside the card dismisses the panel.
        MouseArea { anchors.fill: parent; onClicked: {} }

        Column {
          id: content

          anchors.fill: parent
          anchors.margins: card.pad
          spacing: Style.space(12)

          // Header: title, one-line status, and the summary that never truncates.
          Item {
            width: parent.width
            height: Math.max(titleText.implicitHeight, statusText.implicitHeight)

            Text {
              id: titleText
              text: "Stoics"
              color: Commons.Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              id: statusText
              anchors.right: parent.right
              anchors.verticalCenter: titleText.verticalCenter
              text: root.busy ? root.busyLabel : root.notice !== "" ? "✓ " + root.notice : ""
              color: root.notice !== "" && !root.busy ? Commons.Color.accent : Qt.darker(Commons.Color.popups.text, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }

          Caption {
            width: parent.width
            text: root.headline
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

          PanelSeparator { foreground: Commons.Color.popups.text }

          // Rotation: one chip per Stoic, one for your own quotes, then seconds.
          PanelSectionHeader {
            text: "In rotation"
            foreground: Commons.Color.popups.text
          }

          Flow {
            id: chips
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: root.roster
              delegate: Button {
                required property var modelData
                text: root.shortName(modelData)
                tooltipText: modelData.name + " · " + modelData.dates
                bordered: true
                selected: root.picked.indexOf(modelData.slug) !== -1
                foreground: Commons.Color.popups.text
                fontSize: Style.font.bodySmall
                horizontalPadding: Style.space(8)
                onClicked: root.toggleStoic(modelData.slug)
              }
            }

            Button {
              text: "Mine " + root.mine.length
              tooltipText: root.mineSwitchable.length ? "Switch all your own quotes on or off" : "Add a quote first"
              bordered: true
              selected: root.mineOn
              enabled: root.mineSwitchable.length > 0
              foreground: Commons.Color.popups.text
              fontSize: Style.font.bodySmall
              horizontalPadding: Style.space(8)
              onClicked: root.toggleMine()
            }
          }

          Caption {
            width: parent.width
            visible: root.loaded
            text: root.picked.length === 0
              ? (root.mineOn ? "No Stoics: only your own quotes rotate." : "Nothing is on, so the whole book rotates.")
              : root.picked.length === root.roster.length ? "All six Stoics, plus your own quotes that are on."
              : "Click a name to add or drop that Stoic. The list shows only the picked ones."
          }

          NumberField {
            id: secondsField
            label: "Seconds per quote"
            value: 60
            from: 1
            to: 3600
            stepSize: 5
            foreground: Commons.Color.popups.text
            onModified: function(value) { root.changeSeconds(value) }
          }

          PanelSeparator { foreground: Commons.Color.popups.text }

          // Quotes: filter tags, add button, search, list.
          Item {
            width: parent.width
            height: Math.max(filterTags.height, addButton.height)

            ButtonGroup {
              id: filterTags
              value: root.listFilter
              options: [
                { value: "all", label: "All " + root.pickedQuotes.length },
                { value: "on", label: "On " + root.pickedOnCount },
                { value: "off", label: "Off " + (root.pickedQuotes.length - root.pickedOnCount) },
                { value: "mine", label: "Mine " + root.mine.length }
              ]
              spacing: Style.space(6)
              foreground: Commons.Color.popups.text
              background: Commons.Color.popups.background
              fontSize: Style.font.bodySmall
              onChanged: function(value) { root.listFilter = value }
            }

            Button {
              id: addButton
              anchors.right: parent.right
              text: root.adding ? "Cancel" : "+ Add quote"
              bordered: true
              foreground: Commons.Color.popups.text
              fontSize: Style.font.bodySmall
              onClicked: {
                root.adding = !root.adding
                if (root.adding) Qt.callLater(function() { authorField.forceActiveFocus() })
              }
            }
          }

          // The add form, right above the list it lands in.
          Rectangle {
            width: parent.width
            visible: root.adding
            height: visible ? addForm.implicitHeight + Style.space(20) : 0
            radius: Style.cornerRadius
            color: "transparent"
            border.width: Math.max(1, Style.space(1))
            border.color: Commons.Color.popups.border

            Column {
              id: addForm
              anchors.fill: parent
              anchors.margins: Style.space(10)
              spacing: Style.space(8)

              TextField {
                id: textField
                width: parent.width
                placeholderText: "The quote"
                foreground: Commons.Color.popups.text
                onTextChanged: root.newText = text
                onAccepted: root.addQuote()
              }

              Row {
                width: parent.width
                spacing: Style.space(8)

                TextField {
                  id: authorField
                  width: (parent.width - parent.spacing) / 2
                  placeholderText: "Author, e.g. Seneca or Tomas Sowell"
                  foreground: Commons.Color.popups.text
                  onTextChanged: root.newAuthor = text
                  onAccepted: root.addQuote()
                }

                TextField {
                  id: citationField
                  width: (parent.width - parent.spacing) / 2
                  placeholderText: "Source, e.g. Letters 1"
                  foreground: Commons.Color.popups.text
                  onTextChanged: root.newCitation = text
                  onAccepted: root.addQuote()
                }
              }

              Item {
                width: parent.width
                height: Math.max(addHint.implicitHeight, addConfirm.height)

                Caption {
                  id: addHint
                  anchors.left: parent.left
                  anchors.right: addConfirm.left
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.addBlocker !== "" ? root.addBlocker
                    : "Saved as “" + root.authorSlug + "”. Enter adds it."
                }

                Button {
                  id: addConfirm
                  anchors.right: parent.right
                  text: "Add"
                  bordered: true
                  enabled: root.addBlocker === ""
                  foreground: Commons.Color.popups.text
                  fontSize: Style.font.bodySmall
                  onClicked: root.addQuote()
                }
              }
            }
          }

          TextField {
            id: searchField
            width: parent.width
            placeholderText: "Search quotes, authors or sources"
            foreground: Commons.Color.popups.text
            onTextChanged: root.search = text
          }

          ListView {
            id: quoteView
            width: parent.width
            // Grows with the list, up to about half the screen.
            height: Math.min(contentHeight, Math.max(Style.space(160), keyCatcher.height * 0.45))
            clip: true
            spacing: Style.space(4)
            boundsBehavior: Flickable.StopAtBounds
            model: root.shownQuotes

            delegate: Rectangle {
              id: quoteRow
              required property var modelData
              readonly property bool open: !!root.expanded[modelData.id]
              width: quoteView.width
              height: rowBody.implicitHeight + Style.space(12)
              radius: Style.cornerRadius
              color: rowMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.04) : "transparent"

              MouseArea {
                id: rowMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  const next = Object.assign({}, root.expanded)
                  next[quoteRow.modelData.id] = !quoteRow.open
                  root.expanded = next
                }
              }

              ToggleSwitch {
                id: quoteSwitch
                anchors.right: parent.right
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                checked: quoteRow.modelData.kept
                visible: quoteRow.modelData.switchable
                foreground: Commons.Color.popups.text
                onToggled: root.keep(quoteRow.modelData.id, !quoteRow.modelData.kept)
              }

              Column {
                id: rowBody
                anchors.left: parent.left
                anchors.right: quoteSwitch.left
                anchors.leftMargin: Style.space(6)
                anchors.rightMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(3)
                opacity: quoteRow.modelData.inRotation ? 1 : 0.5

                Text {
                  width: parent.width
                  text: "“" + quoteRow.modelData.text + "”"
                  color: Commons.Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  wrapMode: Text.WordWrap
                  maximumLineCount: quoteRow.open ? 1000 : 2
                  elide: Text.ElideRight
                }

                Row {
                  width: parent.width
                  spacing: Style.space(6)

                  Rectangle {
                    visible: quoteRow.modelData.custom
                    width: badge.implicitWidth + Style.space(8)
                    height: badge.implicitHeight + Style.space(2)
                    radius: Style.cornerRadius
                    color: "transparent"
                    border.width: Math.max(1, Style.space(1))
                    border.color: Commons.Color.accent
                    Text {
                      id: badge
                      anchors.centerIn: parent
                      text: "yours"
                      color: Commons.Color.accent
                      font.family: Style.font.family
                      font.pixelSize: Style.font.caption
                    }
                  }

                  Caption {
                    width: parent.width - (quoteRow.modelData.custom ? badge.implicitWidth + Style.space(14) : 0)
                    wrapMode: Text.NoWrap
                    elide: Text.ElideRight
                    text: quoteRow.modelData.name + " · " + quoteRow.modelData.citation
                      + (quoteRow.modelData.inRotation ? ""
                        : !quoteRow.modelData.kept ? " · off"
                        : " · " + root.shortName(quoteRow.modelData) + " not picked")
                  }
                }
              }
            }
          }

          Caption {
            width: parent.width
            visible: root.loaded && root.shownQuotes.length === 0
            text: root.listFilter === "mine" && root.mine.length === 0 ? "No quotes of your own yet. Use + Add quote."
              : root.picked.length === 0 && root.mine.length === 0 ? "No Stoics picked. Click a name above, or add a quote of your own."
              : "No quote matches."
          }
        }
      }
    }
  }
}
