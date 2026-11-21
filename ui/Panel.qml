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
  property real portraitLine: 11.2
  property var custom: []
  property bool intervalApplied: true
  property bool adopting: false
  property bool saving: false
  property bool applyQueued: false
  property var pendingQuote: null
  property var pendingAuthor: null
  property var pendingReplaceAuthor: null
  property bool addingAuthor: false
  property bool replacingAuthor: false
  property string pendingRemove: ""
  property string pendingRemoveAuthor: ""
  property string confirmRemoveAuthor: ""
  property string editingAuthorSlug: ""
  property string editingAuthorOrigName: ""
  property string editingAuthorOrigDates: ""
  property string notice: ""
  property string error: ""
  property bool quoteOpen: false
  onQuoteOpenChanged: if (quoteOpen) Qt.callLater(function() { root.reveal(quoteForm) })
  property bool authorOpen: false
  onAuthorOpenChanged: if (authorOpen) Qt.callLater(function() { root.reveal(authorForm) })
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
  property string newAuthorName: ""
  property string newAuthorSlug: ""
  property bool authorSlugEdited: false
  property string newAuthorDates: ""
  property string newAuthorImage: ""
  property string newAuthorCitation: ""
  property string newAuthorText: ""

  readonly property bool quoteReady: newAuthor !== "" && newCitation.trim() !== "" && newText.trim() !== ""
  readonly property bool authorReady: editingAuthorSlug !== ""
    ? (
        newAuthorName.trim() !== "" &&
        ((newAuthorCitation.trim() === "") === (newAuthorText.trim() === "")) &&
        (
          newAuthorName.trim() !== editingAuthorOrigName ||
          newAuthorDates.trim() !== editingAuthorOrigDates ||
          newAuthorImage.trim() !== "" ||
          (newAuthorCitation.trim() !== "" && newAuthorText.trim() !== "")
        )
      )
    : (
        newAuthorSlug.trim() !== "" &&
        newAuthorName.trim() !== "" &&
        newAuthorImage.trim() !== "" &&
        newAuthorCitation.trim() !== "" &&
        newAuthorText.trim() !== ""
      )
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
  // The roster dates sit on the selected-row accent wash (0.16). `quiet` at
  // 0.88 drops below 4.5:1 over that wash in Catppuccin Latte, so the dates get
  // a stronger ink that still reads quieter than the author's name.
  readonly property color dates: Qt.rgba(ink.r, ink.g, ink.b, 0.92)

  function open(payloadJson) {
    opened = true
    quoteOpen = false
    authorOpen = false
    listOpen = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    pendingReplaceAuthor = null
    pendingRemoveAuthor = ""
    confirmRemoveAuthor = ""
    reload()
    Qt.callLater(function() { if (root.opened) previewButton.takeFocus() })
  }

  function slugFromName(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
  }

  function close() {
    opened = false
    confirmRemoveAuthor = ""
  }

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
      pendingAuthor = null
      pendingReplaceAuthor = null
      pendingQuote = null
      pendingRemove = ""
      pendingRemoveAuthor = ""
      confirmRemoveAuthor = ""
      Qt.callLater(function() { root.reveal(statusSlot) })
    } else {
      error = ""
      notice = saving ? "Saved" : ""
      if (saving) savedTimer.restart()
    }
    saving = false
    addingAuthor = false
    replacingAuthor = false
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
    confirmRemoveAuthor = ""
    var saved = parsed.settings && parsed.settings.authors instanceof Array ? parsed.settings.authors : []
    settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : ({})
    samples = parsed.samples instanceof Array ? parsed.samples : []
    portraitFont = Number(parsed.portraitFont) || 8
    portraitLine = Number(parsed.portraitLine) || 11.2
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
    if (addingAuthor || replacingAuthor) {
      authorOpen = false
      authorSlugEdited = false
      editingAuthorSlug = ""
      editingAuthorOrigName = ""
      editingAuthorOrigDates = ""
      authorNameField.text = ""
      authorSlugField.text = ""
      authorDatesField.text = ""
      authorImageField.text = ""
      authorCitationField.text = ""
      authorTextField.text = ""
    } else if (editingAuthorSlug !== "" && !samples.some(function(author) { return author.slug === root.editingAuthorSlug })) {
      closeAuthorForm()
    }
    if (secondsField.field) secondsField.field.value = interval
    adopting = false
    return true
  }

  function toggleAuthor(slug) {
    confirmRemoveAuthor = ""
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
      notice = "Pick at least one author."
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
      notice = "Pick at least one author."
      return
    }
    if (busy) { applyQueued = true; return }
    var payload = {}
    if (pendingAuthor) {
      payload.addAuthor = pendingAuthor
      if (selectedAuthors.join(",") !== committedAuthors.join(",")) payload.authors = selectedAuthors
      if (intervalApplied && interval !== committedInterval) payload.interval = interval
      pendingAuthor = null
      addingAuthor = true
      if (pendingReplaceAuthor || pendingRemoveAuthor !== "" || pendingRemove !== "" || pendingQuote) applyQueued = true
    } else if (pendingReplaceAuthor) {
      payload.replaceAuthor = pendingReplaceAuthor
      if (selectedAuthors.join(",") !== committedAuthors.join(",")) payload.authors = selectedAuthors
      if (intervalApplied && interval !== committedInterval) payload.interval = interval
      pendingReplaceAuthor = null
      replacingAuthor = true
      if (pendingRemoveAuthor !== "" || pendingRemove !== "" || pendingQuote) applyQueued = true
    } else if (pendingRemoveAuthor !== "") {
      var removeSlug = pendingRemoveAuthor
      payload.removeAuthor = removeSlug
      var nextWithoutRemoved = selectedAuthors.filter(function(slug) { return slug !== removeSlug })
      var committedWithoutRemoved = committedAuthors.filter(function(slug) { return slug !== removeSlug })
      if (nextWithoutRemoved.length > 0 && nextWithoutRemoved.join(",") !== committedWithoutRemoved.join(",")) {
        payload.authors = nextWithoutRemoved
      }
      if (intervalApplied && interval !== committedInterval) payload.interval = interval
      pendingRemoveAuthor = ""
      if (pendingRemove !== "" || pendingQuote) applyQueued = true
    } else {
      payload.authors = selectedAuthors
      if (intervalApplied) payload.interval = interval
      if (pendingRemove !== "") {
        payload.removeQuote = pendingRemove
        pendingRemove = ""
        if (pendingQuote) applyQueued = true
      } else if (pendingQuote) {
        payload.addQuote = pendingQuote
        pendingQuote = null
      }
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
      error = ""
      notice = "A quote needs a citation and the words."
      Qt.callLater(function() { root.reveal(statusSlot) })
      return
    }
    pendingQuote = { author: newAuthor, citation: newCitation.trim(), text: newText.trim() }
    quoteOpen = false
    applyNow()
  }

  function openAddAuthor() {
    confirmRemoveAuthor = ""
    if (authorOpen && editingAuthorSlug === "") {
      authorOpen = false
      return
    }
    quoteOpen = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    authorSlugEdited = false
    authorNameField.text = ""
    authorSlugField.text = ""
    authorDatesField.text = ""
    authorImageField.text = ""
    authorCitationField.text = ""
    authorTextField.text = ""
    authorOpen = true
    Qt.callLater(function() { root.reveal(authorForm) })
  }

  function startEditAuthor(author) {
    confirmRemoveAuthor = ""
    if (authorOpen && editingAuthorSlug === author.slug) {
      closeAuthorForm()
      return
    }
    quoteOpen = false
    editingAuthorSlug = author.slug
    editingAuthorOrigName = author.name
    editingAuthorOrigDates = author.dates
    authorSlugEdited = true
    authorNameField.text = author.name
    authorSlugField.text = author.slug
    authorDatesField.text = author.dates
    authorImageField.text = ""
    authorCitationField.text = ""
    authorTextField.text = ""
    authorOpen = true
    Qt.callLater(function() { root.reveal(authorForm) })
  }

  function closeAuthorForm() {
    authorOpen = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
  }

  function addAuthor() {
    submitAuthor()
  }

  function submitAuthor() {
    if (root.busy) return
    if (editingAuthorSlug !== "") {
      if (newAuthorName.trim() === "") {
        error = ""
        notice = "An author needs a name."
        Qt.callLater(function() { root.reveal(statusSlot) })
        return
      }
      var hasCite = newAuthorCitation.trim() !== ""
      var hasWords = newAuthorText.trim() !== ""
      if (hasCite !== hasWords) {
        error = ""
        notice = "A quote needs a citation and the words."
        Qt.callLater(function() { root.reveal(statusSlot) })
        return
      }
      var patch = { slug: editingAuthorSlug }
      var changed = false
      if (newAuthorName.trim() !== editingAuthorOrigName) {
        patch.name = newAuthorName.trim()
        changed = true
      }
      if (newAuthorDates.trim() !== editingAuthorOrigDates) {
        patch.dates = newAuthorDates.trim()
        changed = true
      }
      if (newAuthorImage.trim() !== "") {
        patch.image = newAuthorImage.trim()
        changed = true
      }
      if (hasCite && hasWords) {
        patch.citation = newAuthorCitation.trim()
        patch.text = newAuthorText.trim()
        changed = true
      }
      if (!changed) {
        error = ""
        notice = "Change the portrait, name, dates, or quote first."
        Qt.callLater(function() { root.reveal(statusSlot) })
        return
      }
      applyTimer.stop()
      pendingReplaceAuthor = patch
      applyNow()
      return
    }
    if (!authorReady) {
      error = ""
      notice = "An author needs a name, id, image, citation and quote."
      Qt.callLater(function() { root.reveal(statusSlot) })
      return
    }
    applyTimer.stop()
    pendingAuthor = {
      slug: newAuthorSlug.trim(),
      name: newAuthorName.trim(),
      dates: newAuthorDates.trim(),
      image: newAuthorImage.trim(),
      citation: newAuthorCitation.trim(),
      text: newAuthorText.trim(),
    }
    applyNow()
  }

  function requestRemoveAuthor(slug) {
    if (root.busy) return
    if (confirmRemoveAuthor !== slug) {
      confirmRemoveAuthor = slug
      return
    }
    confirmRemoveAuthor = ""
    removeAuthor(slug)
  }

  function removeAuthor(slug) {
    if (root.busy) return
    confirmRemoveAuthor = ""
    if (editingAuthorSlug === slug) closeAuthorForm()
    applyTimer.stop()
    pendingRemoveAuthor = slug
    applyNow()
  }

  function removeQuote(id) {
    confirmRemoveAuthor = ""
    pendingRemove = id
    applyNow()
  }

  component RingButton: Item {
    id: host
    property string label: ""
    property bool picked: false
    property bool available: true
    signal activated()
    implicitWidth: labelText.implicitWidth + Style.space(28)
    implicitHeight: labelText.implicitHeight + Style.space(16)
    opacity: available ? 1 : 0.45
    // Do not name this `focus`. Item already has a `focus` property, and a
    // method of the same name does not shadow it, so `.focus()` would throw.
    function takeFocus() { inner.forceActiveFocus() }
    HoverHandler {
      id: buttonHover
      cursorShape: host.available ? Qt.PointingHandCursor : Qt.ArrowCursor
    }
    Button {
      id: inner
      anchors.fill: parent
      text: ""
      selected: false
      enabled: host.available
      focusable: true
      bordered: true
      foreground: root.ink
      onClicked: host.activated()
      onActiveFocusChanged: if (activeFocus) root.reveal(host)
    }
    Rectangle {
      anchors.fill: inner
      anchors.margins: -2
      z: 1
      enabled: false
      color: host.picked
        ? Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.25)
        : (buttonHover.hovered && host.available ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08) : "transparent")
      radius: Style.cornerRadius
      border.width: inner.activeFocus ? 2 : (buttonHover.hovered && host.available ? 1 : 0)
      border.color: inner.activeFocus ? Commons.Color.accent : root.ink
    }
    Text {
      id: labelText
      z: 3
      anchors.centerIn: parent
      width: Math.min(implicitWidth, Math.max(0, host.width - Style.space(16)))
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideRight
      text: host.label
      color: root.ink
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
    MouseArea {
      anchors.fill: parent
      z: 4
      enabled: !host.available
      hoverEnabled: true
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
      Keys.onEscapePressed: {
        if (root.confirmRemoveAuthor !== "") {
          root.confirmRemoveAuthor = ""
          return
        }
        root.dismiss()
      }
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
        MouseArea { anchors.fill: parent; onClicked: root.confirmRemoveAuthor = "" }

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
                spacing: Style.space(6)

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
                      root.confirmRemoveAuthor = ""
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
                  height: Math.max(Style.font.body * 1.35 * 3, quotePreviewText.implicitHeight)
                  clip: true
                  Text {
                    id: quotePreviewText
                    width: parent.width
                    anchors.verticalCenter: quoteSlot.verticalCenter
                    text: root.preview ? (root.preview.text !== "" ? root.preview.text : "No quotes yet.") : "Pick at least one author."
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    lineHeight: 1.35
                    wrapMode: Text.WordWrap
                    maximumLineCount: 3
                    elide: Text.ElideRight
                  }
                }
                Text {
                  width: parent.width
                  visible: root.preview !== null
                  text: root.preview ? (root.preview.citation !== "" ? (root.preview.name + ", " + root.preview.citation) : root.preview.name) : ""
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
                id: authorRow
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

                MouseArea {
                  id: rowPress
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleAuthor(modelData.slug)
                }

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
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.max(0, parent.width - Style.space(32) - (customActions.visible ? customActions.implicitWidth : 0))
                    Text {
                      width: parent.width
                      elide: Text.ElideRight
                      text: modelData.name
                      color: root.ink
                      font.family: Style.font.family
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      width: parent.width
                      elide: Text.ElideRight
                      visible: modelData.dates !== ""
                      text: modelData.dates
                      color: root.dates
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                  }
                  Row {
                    id: customActions
                    visible: modelData.custom === true
                    spacing: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    RingButton {
                      label: "Edit"
                      picked: root.authorOpen && root.editingAuthorSlug === modelData.slug
                      available: !root.busy
                      onActivated: root.startEditAuthor(modelData)
                    }
                    RingButton {
                      label: root.confirmRemoveAuthor === modelData.slug ? "Remove?" : "Remove"
                      picked: root.confirmRemoveAuthor === modelData.slug
                      available: !root.busy
                      onActivated: root.requestRemoveAuthor(modelData.slug)
                    }
                  }
                }

                Keys.onPressed: function(event) {
                  if (!authorRow.activeFocus) return
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
                onModified: function(value) { root.confirmRemoveAuthor = ""; root.interval = value; root.scheduleApply() }
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

            Row {
              width: parent.width
              spacing: Style.space(8)
              RingButton {
                label: root.quoteOpen ? "Close" : "Add your own quote"
                onActivated: {
                  root.confirmRemoveAuthor = ""
                  root.quoteOpen = !root.quoteOpen
                  if (root.quoteOpen) root.authorOpen = false
                }
              }
              RingButton {
                label: (root.authorOpen && root.editingAuthorSlug === "") ? "Close" : "Add an author"
                onActivated: root.openAddAuthor()
              }
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
                id: authorGrid
                width: parent.width
                columns: 3
                rowSpacing: Style.space(6)
                columnSpacing: Style.space(6)
                Repeater {
                  id: authorChips
                  model: root.samples
                  delegate: RingButton {
                    required property var modelData
                    required property int index
                    property int chipIndex: index
                    width: Math.floor((authorGrid.width - Style.space(12)) / 3)
                    label: modelData.name
                    picked: root.newAuthor === modelData.slug
                    onActivated: root.newAuthor = modelData.slug
                    Keys.onPressed: function(event) {
                      var key = event.key
                      if (key !== Qt.Key_Left && key !== Qt.Key_Right && key !== Qt.Key_Up && key !== Qt.Key_Down) return
                      event.accepted = true
                      var columns = authorGrid.columns
                      var target = -1
                      if (key === Qt.Key_Left && chipIndex % columns > 0) target = chipIndex - 1
                      else if (key === Qt.Key_Right && chipIndex % columns < columns - 1) target = chipIndex + 1
                      else if (key === Qt.Key_Up) target = chipIndex - columns
                      else if (key === Qt.Key_Down) target = chipIndex + columns
                      if (target >= 0 && target < root.samples.length) {
                        var chip = authorChips.itemAt(target)
                        if (chip) chip.takeFocus()
                      }
                    }
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

            Column {
              id: authorForm
              width: parent.width
              visible: root.authorOpen
              spacing: Style.space(8)

              Text {
                visible: root.editingAuthorSlug !== ""
                text: "Update " + root.editingAuthorOrigName
                color: root.ink
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                text: "Name"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: authorNameField.implicitHeight
                TextField {
                  id: authorNameField
                  width: parent.width
                  placeholderText: "Musonius Rufus"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: {
                    root.newAuthorName = text
                    if (!root.authorSlugEdited) {
                      var suggested = root.slugFromName(text)
                      if (authorSlugField.text !== suggested) authorSlugField.text = suggested
                    }
                  }
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorNameField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: authorNameField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                visible: root.editingAuthorSlug === ""
                text: "Short id"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                visible: root.editingAuthorSlug === ""
                width: parent.width
                height: authorSlugField.implicitHeight
                TextField {
                  id: authorSlugField
                  width: parent.width
                  placeholderText: "musonius"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: {
                    root.newAuthorSlug = text
                    if (activeFocus) root.authorSlugEdited = text.trim() !== ""
                  }
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorSlugField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: authorSlugField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                text: "Dates (optional)"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: authorDatesField.implicitHeight
                TextField {
                  id: authorDatesField
                  width: parent.width
                  placeholderText: "c. AD 30 – 100"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: root.newAuthorDates = text
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorDatesField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: authorDatesField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                text: root.editingAuthorSlug !== "" ? "New portrait image (optional, JPEG or PNG)" : "Portrait image (JPEG or PNG)"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: authorImageField.implicitHeight
                TextField {
                  id: authorImageField
                  width: parent.width
                  placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current portrait" : "/path/to/portrait.png"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: root.newAuthorImage = text
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorImageField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: authorImageField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                text: root.editingAuthorSlug !== "" ? "Replacement citation (optional)" : "Citation"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: authorCitationField.implicitHeight
                TextField {
                  id: authorCitationField
                  width: parent.width
                  placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current quotes" : "Lectures VI"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: root.newAuthorCitation = text
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorCitationField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: authorCitationField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Text {
                text: root.editingAuthorSlug !== "" ? "Replacement quote (optional)" : "Quote"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Item {
                width: parent.width
                height: authorTextField.implicitHeight
                TextField {
                  id: authorTextField
                  width: parent.width
                  placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current quotes" : "The line itself"
                  placeholderTextColor: root.hint
                  foreground: root.ink
                  onTextChanged: root.newAuthorText = text
                  Keys.onReturnPressed: if (!root.busy) root.submitAuthor()
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorTextField)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: authorTextField.activeFocus ? 2 : 0
                  border.color: Commons.Color.accent
                }
              }
              Row {
                spacing: Style.space(8)
                RingButton {
                  label: root.editingAuthorSlug !== "" ? "Replace author" : "Add author"
                  available: root.authorReady && !root.busy
                  onActivated: root.submitAuthor()
                }
                RingButton {
                  visible: root.editingAuthorSlug !== ""
                  label: "Cancel"
                  onActivated: root.closeAuthorForm()
                }
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
              id: statusSlot
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
