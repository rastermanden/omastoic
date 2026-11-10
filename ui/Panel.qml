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
  property var quotes: []
  property string quoteFilter: ""
  // Which quotes the list shows: "all", "stoics" or "mine".
  property string quoteSource: "all"
  // Which rotation state the list shows: "any", "on" (in rotation) or "off".
  property string quoteState: "any"
  readonly property int mineCount: quotes.filter(function(quote) { return quote.custom }).length
  // The list follows the Stoics picked above before Save: with the picks as
  // saved it shows the CLI's own rotation; with changed picks it shows what
  // Save would put in rotation.
  readonly property var savedAuthors: settings.mineOnly ? [] : settings.authors instanceof Array && settings.authors.length ? settings.authors : allSlugs
  readonly property bool picksChanged: selectedAuthors.length !== savedAuthors.length
    || selectedAuthors.some(function(slug) { return savedAuthors.indexOf(slug) === -1 })
  readonly property var listedQuotes: quotes.map(function(quote) {
    const on = !picksChanged ? quote.inRotation
      : quote.custom || !quote.switchable ? quote.kept
      : quote.kept && selectedAuthors.indexOf(quote.author) !== -1
    return Object.assign({}, quote, { on: on })
  })
  readonly property int rotatingCount: listedQuotes.filter(function(quote) { return quote.on }).length
  // Newest custom quotes first, then the Stoics' book in its own order.
  readonly property var shownQuotes: {
    const needle = quoteFilter.trim().toLowerCase()
    const mine = listedQuotes.filter(function(quote) { return quote.custom }).reverse()
    const book = listedQuotes.filter(function(quote) { return !quote.custom })
    const source = quoteSource === "mine" ? mine : quoteSource === "stoics" ? book : mine.concat(book)
    return source.filter(function(quote) {
      if (quoteState === "on" && !quote.on) return false
      if (quoteState === "off" && quote.on) return false
      return needle === "" || (quote.text + " " + quote.name + " " + quote.citation).toLowerCase().indexOf(needle) !== -1
    })
  }
  property string busyLabel: ""
  readonly property bool busy: busyLabel !== ""
  property string error: ""
  property string notice: ""

  // Edits, written only when Save is pressed.
  property var selectedAuthors: []
  property int interval: 60
  property string newAuthor: "marcus"
  property string newCitation: ""
  property string newText: ""

  readonly property bool quoteStarted: newCitation.trim() !== "" || newText.trim() !== ""
  // The quote file keys authors by slug; a name like "Tomas Sowell" becomes tomas-sowell.
  // A Stoic's full name maps to that Stoic's slug.
  readonly property string authorSlug: {
    const typed = newAuthor.trim().toLowerCase()
    const stoic = roster.find(function(author) { return String(author.name).toLowerCase() === typed })
    return stoic ? stoic.slug : slugOf(typed)
  }
  function slugOf(typed) { return typed.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64) }
  readonly property bool quoteReady: authorSlug !== "" && newCitation.trim() !== "" && newText.trim() !== ""

  readonly property var allSlugs: roster.map(function(author) { return author.slug })
  readonly property bool allPicked: roster.length > 0 && allSlugs.every(function(slug) { return selectedAuthors.indexOf(slug) !== -1 })

  // Why Save would be refused, or "" when it can go. An empty pick is not
  // "all": the CLI reads an empty list as every Stoic, so the panel never sends one.
  readonly property string blocker: {
    var missing = []
    if (selectedAuthors.length === 0 && !quotes.some(function(quote) { return quote.custom && quote.kept }))
      return "Pick a Stoic, or switch on one of your own quotes to rotate only yours."
    if (quoteStarted && !quoteReady) {
      if (authorSlug === "") missing.push("author")
      if (newCitation.trim() === "") missing.push("citation")
      if (newText.trim() === "") missing.push("quote text")
      return "Your quote needs " + missing.join(" and ") + ", or clear it to save without one."
    }
    return ""
  }

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
    if (busy) return
    busyLabel = "Loading…"
    error = ""
    resetRun(stateRun)
    stateProcess.running = true
  }

  // A run is done once it has exited and both streams have been read;
  // Quickshell does not promise the order. Only a failed run shows its stderr:
  // a successful one may still warn there (an unreadable settings file, say).
  function resetRun(run) {
    run.exited = false
    run.exitCode = 0
    run.stdout = ""
    run.stderr = ""
    run.streamsLeft = 2
  }

  function settleRun(run, fallback) {
    if (!run.exited || run.streamsLeft > 0) return
    busyLabel = ""
    if (run.exitCode !== 0) error = run.stderr.trim() !== "" ? run.stderr.trim() : fallback
    else error = (run.quotesOnly ? adoptQuotes(run.stdout) : adoptState(run.stdout)) ? "" : "Could not read the omastoic state."
    if (run.quotesOnly) {
      if (run.exitCode !== 0) flip(run.keptId, !run.keptOn)
      return
    }
    if (run === applyRun && error === "") notice = run.addedQuote ? "Saved. Your quote is at the top of the quote list and in rotation." : "Saved."
  }

  function clearNotice() {
    if (!busy) notice = ""
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
      return false
    }
    if (!parsed || typeof parsed !== "object") return false
    var saved = parsed.settings && parsed.settings.authors instanceof Array ? parsed.settings.authors : []
    settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : ({})
    roster = parsed.authors instanceof Array ? parsed.authors : []
    summary = String(parsed.summary || "")
    customQuotes = Number(parsed.customQuotes) || 0
    quotes = parsed.quotes instanceof Array ? parsed.quotes : []
    interval = Number(settings.interval) || 60
    newCitation = ""
    newText = ""
    if (roster.length && newAuthor.trim() === "")
      newAuthor = roster[0].slug

    setAuthors(parsed.mineOnly ? [] : saved.length ? saved.slice() : allSlugs)
    secondsField.field.value = interval
    authorField.text = newAuthor
    citationField.text = ""
    textField.text = ""
    return true
  }

  // A switch saves at once and refreshes only the quote list and summary, so
  // unsaved edits elsewhere in the panel stay as typed.
  function adoptQuotes(text) {
    var parsed
    try {
      parsed = JSON.parse(String(text || ""))
    } catch (failure) {
      return false
    }
    if (!parsed || !(parsed.quotes instanceof Array)) return false
    quotes = parsed.quotes
    summary = String(parsed.summary || "")
    return true
  }

  function flip(id, on) {
    quotes = quotes.map(function(quote) { return quote.id === id ? Object.assign({}, quote, { kept: on }) : quote })
  }

  function keep(id, on) {
    if (busy) return
    const change = {}
    change[id] = on
    // Flip the row now; the echoed state confirms it, or a failure flips it back.
    flip(id, on)
    busyLabel = "Saving…"
    error = ""
    notice = ""
    resetRun(applyRun)
    applyRun.addedQuote = false
    applyRun.quotesOnly = true
    applyRun.keptId = id
    applyRun.keptOn = on
    applyProcess.command = [command, "panel", "apply", JSON.stringify({ keep: change })]
    applyProcess.running = true
  }

  function toggleAll() {
    setAuthors(allPicked ? [] : allSlugs)
  }

  function save() {
    if (busy || blocker !== "") return
    // Nobody picked means only your own quotes; an empty list would mean every Stoic.
    var payload = selectedAuthors.length
      ? { interval: interval, authors: selectedAuthors, mineOnly: false }
      : { interval: interval, mineOnly: true }
    if (quoteReady) {
      payload.addQuote = { author: authorSlug, citation: newCitation, text: newText }
    }
    busyLabel = "Saving…"
    error = ""
    notice = ""
    resetRun(applyRun)
    applyRun.quotesOnly = false
    applyRun.addedQuote = quoteReady
    applyProcess.command = [command, "panel", "apply", JSON.stringify(payload)]
    applyProcess.running = true
  }

  QtObject {
    id: stateRun
    property bool exited: false
    property int exitCode: 0
    property string stdout: ""
    property string stderr: ""
    property int streamsLeft: 0
  }

  QtObject {
    id: applyRun
    property bool addedQuote: false
    property bool quotesOnly: false
    property string keptId: ""
    property bool keptOn: false
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
      onStreamFinished: { stateRun.stdout = String(text || ""); stateRun.streamsLeft--; root.settleRun(stateRun, "omastoic panel state failed.") }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { stateRun.stderr = String(text || ""); stateRun.streamsLeft--; root.settleRun(stateRun, "omastoic panel state failed.") }
    }
    onExited: function(exitCode) {
      stateRun.exitCode = exitCode
      stateRun.exited = true
      root.settleRun(stateRun, "omastoic panel state failed.")
    }
  }

  Process {
    id: applyProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: { applyRun.stdout = String(text || ""); applyRun.streamsLeft--; root.settleRun(applyRun, "omastoic panel apply failed.") }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: { applyRun.stderr = String(text || ""); applyRun.streamsLeft--; root.settleRun(applyRun, "omastoic panel apply failed.") }
    }
    onExited: function(exitCode) {
      applyRun.exitCode = exitCode
      applyRun.exited = true
      root.settleRun(applyRun, "omastoic panel apply failed.")
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
            detail: root.busy ? root.busyLabel : "Screensaver settings"
            foreground: Commons.Color.popups.text
          }

          PanelSeparator { foreground: Commons.Color.popups.text }

          PanelSectionHeader {
            text: "In rotation"
            foreground: Commons.Color.popups.text
          }

          Toggle {
            width: parent.width
            label: root.roster.length ? "All " + root.roster.length + " Stoics" : "All Stoics"
            description: "Off keeps only the Stoics picked below."
            checked: root.allPicked
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
            noSelectionText: "None: only your own quotes"
            onChanged: function(values) { root.selectedAuthors = values; root.clearNotice() }
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
            text: "All quotes · " + root.quotes.length + ", " + root.rotatingCount + " in rotation" + (root.picksChanged ? " after Save" : "")
            foreground: Commons.Color.popups.text
          }

          ButtonGroup {
            id: sourceTags
            value: root.quoteSource
            options: [
              { value: "all", label: "All " + root.quotes.length },
              { value: "stoics", label: "Stoics " + (root.quotes.length - root.mineCount) },
              { value: "mine", label: "Mine " + root.mineCount }
            ]
            foreground: Commons.Color.popups.text
            background: Commons.Color.popups.background
            fontSize: Style.font.bodySmall
            onChanged: function(value) { root.quoteSource = value }
          }

          ButtonGroup {
            id: stateTags
            value: root.quoteState
            options: [
              { value: "any", label: "On and off" },
              { value: "on", label: "On " + root.rotatingCount },
              { value: "off", label: "Off " + (root.quotes.length - root.rotatingCount) }
            ]
            foreground: Commons.Color.popups.text
            background: Commons.Color.popups.background
            fontSize: Style.font.bodySmall
            onChanged: function(value) { root.quoteState = value }
          }

          TextField {
            id: filterField
            width: parent.width
            placeholderText: "Search quotes, authors or citations"
            foreground: Commons.Color.popups.text
            onTextChanged: root.quoteFilter = text
          }

          ListView {
            id: quoteView
            width: parent.width
            height: Style.space(240)
            clip: true
            spacing: Style.space(10)
            boundsBehavior: Flickable.StopAtBounds
            model: root.shownQuotes
            delegate: Item {
              id: quoteRow
              required property var modelData
              width: quoteView.width
              height: Math.max(quoteSwitch.height, quoteText.height)

              ToggleSwitch {
                id: quoteSwitch
                anchors.right: parent.right
                anchors.top: parent.top
                checked: quoteRow.modelData.kept
                busy: root.busy
                visible: quoteRow.modelData.switchable
                foreground: Commons.Color.popups.text
                onToggled: root.keep(quoteRow.modelData.id, !quoteRow.modelData.kept)
              }

              Column {
                id: quoteText
                anchors.left: parent.left
                anchors.right: quoteSwitch.left
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(2)
                opacity: quoteRow.modelData.on ? 1 : 0.45
                Text {
                  width: parent.width
                  text: "“" + quoteRow.modelData.text + "”"
                  color: Commons.Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }
                Text {
                  width: parent.width
                  text: "— " + quoteRow.modelData.name + ", " + quoteRow.modelData.citation
                    + (quoteRow.modelData.custom ? " · yours" : "")
                    + (quoteRow.modelData.on ? "" : quoteRow.modelData.kept ? " · Stoic not picked" : " · off")
                  color: Qt.darker(Commons.Color.popups.text, 1.4)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideRight
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: root.shownQuotes.length === 0
            text: !root.quotes.length ? "No quotes loaded yet."
              : root.quoteSource === "mine" && root.mineCount === 0 ? "No quotes of your own yet. Add one below."
              : "No quote matches these filters."
            color: Qt.darker(Commons.Color.popups.text, 1.4)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          PanelSeparator { foreground: Commons.Color.popups.text }

          PanelSectionHeader {
            text: "Your own quote" + (root.customQuotes > 0 ? " · " + root.customQuotes + " added" : "")
            foreground: Commons.Color.popups.text
          }

          TextField {
            id: authorField
            width: parent.width
            placeholderText: "Author, for example marcus or Tomas Sowell"
            text: "marcus"
            foreground: Commons.Color.popups.text
            onTextChanged: { root.newAuthor = text; root.clearNotice() }
          }

          TextField {
            id: citationField
            width: parent.width
            placeholderText: "Citation, for example Meditations IX.1"
            foreground: Commons.Color.popups.text
            onTextChanged: { root.newCitation = text; root.clearNotice() }
          }

          TextField {
            id: textField
            width: parent.width
            placeholderText: "The line itself"
            foreground: Commons.Color.popups.text
            onTextChanged: { root.newText = text; root.clearNotice() }
          }

          Row {
            spacing: Style.space(10)

            Button {
              text: "Save"
              bordered: true
              enabled: !root.busy && root.blocker === ""
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
            visible: root.error === "" && root.notice !== ""
            text: root.notice
            color: Commons.Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: root.error === "" && root.notice === "" && root.blocker !== ""
            text: root.blocker
            color: Qt.darker(Commons.Color.popups.text, 1.4)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
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
