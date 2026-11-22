pragma ComponentBehavior: Bound
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
  property bool addingQuote: false
  property string pendingRemove: ""
  property string pendingRemoveAuthor: ""
  property string confirmRemoveAuthor: ""
  property string editingAuthorSlug: ""
  property string editingAuthorOrigName: ""
  property string editingAuthorOrigDates: ""
  property string notice: ""
  property string error: ""
  property string errorScope: ""
  property string authorListHint: ""
  property bool quoteOpen: false
  onQuoteOpenChanged: if (quoteOpen) root.revealAfterLayout(quoteForm, quoteForm, citationField)
  property bool authorOpen: false
  onAuthorOpenChanged: if (authorOpen) root.revealAfterLayout(authorForm, authorForm, authorNameField)
  property bool listOpen: false
  property real formReturnContentY: 0
  property bool hasFormReturnY: false
  property int formScrollSeq: 0
  readonly property bool busy: notice === "Loading…" || notice === "Saving…"
  readonly property bool errorShownInStatus: error !== "" && (errorScope === "" || (errorScope === "author" && !authorOpen) || (errorScope === "quote" && !quoteOpen))
  readonly property string statusText: errorShownInStatus ? error : notice

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
  property bool authorAdvancedOpen: false
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
        (newAuthorSlug.trim() !== "" || !authorAdvancedOpen) &&
        newAuthorName.trim() !== "" &&
        newAuthorImage.trim() !== "" &&
        newAuthorCitation.trim() !== "" &&
        newAuthorText.trim() !== ""
      )
  readonly property var preview: {
    for (let i = 0; i < samples.length; i++) {
      if (selectedAuthors.indexOf(samples[i].slug) !== -1) return samples[i]
    }
    return null
  }
  readonly property bool hasPortrait: preview !== null && /[^\s\u2800]/.test(String(preview.portrait || ""))
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
    hasLocalSize = sizeProcess.running || pendingSizePayload !== ""
    resizing = false
    quoteOpen = false
    authorOpen = false
    authorAdvancedOpen = false
    listOpen = false
    hasFormReturnY = false
    formReturnContentY = 0
    scroller.contentY = 0
    error = ""
    errorScope = ""
    authorListHint = ""
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
    resizing = false
    hasFormReturnY = false
    error = ""
    errorScope = ""
    authorListHint = ""
    confirmRemoveAuthor = ""
  }

  function captureFormReturnY() {
    if (!hasFormReturnY) {
      formReturnContentY = scroller.contentY
      hasFormReturnY = true
    }
  }

  function restoreFormReturnY() {
    if (!hasFormReturnY) return
    var target = formReturnContentY
    hasFormReturnY = false
    formScrollSeq++
    var seq = formScrollSeq
    var clampAndSet = function() {
      if (seq !== root.formScrollSeq || root.authorOpen || root.quoteOpen) return
      content.forceLayout()
      var maxY = Math.max(0, scroller.contentHeight - scroller.height)
      scroller.contentY = Math.max(0, Math.min(target, maxY))
    }
    clampAndSet()
    Qt.callLater(clampAndSet)
  }

  function reveal(item) {
    if (!item) return
    var pos = item.mapToItem(scroller.contentItem, 0, 0)
    var top = pos.y
    var bottom = pos.y + item.height
    if (top < scroller.contentY) scroller.contentY = Math.max(0, top - 8)
    else if (bottom > scroller.contentY + scroller.height) scroller.contentY = Math.max(0, bottom - scroller.height + 8)
  }

  function revealAfterLayout(form, first, second) {
    formScrollSeq++
    var seq = formScrollSeq
    var syncAndReveal = function() {
      if (seq !== root.formScrollSeq) return
      if (form === quoteForm) authorGrid.forceLayout()
      if (form && typeof form.forceLayout === "function") form.forceLayout()
      content.forceLayout()
      if (first) root.reveal(first)
      if (second) root.reveal(second)
    }
    syncAndReveal()
    Qt.callLater(syncAndReveal)
  }

  function portraitFullyVisible(top, height, contentY, viewport) {
    return top >= contentY - 0.5 && top + height <= contentY + viewport + 0.5
  }

  function dismiss() {
    confirmRemoveAuthor = ""
    if (shell && typeof shell.hide === "function") shell.hide(root.pluginId)
    else close()
  }

  function reload() {
    if (notice === "Saving…") return
    saving = false
    error = ""
    errorScope = ""
    authorListHint = ""
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
      if ((addingAuthor || replacingAuthor) && authorOpen) {
        errorScope = "author"
      } else if (addingQuote && quoteOpen) {
        errorScope = "quote"
      } else {
        errorScope = ""
      }
      if (errorScope === "author" && editingAuthorSlug === "" && /\b(?:slug|bundled author|already exists|reserved)\b/i.test(error)) {
        authorAdvancedOpen = true
      }
      applyQueued = false
      pendingAuthor = null
      pendingReplaceAuthor = null
      pendingQuote = null
      pendingRemove = ""
      pendingRemoveAuthor = ""
      confirmRemoveAuthor = ""
      if (errorScope === "author") {
        root.revealAfterLayout(authorForm, authorErrorText, authorSubmitRow)
      } else if (errorScope === "quote") {
        root.revealAfterLayout(quoteForm, quoteErrorText, quoteSubmitRow)
      } else {
        root.revealAfterLayout(null, statusSlot, null)
      }
    } else {
      error = ""
      errorScope = ""
      notice = saving ? "Saved" : ""
      if (saving) savedTimer.restart()
    }
    saving = false
    addingAuthor = false
    replacingAuthor = false
    addingQuote = false
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
    authorListHint = ""
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
    for (let i = 0; i < samples.length; i++) {
      if (pool.indexOf(samples[i].slug) !== -1) slugs.push(samples[i].slug)
    }
    selectedAuthors = slugs
    committedAuthors = slugs.slice()
    committedInterval = interval
    if (samples.length && !samples.some(function(author) { return author.slug === root.newAuthor }))
      newAuthor = samples[0].slug
    if (addingQuote || !quoteOpen) {
      let closingQuote = addingQuote && quoteOpen
      quoteOpen = false
      citationField.text = ""
      textField.text = ""
      if (closingQuote) restoreFormReturnY()
    }
    if (addingAuthor || replacingAuthor) {
      authorOpen = false
      authorAdvancedOpen = false
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
      restoreFormReturnY()
    } else if (editingAuthorSlug !== "" && !samples.some(function(author) { return author.slug === root.editingAuthorSlug })) {
      closeAuthorForm()
    }
    if (secondsField.field) secondsField.field.value = interval
    if (!hasLocalSize && !resizing && !sizeProcess.running && pendingSizePayload === "") adoptPanelSize(parsed.panelSize)
    adopting = false
    return true
  }

  function toggleAuthor(slug) {
    confirmRemoveAuthor = ""
    var next = []
    var found = false
    for (let i = 0; i < samples.length; i++) {
      let id = samples[i].slug
      let on = selectedAuthors.indexOf(id) !== -1
      if (id === slug) on = !on
      if (on) next.push(id)
      if (id === slug) found = true
    }
    if (!found) return
    if (!next.length) {
      error = ""
      errorScope = ""
      authorListHint = "Pick at least one author."
      root.reveal(rotationHeaderRow)
      return
    }
    authorListHint = ""
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
    errorScope = ""
    applyTimer.restart()
  }

  function applyNow() {
    if (!opened) return
    commitInterval()
    if (!selectedAuthors.length) {
      error = ""
      errorScope = ""
      authorListHint = "Pick at least one author."
      root.reveal(rotationHeaderRow)
      return
    }
    authorListHint = ""
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
      let removeSlug = pendingRemoveAuthor
      payload.removeAuthor = removeSlug
      let nextWithoutRemoved = selectedAuthors.filter(function(slug) { return slug !== removeSlug })
      let committedWithoutRemoved = committedAuthors.filter(function(slug) { return slug !== removeSlug })
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
        addingQuote = true
      }
    }
    saving = true
    error = ""
    errorScope = ""
    notice = "Saving…"
    resetRun(applyRun)
    applyProcess.command = [command, "panel", "apply", JSON.stringify(payload)]
    applyProcess.running = true
  }

  function toggleQuoteForm() {
    confirmRemoveAuthor = ""
    error = ""
    errorScope = ""
    authorListHint = ""
    if (quoteOpen) {
      closeQuoteForm()
      return
    }
    captureFormReturnY()
    authorOpen = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    quoteOpen = true
    root.revealAfterLayout(quoteForm, quoteForm, citationField)
  }

  function closeQuoteForm() {
    quoteOpen = false
    error = ""
    errorScope = ""
    keyCatcher.forceActiveFocus()
    restoreFormReturnY()
  }

  function addQuote() {
    if (!quoteReady) {
      notice = ""
      error = "A quote needs a citation and the words."
      errorScope = "quote"
      root.revealAfterLayout(quoteForm, quoteErrorText, quoteSubmitRow)
      return
    }
    pendingQuote = { author: newAuthor, citation: newCitation.trim(), text: newText.trim() }
    applyNow()
  }

  function openAddAuthor() {
    confirmRemoveAuthor = ""
    error = ""
    errorScope = ""
    authorListHint = ""
    if (authorOpen && editingAuthorSlug === "") {
      closeAuthorForm()
      return
    }
    captureFormReturnY()
    quoteOpen = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    authorSlugEdited = false
    authorAdvancedOpen = false
    authorNameField.text = ""
    authorSlugField.text = ""
    authorDatesField.text = ""
    authorImageField.text = ""
    authorCitationField.text = ""
    authorTextField.text = ""
    authorOpen = true
    root.revealAfterLayout(authorForm, authorForm, authorNameField)
  }

  function startEditAuthor(author) {
    confirmRemoveAuthor = ""
    error = ""
    errorScope = ""
    authorListHint = ""
    if (authorOpen && editingAuthorSlug === author.slug) {
      closeAuthorForm()
      return
    }
    captureFormReturnY()
    quoteOpen = false
    editingAuthorSlug = author.slug
    editingAuthorOrigName = author.name
    editingAuthorOrigDates = author.dates
    authorSlugEdited = true
    authorAdvancedOpen = false
    authorNameField.text = author.name
    authorSlugField.text = author.slug
    authorDatesField.text = author.dates
    authorImageField.text = ""
    authorCitationField.text = ""
    authorTextField.text = ""
    authorOpen = true
    root.revealAfterLayout(authorForm, authorForm, authorNameField)
  }

  function closeAuthorForm() {
    authorOpen = false
    authorAdvancedOpen = false
    error = ""
    errorScope = ""
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    keyCatcher.forceActiveFocus()
    restoreFormReturnY()
  }

  function addAuthor() {
    submitAuthor()
  }

  function submitAuthor() {
    if (root.busy) return
    if (editingAuthorSlug !== "") {
      if (newAuthorName.trim() === "") {
        notice = ""
        error = "An author needs a name."
        errorScope = "author"
        root.revealAfterLayout(authorForm, authorErrorText, authorSubmitRow)
        return
      }
      let hasCite = newAuthorCitation.trim() !== ""
      let hasWords = newAuthorText.trim() !== ""
      if (hasCite !== hasWords) {
        notice = ""
        error = "A quote needs a citation and the words."
        errorScope = "author"
        root.revealAfterLayout(authorForm, authorErrorText, authorSubmitRow)
        return
      }
      let patch = { slug: editingAuthorSlug }
      let changed = false
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
        notice = ""
        error = "Change the portrait, name, dates, or quote first."
        errorScope = "author"
        root.revealAfterLayout(authorForm, authorErrorText, authorSubmitRow)
        return
      }
      applyTimer.stop()
      pendingReplaceAuthor = patch
      applyNow()
      return
    }
    if (!authorReady || newAuthorSlug.trim() === "") {
      notice = ""
      error = newAuthorName.trim() !== "" && newAuthorSlug.trim() === ""
        ? "Use letters or numbers in the name, or set an Author id under Advanced."
        : "An author needs a name, portrait image, citation, and quote."
      errorScope = "author"
      if (newAuthorName.trim() !== "" && newAuthorSlug.trim() === "") authorAdvancedOpen = true
      root.revealAfterLayout(authorForm, authorErrorText, authorSubmitRow)
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
    property string sizeLabel: ""
    property bool picked: false
    property bool destructive: false
    property bool available: true
    property bool keepsRemoveConfirm: false
    signal activated()
    signal focusLost()
    implicitWidth: Math.max(labelText.implicitWidth, sizeProbe.implicitWidth) + Style.space(28)
    implicitHeight: labelText.implicitHeight + Style.space(16)
    opacity: available ? 1 : 0.45
    // Do not name this `focus`. Item already has a `focus` property, and a
    // method of the same name does not shadow it, so `.focus()` would throw.
    function takeFocus() { inner.forceActiveFocus() }
    Text {
      id: sizeProbe
      visible: false
      text: host.sizeLabel !== "" ? host.sizeLabel : host.label
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
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
      accent: host.destructive ? Commons.Color.urgent : Commons.Color.accent
      onClicked: {
        if (!host.keepsRemoveConfirm) root.confirmRemoveAuthor = ""
        host.activated()
      }
      onActiveFocusChanged: {
        if (activeFocus) root.reveal(host)
        else host.focusLost()
      }
    }
    Rectangle {
      id: ringChrome
      anchors.fill: inner
      anchors.margins: -2
      z: 1
      enabled: false
      color: host.destructive
        ? Qt.rgba(Commons.Color.urgent.r, Commons.Color.urgent.g, Commons.Color.urgent.b, 0.20)
        : (host.picked
          ? Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.25)
          : (buttonHover.hovered && host.available ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08) : "transparent"))
      radius: Style.cornerRadius
      border.width: host.destructive ? 2 : (inner.activeFocus ? 2 : (buttonHover.hovered && host.available ? 1 : 0))
      border.color: host.destructive ? Commons.Color.urgent : (inner.activeFocus ? Commons.Color.accent : root.ink)
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
      onClicked: if (!host.keepsRemoveConfirm) root.confirmRemoveAuthor = ""
    }
  }

  component QuoteArea: Item {
    id: area
    property alias text: edit.text
    property string placeholderText: ""
    readonly property bool editFocused: edit.activeFocus
    readonly property real contentHeight: edit.contentHeight
    readonly property real viewportHeight: areaScroll.height
    signal submitted()

    readonly property real lineStep: Math.ceil(Style.font.body * 1.35)
    readonly property real padY: Style.space(8)
    readonly property real padX: Style.space(10)
    readonly property real minAreaHeight: lineStep * 3 + padY * 2
    readonly property real maxAreaHeight: lineStep * 7 + padY * 2
    implicitHeight: Math.max(minAreaHeight, Math.min(maxAreaHeight, Math.ceil(edit.contentHeight) + padY * 2))
    height: implicitHeight

    function takeFocus() { edit.forceActiveFocus() }

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: Qt.rgba(root.ink.r, root.ink.g, root.ink.b, edit.activeFocus ? 0.08 : 0.04)
      border.width: Math.max(1, Style.space(1))
      border.color: Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.28)
    }

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.IBeamCursor
      onClicked: {
        root.confirmRemoveAuthor = ""
        edit.forceActiveFocus()
      }
    }

    Flickable {
      id: areaScroll
      anchors.fill: parent
      anchors.leftMargin: area.padX
      anchors.rightMargin: area.padX
      anchors.topMargin: area.padY
      anchors.bottomMargin: area.padY
      clip: true
      flickableDirection: Flickable.VerticalFlick
      contentWidth: width
      contentHeight: Math.max(height, edit.contentHeight)

      TextEdit {
        id: edit
        width: areaScroll.width
        height: Math.max(areaScroll.height, contentHeight)
        color: root.ink
        selectionColor: Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.35)
        selectedTextColor: root.ink
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        wrapMode: TextEdit.Wrap
        selectByMouse: true
        activeFocusOnTab: true
        onActiveFocusChanged: {
          if (activeFocus) {
            root.confirmRemoveAuthor = ""
            root.reveal(area)
          }
        }
        onCursorRectangleChanged: {
          if (cursorRectangle.y < areaScroll.contentY) {
            areaScroll.contentY = cursorRectangle.y
          } else if (cursorRectangle.y + cursorRectangle.height > areaScroll.contentY + areaScroll.height) {
            areaScroll.contentY = Math.max(0, cursorRectangle.y + cursorRectangle.height - areaScroll.height)
          }
        }
        Keys.onTabPressed: function(event) {
          var next = edit.nextItemInFocusChain(true)
          if (next) next.forceActiveFocus(Qt.TabFocusReason)
          event.accepted = true
        }
        Keys.onBacktabPressed: function(event) {
          var prev = edit.nextItemInFocusChain(false)
          if (prev) prev.forceActiveFocus(Qt.BacktabFocusReason)
          event.accepted = true
        }
        Keys.onPressed: function(event) {
          if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
            area.submitted()
            event.accepted = true
          }
        }
      }

      Text {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        visible: edit.text === ""
        text: area.placeholderText
        color: root.hint
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
      }
    }

    Rectangle {
      anchors.fill: parent
      anchors.margins: -2
      enabled: false
      color: "transparent"
      radius: Style.cornerRadius
      border.width: edit.activeFocus ? 2 : 0
      border.color: Commons.Color.accent
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
      onStreamFinished: {
        if (String(text || "").trim() !== "") {
          root.error = root.plainError(text, "Could not open the preview.")
          root.errorScope = ""
        }
      }
    }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.error = ""
        root.errorScope = ""
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

  property real userWidth: 0
  property real userHeight: 0
  property bool hasLocalSize: false
  property bool resizing: false
  property string pendingSizePayload: ""

  function maxCardWidth(availableWidth) {
    return Math.max(0, availableWidth - Style.space(48))
  }

  function maxCardHeight(availableHeight) {
    return Math.max(0, availableHeight - Style.space(64))
  }

  function minCardWidth(availableWidth) {
    return Math.min(Math.max(120, Style.space(400)), maxCardWidth(availableWidth))
  }

  function minCardHeight(availableHeight) {
    return Math.min(Math.max(120, Style.space(320)), maxCardHeight(availableHeight))
  }

  function clampedCardWidth(wanted, availableWidth) {
    var maxW = maxCardWidth(availableWidth)
    if (maxW <= 0) return Style.space(520)
    return Math.max(minCardWidth(availableWidth), Math.min(wanted, maxW))
  }

  function clampedCardHeight(wanted, availableHeight) {
    var maxH = maxCardHeight(availableHeight)
    if (maxH <= 0) return Style.space(320)
    return Math.max(minCardHeight(availableHeight), Math.min(wanted, maxH))
  }

  function adoptPanelSize(raw) {
    if (!raw || typeof raw !== "object") {
      userWidth = 0
      userHeight = 0
      return
    }
    var w = Number(raw.width)
    var h = Number(raw.height)
    userWidth = (isFinite(w) && w > 0) ? w : 0
    userHeight = (isFinite(h) && h > 0) ? h : 0
  }

  function sendPanelSize(payloadJson) {
    if (sizeProcess.running) {
      pendingSizePayload = payloadJson
      return
    }
    pendingSizePayload = ""
    sizeProcess.command = [command, "panel", "size", payloadJson]
    sizeProcess.running = true
  }

  function persistPanelSize() {
    var payload = {}
    var w = Math.round(userWidth)
    var h = Math.round(userHeight)
    if (w >= 120) payload.width = w
    if (h >= 120) payload.height = h
    if (payload.width === undefined && payload.height === undefined) {
      sendPanelSize('{"reset":true}')
      return
    }
    sendPanelSize(JSON.stringify(payload))
  }

  function resetPanelSize() {
    hasLocalSize = true
    userWidth = 0
    userHeight = 0
    sendPanelSize('{"reset":true}')
  }

  function clampScroll() {
    var maxY = Math.max(0, scroller.contentHeight - scroller.height)
    if (scroller.contentY > maxY) scroller.contentY = maxY
  }

  Process {
    id: sizeProcess
    onExited: {
      if (root.pendingSizePayload !== "") {
        let nextPayload = root.pendingSizePayload
        root.pendingSizePayload = ""
        sizeProcess.command = [root.command, "panel", "size", nextPayload]
        sizeProcess.running = true
      }
    }
  }

  component ResizeHandle: MouseArea {
    id: handle
    property int horizontalEdge: 0
    property int verticalEdge: 0
    property real startSceneX: 0
    property real startSceneY: 0
    property real startWidth: 0
    property real startHeight: 0
    property bool dragged: false
    property bool suppressDrag: false
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton
    preventStealing: true
    z: (horizontalEdge !== 0 && verticalEdge !== 0) ? 12 : 10
    cursorShape: {
      if (horizontalEdge > 0 && verticalEdge > 0) return Qt.SizeFDiagCursor
      if (horizontalEdge < 0 && verticalEdge > 0) return Qt.SizeBDiagCursor
      if (horizontalEdge !== 0) return Qt.SizeHorCursor
      return Qt.SizeVerCursor
    }
    onPressed: function(mouse) {
      root.confirmRemoveAuthor = ""
      var pt = handle.mapToItem(keyCatcher, mouse.x, mouse.y)
      handle.startSceneX = pt.x
      handle.startSceneY = pt.y
      handle.startWidth = card.width
      handle.startHeight = card.height
      handle.dragged = false
      handle.suppressDrag = false
      root.resizing = true
      mouse.accepted = true
    }
    onPositionChanged: function(mouse) {
      if (!handle.pressed || handle.suppressDrag) return
      var pt = handle.mapToItem(keyCatcher, mouse.x, mouse.y)
      var dx = pt.x - handle.startSceneX
      var dy = pt.y - handle.startSceneY
      if (!handle.dragged && (handle.horizontalEdge === 0 || Math.abs(dx) < 1) && (handle.verticalEdge === 0 || Math.abs(dy) < 1)) return
      var nextWidth = handle.horizontalEdge !== 0
        ? root.clampedCardWidth(handle.startWidth + handle.horizontalEdge * 2 * dx, keyCatcher.width)
        : card.width
      var nextHeight = handle.verticalEdge !== 0
        ? root.clampedCardHeight(handle.startHeight + handle.verticalEdge * dy, keyCatcher.height)
        : card.height
      if (!handle.dragged && Math.abs(nextWidth - handle.startWidth) < 0.5 && Math.abs(nextHeight - handle.startHeight) < 0.5) return
      handle.dragged = true
      root.hasLocalSize = true
      if (handle.horizontalEdge !== 0) {
        // Card stays horizontally centered, so 2*dx keeps the dragged edge 1:1 with the cursor.
        root.userWidth = nextWidth
      }
      if (handle.verticalEdge !== 0) {
        root.userHeight = nextHeight
      }
    }
    onReleased: {
      root.resizing = false
      if (handle.dragged && !handle.suppressDrag) {
        handle.dragged = false
        root.persistPanelSize()
      } else {
        handle.dragged = false
      }
      handle.suppressDrag = false
    }
    onCanceled: {
      root.resizing = false
      handle.dragged = false
      handle.suppressDrag = false
    }
    onDoubleClicked: {
      handle.suppressDrag = true
      handle.dragged = false
      root.resizing = false
      root.confirmRemoveAuthor = ""
      root.resetPanelSize()
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
          keyCatcher.forceActiveFocus()
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
        objectName: "panelCard"
        readonly property real resizeOuterLip: Style.space(6)
        readonly property real resizeCornerInner: Math.min(Style.space(14), Style.spacing.popupPadding)
        readonly property real resizeCornerSize: resizeCornerInner + resizeOuterLip
        readonly property real resizeEdgeInner: Math.min(Style.space(6), Style.spacing.popupPadding)
        readonly property real resizeEdgeThickness: resizeEdgeInner + resizeOuterLip
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: Style.space(32)
        width: root.clampedCardWidth(root.userWidth > 0 ? root.userWidth : Style.space(520), keyCatcher.width)
        height: root.userHeight > 0
          ? root.clampedCardHeight(root.userHeight, keyCatcher.height)
          : Math.min(content.implicitHeight + Style.spacing.popupPadding * 2, root.maxCardHeight(keyCatcher.height))
        radius: Style.cornerRadius
        color: Commons.Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Commons.Color.popups.border
        MouseArea { anchors.fill: parent; onClicked: root.confirmRemoveAuthor = "" }

        Flickable {
          id: scroller
          anchors.fill: parent
          anchors.margins: Style.spacing.popupPadding
          contentWidth: width
          contentHeight: content.implicitHeight
          clip: true
          flickableDirection: Flickable.VerticalFlick
          onHeightChanged: root.clampScroll()
          onContentHeightChanged: root.clampScroll()
          onMovementStarted: root.formScrollSeq++

          MouseArea {
            id: contentBackdrop
            width: scroller.width
            height: Math.max(scroller.height, content.implicitHeight)
            onClicked: root.confirmRemoveAuthor = ""
          }

          Column {
            id: content
            objectName: "panelContent"
            width: scroller.width
            spacing: Style.space(12)

            Row {
              id: headerRow
              width: parent.width
              spacing: Style.space(14)

              Item {
                id: portraitSlot
                visible: root.hasPortrait
                width: visible ? portraitText.implicitWidth : 0
                height: visible ? portraitText.implicitHeight : 0
                opacity: root.portraitFullyVisible(portraitSlot.mapToItem(scroller.contentItem, 0, 0).y, portraitSlot.height, scroller.contentY, scroller.height) ? 1 : 0
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
                id: headerTextColumn
                width: Math.max(0, parent.width - (portraitSlot.visible && portraitSlot.width > 0 ? portraitSlot.width + Style.space(14) : 0))
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
                      root.errorScope = ""
                      root.authorListHint = ""
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
                  height: Math.ceil(Style.font.body * 1.35) * 3
                  clip: true
                  Text {
                    id: quotePreviewText
                    width: parent.width
                    anchors.verticalCenter: quoteSlot.verticalCenter
                    text: root.preview ? (root.preview.text !== "" ? root.preview.text : "No quotes yet.") : "Pick at least one author."
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    lineHeightMode: Text.FixedHeight
                    lineHeight: Math.ceil(Style.font.body * 1.35)
                    wrapMode: Text.WordWrap
                    maximumLineCount: 3
                    elide: Text.ElideRight
                  }
                }
                Item {
                  id: citationSlot
                  width: parent.width
                  height: Math.ceil(Style.font.bodySmall * 1.35)
                  clip: true
                  Text {
                    id: citationPreviewText
                    width: parent.width
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.preview ? (root.preview.citation !== "" ? (root.preview.name + ", " + root.preview.citation) : root.preview.name) : ""
                    color: root.quiet
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    maximumLineCount: 1
                    elide: Text.ElideRight
                  }
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

            Item {
              id: rotationHeaderRow
              width: parent.width
              height: Math.max(rotationHeader.implicitHeight, Math.ceil(Style.font.bodySmall * 1.35))
              PanelSectionHeader {
                id: rotationHeader
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: "Who is in rotation"
                foreground: root.ink
              }
              Text {
                id: authorHintText
                visible: root.authorListHint !== ""
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                width: Math.min(implicitWidth, Math.max(0, parent.width - rotationHeader.implicitWidth - Style.space(8)))
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
                text: root.authorListHint
                color: Commons.Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }

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
                  onClicked: root.toggleAuthor(authorRow.modelData.slug)
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
                    color: root.selectedAuthors.indexOf(authorRow.modelData.slug) !== -1 ? Commons.Color.accent : "transparent"
                    border.width: Math.max(1, Style.space(1))
                    border.color: root.selectedAuthors.indexOf(authorRow.modelData.slug) !== -1 ? Commons.Color.accent : root.ink
                    Text {
                      anchors.centerIn: parent
                      visible: root.selectedAuthors.indexOf(authorRow.modelData.slug) !== -1
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
                      text: authorRow.modelData.name
                      color: root.ink
                      font.family: Style.font.family
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      width: parent.width
                      elide: Text.ElideRight
                      visible: authorRow.modelData.dates !== ""
                      text: authorRow.modelData.dates
                      color: root.dates
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                  }
                  Row {
                    id: customActions
                    visible: authorRow.modelData.custom === true
                    spacing: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    RingButton {
                      label: "Edit"
                      picked: root.authorOpen && root.editingAuthorSlug === authorRow.modelData.slug
                      available: !root.busy
                      onActivated: root.startEditAuthor(authorRow.modelData)
                    }
                    RingButton {
                      label: root.confirmRemoveAuthor === authorRow.modelData.slug ? "Remove?" : "Remove"
                      sizeLabel: "Remove?"
                      destructive: root.confirmRemoveAuthor === authorRow.modelData.slug
                      available: !root.busy
                      keepsRemoveConfirm: true
                      onActivated: root.requestRemoveAuthor(authorRow.modelData.slug)
                      onFocusLost: if (root.confirmRemoveAuthor === authorRow.modelData.slug) root.confirmRemoveAuthor = ""
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
                label: "Add your own quote"
                picked: root.quoteOpen
                onActivated: root.toggleQuoteForm()
              }
              RingButton {
                label: "Add an author"
                picked: root.authorOpen && root.editingAuthorSlug === ""
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
                        let chip = authorChips.itemAt(target)
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
              QuoteArea {
                id: textField
                width: parent.width
                placeholderText: "The line itself"
                onTextChanged: root.newText = text
                onSubmitted: if (!root.busy) root.addQuote()
              }
              Text {
                width: parent.width
                visible: root.newCitation.trim() !== "" || root.newText.trim() !== ""
                text: {
                  var who = ""
                  for (let i = 0; i < root.samples.length; i++) {
                    if (root.samples[i].slug === root.newAuthor) who = root.samples[i].name
                  }
                  var cite = root.newCitation.trim()
                  var line = root.newText.replace(/[\r\n]+/g, " ").trim()
                  return who + (cite !== "" ? ", " + cite : "") + (line !== "" ? " — " + line : "")
                }
                color: root.ink
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
              }
              Text {
                id: quoteErrorText
                width: parent.width
                visible: root.error !== "" && root.errorScope === "quote"
                text: root.error
                color: Commons.Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
              }
              Row {
                id: quoteSubmitRow
                spacing: Style.space(8)
                RingButton {
                  id: quoteSubmitButton
                  label: "Add quote"
                  available: root.quoteReady && !root.busy
                  onActivated: root.addQuote()
                }
                RingButton {
                  label: "Cancel"
                  onActivated: root.closeQuoteForm()
                }
              }
            }

            Column {
              id: authorForm
              width: parent.width
              visible: root.authorOpen
              spacing: Style.space(8)

              Text {
                visible: root.editingAuthorSlug !== ""
                text: "Edit " + root.editingAuthorOrigName
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
                      let suggested = root.slugFromName(text)
                      root.newAuthorSlug = suggested
                      if (authorSlugField.text !== suggested) authorSlugField.text = suggested
                      if (root.editingAuthorSlug === "" && text.trim() !== "" && suggested === "") {
                        root.authorAdvancedOpen = true
                      }
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
              QuoteArea {
                id: authorTextField
                width: parent.width
                placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current quotes" : "The line itself"
                onTextChanged: root.newAuthorText = text
                onSubmitted: if (!root.busy) root.submitAuthor()
              }
              Rectangle {
                id: advancedToggle
                visible: root.editingAuthorSlug === ""
                implicitWidth: advancedLabel.implicitWidth + Style.space(8)
                implicitHeight: advancedLabel.implicitHeight + Style.space(6)
                radius: Style.cornerRadius
                color: advancedHover.containsMouse ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08) : "transparent"
                border.width: activeFocus ? 2 : 0
                border.color: Commons.Color.accent
                activeFocusOnTab: true
                Text {
                  id: advancedLabel
                  anchors.centerIn: parent
                  text: (root.authorAdvancedOpen ? "▾ " : "▸ ") + "Advanced"
                  color: root.quiet
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }
                MouseArea {
                  id: advancedHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    root.confirmRemoveAuthor = ""
                    root.authorAdvancedOpen = !root.authorAdvancedOpen
                    if (root.authorAdvancedOpen) Qt.callLater(function() { root.reveal(authorSlugField) })
                  }
                }
                Keys.onPressed: function(event) {
                  if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    root.authorAdvancedOpen = !root.authorAdvancedOpen
                    if (root.authorAdvancedOpen) Qt.callLater(function() { root.reveal(authorSlugField) })
                    event.accepted = true
                  }
                }
              }
              Column {
                id: advancedFields
                width: parent.width
                visible: root.editingAuthorSlug === "" && root.authorAdvancedOpen
                spacing: Style.space(6)
                Text {
                  text: "Author id"
                  color: root.quiet
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }
                Item {
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
              }
              Text {
                id: authorErrorText
                width: parent.width
                visible: root.error !== "" && root.errorScope === "author"
                text: root.error
                color: Commons.Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
              }
              Row {
                id: authorSubmitRow
                spacing: Style.space(8)
                RingButton {
                  label: root.editingAuthorSlug !== "" ? "Save changes" : "Add author"
                  available: root.authorReady && !root.busy
                  onActivated: root.submitAuthor()
                }
                RingButton {
                  label: "Cancel"
                  onActivated: root.closeAuthorForm()
                }
              }
            }

            Rectangle {
              id: customCountToggle
              visible: root.custom.length > 0
              implicitWidth: customCountLabel.implicitWidth + Style.space(6)
              implicitHeight: customCountLabel.implicitHeight + Style.space(6)
              radius: Style.cornerRadius
              color: customCountHover.containsMouse ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.06) : "transparent"
              border.width: activeFocus ? 2 : 0
              border.color: Commons.Color.accent
              activeFocusOnTab: true
              Text {
                id: customCountLabel
                anchors.centerIn: parent
                text: (root.listOpen ? "▾ " : "▸ ") + (root.custom.length === 1 ? "1 custom quote" : (root.custom.length + " custom quotes"))
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              MouseArea {
                id: customCountHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  root.confirmRemoveAuthor = ""
                  root.listOpen = !root.listOpen
                }
              }
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                  root.listOpen = !root.listOpen
                  event.accepted = true
                }
              }
            }

            Column {
              width: parent.width
              visible: root.listOpen && root.custom.length > 0
              spacing: Style.space(6)
              Repeater {
                model: root.custom
                delegate: Row {
                  id: customRow
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(8)
                  Text {
                    width: parent.width - Style.space(96)
                    text: customRow.modelData.name + ", " + customRow.modelData.citation
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                  }
                  RingButton {
                    label: "Remove"
                    onActivated: root.removeQuote(customRow.modelData.id)
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
                color: root.errorShownInStatus ? Commons.Color.urgent : root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }
            }
          }
        }

        ResizeHandle {
          id: resizeLeft
          objectName: "resizeLeft"
          horizontalEdge: -1
          anchors.top: parent.top
          anchors.bottom: resizeCornerLeft.top
          anchors.left: parent.left
          anchors.leftMargin: -card.resizeOuterLip
          width: card.resizeEdgeThickness
          Rectangle {
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.leftMargin: card.resizeOuterLip
            width: Math.max(2, Style.space(2))
            radius: width / 2
            color: Commons.Color.accent
            opacity: (resizeLeft.containsMouse || resizeLeft.pressed) ? 0.85 : 0
          }
        }

        ResizeHandle {
          id: resizeRight
          objectName: "resizeRight"
          horizontalEdge: 1
          anchors.top: parent.top
          anchors.bottom: resizeCornerRight.top
          anchors.right: parent.right
          anchors.rightMargin: -card.resizeOuterLip
          width: card.resizeEdgeThickness
          Rectangle {
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            anchors.right: parent.right
            anchors.rightMargin: card.resizeOuterLip
            width: Math.max(2, Style.space(2))
            radius: width / 2
            color: Commons.Color.accent
            opacity: (resizeRight.containsMouse || resizeRight.pressed) ? 0.85 : 0
          }
        }

        ResizeHandle {
          id: resizeBottom
          objectName: "resizeBottom"
          verticalEdge: 1
          anchors.left: resizeCornerLeft.right
          anchors.right: resizeCornerRight.left
          anchors.bottom: parent.bottom
          anchors.bottomMargin: -card.resizeOuterLip
          height: card.resizeEdgeThickness
          Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.bottomMargin: card.resizeOuterLip
            height: Math.max(2, Style.space(2))
            radius: height / 2
            color: Commons.Color.accent
            opacity: (resizeBottom.containsMouse || resizeBottom.pressed) ? 0.85 : 0
          }
        }

        ResizeHandle {
          id: resizeCornerLeft
          objectName: "resizeCornerLeft"
          horizontalEdge: -1
          verticalEdge: 1
          anchors.left: parent.left
          anchors.bottom: parent.bottom
          anchors.leftMargin: -card.resizeOuterLip
          anchors.bottomMargin: -card.resizeOuterLip
          width: card.resizeCornerSize
          height: card.resizeCornerSize
          Rectangle {
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            anchors.leftMargin: card.resizeOuterLip
            anchors.bottomMargin: card.resizeOuterLip
            width: Math.max(2, Style.space(2))
            height: Math.min(Style.space(12), card.resizeCornerInner)
            radius: width / 2
            color: Commons.Color.accent
            opacity: (resizeCornerLeft.containsMouse || resizeCornerLeft.pressed) ? 0.85 : 0
          }
          Rectangle {
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            anchors.leftMargin: card.resizeOuterLip
            anchors.bottomMargin: card.resizeOuterLip
            width: Math.min(Style.space(12), card.resizeCornerInner)
            height: Math.max(2, Style.space(2))
            radius: height / 2
            color: Commons.Color.accent
            opacity: (resizeCornerLeft.containsMouse || resizeCornerLeft.pressed) ? 0.85 : 0
          }
        }

        ResizeHandle {
          id: resizeCornerRight
          objectName: "resizeCornerRight"
          horizontalEdge: 1
          verticalEdge: 1
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.rightMargin: -card.resizeOuterLip
          anchors.bottomMargin: -card.resizeOuterLip
          width: card.resizeCornerSize
          height: card.resizeCornerSize
          Accessible.name: "Resize panel"

          Item {
            id: resizeGrip
            objectName: "resizeGrip"
            readonly property real dot: Math.max(2, Style.space(2))
            readonly property real step: dot + Math.max(2, Style.space(2))
            readonly property real inset: Math.max(2, Math.floor((card.resizeCornerInner - width) / 2))
            readonly property color gripColor: (resizeCornerRight.containsMouse || resizeCornerRight.pressed)
              ? Commons.Color.accent
              : Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.45)
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.rightMargin: card.resizeOuterLip + inset
            anchors.bottomMargin: card.resizeOuterLip + inset
            width: step * 2 + dot
            height: step * 2 + dot
            Rectangle { x: resizeGrip.step * 2; y: 0; width: resizeGrip.dot; height: resizeGrip.dot; radius: width / 2; color: resizeGrip.gripColor }
            Rectangle { x: resizeGrip.step; y: resizeGrip.step; width: resizeGrip.dot; height: resizeGrip.dot; radius: width / 2; color: resizeGrip.gripColor }
            Rectangle { x: resizeGrip.step * 2; y: resizeGrip.step; width: resizeGrip.dot; height: resizeGrip.dot; radius: width / 2; color: resizeGrip.gripColor }
            Rectangle { x: 0; y: resizeGrip.step * 2; width: resizeGrip.dot; height: resizeGrip.dot; radius: width / 2; color: resizeGrip.gripColor }
            Rectangle { x: resizeGrip.step; y: resizeGrip.step * 2; width: resizeGrip.dot; height: resizeGrip.dot; radius: width / 2; color: resizeGrip.gripColor }
            Rectangle { x: resizeGrip.step * 2; y: resizeGrip.step * 2; width: resizeGrip.dot; height: resizeGrip.dot; radius: width / 2; color: resizeGrip.gripColor }
          }
        }
      }
    }
  }
}
