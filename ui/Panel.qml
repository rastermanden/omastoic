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
  property int previewPortraitFont: 6
  property real previewPortraitLine: 8.4
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
  property bool pickingImage: false
  property int pickRequestId: 0
  property var activePickProcess: null
  property string editingAuthorPortrait: ""
  property string portraitPreviewArt: ""
  property string portraitPreviewError: ""
  property bool portraitPreviewLoading: false
  property int portraitPreviewRequestId: 0
  property var activePortraitPreviewProcess: null
  property string portraitPreviewSource: ""
  readonly property string pickerUnavailableNotice: "Could not open the file picker. Type a path instead."
  readonly property string pickerUnsupportedNotice: "Choose a JPEG or PNG saved on this computer."
  readonly property string noAuthorChangesError: "Change the portrait, name, dates, or quote first."
  property string pendingRemove: ""
  property string pendingRemoveAuthor: ""
  property string confirmRemoveAuthor: ""
  property string editingAuthorSlug: ""
  property string editingAuthorOrigName: ""
  property string editingAuthorOrigDates: ""
  property string notice: ""
  property string pendingApplyNotice: ""
  property string rotationNotice: ""
  property string error: ""
  property string errorScope: ""
  property string authorListHint: ""
  property bool quoteOpen: false
  onQuoteOpenChanged: if (quoteOpen) root.revealAfterLayout(quoteForm, quoteForm, citationField, citationField)
  property bool authorOpen: false
  onAuthorOpenChanged: if (authorOpen) root.revealAfterLayout(authorForm, authorForm, authorNameField, authorNameField)
  property bool listOpen: false
  property string activeAuthorSaveSlug: ""
  property string activeAuthorRemoveSlug: ""
  property string activeQuoteRemoveId: ""
  property real formReturnContentY: 0
  property bool hasFormReturnY: false
  property int formScrollSeq: 0
  property bool revealingAfterLayout: false
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
  readonly property string derivedAuthorSlug: slugFromName(newAuthorName)
  property string customAuthorSlug: ""
  readonly property string newAuthorSlug: editingAuthorSlug !== ""
    ? editingAuthorSlug
    : (customAuthorSlug.trim() !== "" ? customAuthorSlug.trim() : derivedAuthorSlug)
  property bool authorAdvancedOpen: false
  property string newAuthorDates: ""
  property string newAuthorImage: ""
  property string newAuthorCitation: ""
  property string newAuthorText: ""
  property var missingAuthorFields: []
  property var missingQuoteFields: []
  property bool authorValidationError: false
  property bool quoteValidationError: false

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
    for (let i = 0; i < samples.length; i++) {
      if (selectedAuthors.indexOf(samples[i].slug) !== -1) return samples[i]
    }
    return null
  }
  readonly property var duplicateAuthorNames: {
    let counts = Object.create(null)
    for (let i = 0; i < samples.length; i++) {
      let key = String(samples[i].name || "").trim().toLowerCase()
      if (key !== "") counts[key] = (counts[key] || 0) + 1
    }
    let dups = Object.create(null)
    for (let k in counts) {
      if (counts[k] > 1) dups[k] = true
    }
    return dups
  }
  readonly property string editingAuthorHeading: hasDuplicateAuthorName(editingAuthorOrigName)
    ? (editingAuthorOrigName + " (" + editingAuthorSlug + ")")
    : editingAuthorOrigName
  readonly property bool hasPortrait: preview !== null && /[^\s\u2800]/.test(String(preview.portrait || ""))
  readonly property string displayedAuthorPortrait: newAuthorImage.trim() !== ""
    ? portraitPreviewArt
    : (editingAuthorSlug !== "" ? editingAuthorPortrait : "")
  readonly property bool hasDisplayedAuthorPortrait: /[^\s\u2800]/.test(displayedAuthorPortrait)
  readonly property bool showAuthorPortraitPreview: authorOpen && (
    (newAuthorImage.trim() !== "" && (portraitPreviewLoading || hasDisplayedAuthorPortrait || portraitPreviewError !== "")) ||
    (editingAuthorSlug !== "" && newAuthorImage.trim() === "" && /[^\s\u2800]/.test(editingAuthorPortrait))
  )
  readonly property string authorPortraitCaption: {
    if (newAuthorImage.trim() !== "") {
      if (portraitPreviewLoading) return "Rendering preview…"
      if (portraitPreviewError !== "") return ""
      if (hasDisplayedAuthorPortrait) return editingAuthorSlug !== "" ? "New portrait preview" : "Portrait preview"
      return ""
    }
    return "Current portrait"
  }
  readonly property color ink: Commons.Color.popups.text
  // 0.88 clears 4.5:1 for small text on Tokyo Night and Catppuccin Latte.
  // Placeholders stay lower so they read as hints, not as typed text.
  readonly property color quiet: Qt.rgba(ink.r, ink.g, ink.b, 0.88)
  readonly property color hint: Qt.rgba(ink.r, ink.g, ink.b, 0.45)
  // The roster dates sit on the selected-row accent wash (0.16). `quiet` at
  // 0.88 drops below 4.5:1 over that wash in Catppuccin Latte, so the dates get
  // a stronger ink that still reads quieter than the author's name.
  readonly property color dates: Qt.rgba(ink.r, ink.g, ink.b, 0.92)

  function open(payloadJson) {
    cancelImagePick()
    clearPortraitPreview()
    error = ""
    errorScope = ""
    if (notice !== "Saving…") notice = ""
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
    authorListHint = ""
    missingAuthorFields = []
    missingQuoteFields = []
    authorValidationError = false
    quoteValidationError = false
    pendingApplyNotice = ""
    rotationNotice = ""
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    editingAuthorPortrait = ""
    customAuthorSlug = ""
    pendingReplaceAuthor = null
    pendingRemoveAuthor = ""
    confirmRemoveAuthor = ""
    activeAuthorSaveSlug = ""
    activeAuthorRemoveSlug = ""
    activeQuoteRemoveId = ""
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
    applyTimer.stop()
    cancelImagePick()
    clearPortraitPreview()
    clearPickerNotice()
    clearRotationNotice()
    pendingApplyNotice = ""
    opened = false
    resizing = false
    hasFormReturnY = false
    error = ""
    errorScope = ""
    authorListHint = ""
    missingAuthorFields = []
    missingQuoteFields = []
    authorValidationError = false
    quoteValidationError = false
    confirmRemoveAuthor = ""
    editingAuthorPortrait = ""
    customAuthorSlug = ""
    activeAuthorSaveSlug = ""
    activeAuthorRemoveSlug = ""
    activeQuoteRemoveId = ""
  }

  function clearValidationState() {
    missingAuthorFields = []
    missingQuoteFields = []
    authorValidationError = false
    quoteValidationError = false
  }

  function clearNoChangeAuthorError() {
    if (errorScope === "author" && error === noAuthorChangesError) {
      error = ""
      errorScope = ""
      authorValidationError = false
    }
  }

  function isAuthorFieldMissing(key) {
    return missingAuthorFields.indexOf(key) !== -1
  }

  function isQuoteFieldMissing(key) {
    return missingQuoteFields.indexOf(key) !== -1
  }

  function clearMissingAuthorField(key) {
    if (missingAuthorFields.indexOf(key) === -1) return
    let next = missingAuthorFields.filter(function(item) { return item !== key })
    missingAuthorFields = next
    if (next.length === 0 && authorValidationError && errorScope === "author") {
      error = ""
      errorScope = ""
      authorValidationError = false
    }
  }

  function clearMissingQuoteField(key) {
    if (missingQuoteFields.indexOf(key) === -1) return
    let next = missingQuoteFields.filter(function(item) { return item !== key })
    missingQuoteFields = next
    if (next.length === 0 && quoteValidationError && errorScope === "quote") {
      error = ""
      errorScope = ""
      quoteValidationError = false
    }
  }

  function joinFieldList(names) {
    if (!names || names.length === 0) return ""
    if (names.length === 1) return names[0]
    if (names.length === 2) return names[0] + " and " + names[1]
    return names.slice(0, names.length - 1).join(", ") + ", and " + names[names.length - 1]
  }

  function focusField(field) {
    if (!field) return
    if (typeof field.takeFocus === "function") field.takeFocus()
    else field.forceActiveFocus()
  }

  function hasDuplicateAuthorName(name) {
    var key = String(name || "").trim().toLowerCase()
    return key !== "" && duplicateAuthorNames[key] === true
  }

  function authorDisplayName(author) {
    if (!author) return ""
    var name = String(author.name || "")
    var slug = String(author.slug || "")
    return (slug !== "" && hasDuplicateAuthorName(name)) ? (name + " (" + slug + ")") : name
  }

  function authorDisplayNameBySlug(slug, fallbackName) {
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].slug === slug) return authorDisplayName(samples[i])
    }
    return String(fallbackName || slug || "")
  }

  function authorRowMeta(author) {
    if (!author) return ""
    var dates = String(author.dates || "")
    var slug = String(author.slug || "")
    if (slug !== "" && hasDuplicateAuthorName(author.name)) {
      return dates !== "" ? (slug + " · " + dates) : slug
    }
    return dates
  }

  function findAuthorRow(slug) {
    for (let i = 0; i < authorRows.count; i++) {
      let rowItem = authorRows.itemAt(i)
      if (rowItem && rowItem.slug === slug) return rowItem
    }
    return null
  }

  function focusAfterFormClose(kind, slug) {
    if (!root.opened || root.authorOpen || root.quoteOpen) return
    if (kind === "author-row") {
      let rowItem = findAuthorRow(slug)
      if (rowItem) {
        rowItem.forceActiveFocus()
        root.reveal(rowItem)
        return
      }
      addAuthorButton.takeFocus()
      root.reveal(addAuthorButton)
      return
    }
    if (kind === "author-edit") {
      let rowItem = findAuthorRow(slug)
      if (rowItem && typeof rowItem.focusEditButton === "function") {
        rowItem.focusEditButton()
        root.reveal(rowItem)
        return
      }
      addAuthorButton.takeFocus()
      root.reveal(addAuthorButton)
      return
    }
    if (kind === "quote-opener") {
      addQuoteButton.takeFocus()
      root.reveal(addQuoteButton)
      return
    }
    addAuthorButton.takeFocus()
    root.reveal(addAuthorButton)
  }

  function captureFormReturnY() {
    if (!hasFormReturnY) {
      formReturnContentY = scroller.contentY
      hasFormReturnY = true
    }
  }

  function restoreFormReturnY(onDone) {
    var hasReturn = hasFormReturnY
    var target = formReturnContentY
    hasFormReturnY = false
    formScrollSeq++
    var seq = formScrollSeq
    var clampAndSet = function() {
      var maxY = 0
      var prevRevealing = false
      if (seq !== root.formScrollSeq || root.authorOpen || root.quoteOpen) return
      content.forceLayout()
      if (hasReturn) {
        maxY = Math.max(0, scroller.contentHeight - scroller.height)
        scroller.contentY = Math.max(0, Math.min(target, maxY))
      }
      if (typeof onDone === "function") {
        prevRevealing = root.revealingAfterLayout
        root.revealingAfterLayout = true
        try {
          onDone()
        } finally {
          root.revealingAfterLayout = prevRevealing
        }
      }
    }
    clampAndSet()
    Qt.callLater(clampAndSet)
  }

  function clearPickerNotice() {
    if (notice === pickerUnavailableNotice || notice === pickerUnsupportedNotice) notice = ""
  }

  function clearRotationNotice() {
    if (rotationNotice !== "" && notice === rotationNotice) notice = ""
    rotationNotice = ""
  }

  function cancelImagePick() {
    pickRequestId++
    pickingImage = false
    let proc = activePickProcess
    activePickProcess = null
    if (proc) {
      proc.cancelled = true
      proc.running = false
    }
  }

  function chooseAuthorImage() {
    if (!root.opened || !root.authorOpen || root.busy || root.pickingImage) return
    confirmRemoveAuthor = ""
    pickRequestId++
    let reqId = pickRequestId
    let proc = pickImageProcessComponent.createObject(root, {
      requestId: reqId,
      command: [command, "panel", "pick-image", "--watch-stdin"],
    })
    if (!proc) {
      error = ""
      errorScope = ""
      notice = pickerUnavailableNotice
      Qt.callLater(function() {
        if (root.opened && root.authorOpen && !root.pickingImage) {
          authorImageField.forceActiveFocus()
          root.reveal(statusSlot)
        }
      })
      return
    }
    activePickProcess = proc
    pickingImage = true
    proc.running = true
  }

  function cancelPortraitPreview() {
    portraitPreviewTimer.stop()
    portraitPreviewRequestId++
    portraitPreviewLoading = false
    let proc = activePortraitPreviewProcess
    activePortraitPreviewProcess = null
    if (proc) {
      proc.cancelled = true
      proc.running = false
    }
  }

  function clearPortraitPreview() {
    cancelPortraitPreview()
    portraitPreviewSource = ""
    portraitPreviewArt = ""
    portraitPreviewError = ""
  }

  function stopPendingPortraitPreview() {
    if (portraitPreviewArt === "" && portraitPreviewError === "") clearPortraitPreview()
    else cancelPortraitPreview()
  }

  function schedulePortraitPreview(path, immediate) {
    let trimmed = String(path || "").trim()
    if (!root.opened || !root.authorOpen || trimmed === "") {
      clearPortraitPreview()
      return
    }
    if (trimmed === portraitPreviewSource) {
      if (portraitPreviewLoading) {
        if (immediate && portraitPreviewTimer.running) {
          portraitPreviewTimer.stop()
          runPortraitPreview(trimmed)
        }
        return
      }
      if (!immediate && (portraitPreviewArt !== "" || portraitPreviewError !== "")) {
        return
      }
    }
    cancelPortraitPreview()
    portraitPreviewSource = trimmed
    portraitPreviewArt = ""
    portraitPreviewError = ""
    portraitPreviewLoading = true
    if (immediate) runPortraitPreview(trimmed)
    else portraitPreviewTimer.restart()
  }

  function runPortraitPreview(path) {
    portraitPreviewTimer.stop()
    let trimmed = String(path || "").trim()
    if (!root.opened || !root.authorOpen || trimmed === "") {
      clearPortraitPreview()
      return
    }
    if (activePortraitPreviewProcess) {
      let prev = activePortraitPreviewProcess
      activePortraitPreviewProcess = null
      prev.cancelled = true
      prev.running = false
    }
    portraitPreviewRequestId++
    let reqId = portraitPreviewRequestId
    portraitPreviewSource = trimmed
    portraitPreviewError = ""
    portraitPreviewLoading = true
    let proc = portraitPreviewProcessComponent.createObject(root, {
      requestId: reqId,
      command: [command, "panel", "preview-portrait", JSON.stringify({ image: trimmed })],
    })
    if (!proc) {
      portraitPreviewLoading = false
      portraitPreviewArt = ""
      portraitPreviewError = "Could not render portrait preview."
      return
    }
    activePortraitPreviewProcess = proc
    proc.running = true
  }

  function settlePortraitPreviewProcess(proc) {
    if (!proc || proc.settled) return
    if (!proc.processExited || proc.streamsLeft > 0) return
    proc.settled = true
    if (activePortraitPreviewProcess === proc) activePortraitPreviewProcess = null
    let isCurrent = proc.requestId === portraitPreviewRequestId
    let exitStatus = proc.exitStatus
    let stdoutText = proc.stdoutText
    let stderrText = proc.stderrText
    proc.destroy()
    if (!isCurrent) return
    portraitPreviewLoading = false
    if (!root.opened || !root.authorOpen || root.newAuthorImage.trim() === "") return
    if (exitStatus === 0) {
      let parsed
      try { parsed = JSON.parse(String(stdoutText || "")) }
      catch (failure) { parsed = null }
      if (parsed && typeof parsed.portrait === "string" && /[^\s\u2800]/.test(parsed.portrait)) {
        if (Number(parsed.fontPx) > 0) previewPortraitFont = Number(parsed.fontPx)
        if (Number(parsed.lineHeight) > 0) previewPortraitLine = Number(parsed.lineHeight)
        portraitPreviewArt = parsed.portrait
        portraitPreviewError = ""
        root.revealAfterLayout(authorForm, authorPortraitPreviewBox, null)
        return
      }
    }
    portraitPreviewArt = ""
    portraitPreviewError = plainError(stderrText, "Could not render portrait preview.")
    root.revealAfterLayout(authorForm, authorPortraitPreviewBox, null)
  }

  function settlePickProcess(proc) {
    if (!proc || proc.settled) return
    if (!proc.processExited || proc.streamsLeft > 0) return
    proc.settled = true
    if (activePickProcess === proc) activePickProcess = null
    let isCurrent = proc.requestId === pickRequestId
    let exitStatus = proc.exitStatus
    let stdoutText = proc.stdoutText
    proc.destroy()
    if (!isCurrent) return
    pickingImage = false
    if (!root.opened || !root.authorOpen) return
    if (exitStatus === 0) {
      let chosen = String(stdoutText || "").replace(/\r?\n$/, "")
      if (chosen !== "") {
        authorImageField.text = chosen
        if (!authorValidationError || missingAuthorFields.length === 0) {
          error = ""
          errorScope = ""
        }
        clearPickerNotice()
        schedulePortraitPreview(chosen, true)
        Qt.callLater(function() {
          if (root.opened && root.authorOpen && !root.pickingImage) {
            root.reveal(authorImageField)
            authorImageField.forceActiveFocus()
          }
        })
        return
      }
      Qt.callLater(function() {
        if (root.opened && root.authorOpen && !root.pickingImage) {
          root.reveal(chooseImageButton)
          chooseImageButton.takeFocus()
        }
      })
      return
    }
    if (exitStatus === 1) {
      Qt.callLater(function() {
        if (root.opened && root.authorOpen && !root.pickingImage) {
          root.reveal(chooseImageButton)
          chooseImageButton.takeFocus()
        }
      })
      return
    }
    error = ""
    errorScope = ""
    notice = exitStatus === 3 ? pickerUnsupportedNotice : pickerUnavailableNotice
    Qt.callLater(function() {
      if (root.opened && root.authorOpen && !root.pickingImage) {
        authorImageField.forceActiveFocus()
        root.reveal(statusSlot)
      }
    })
  }

  function isInsideItem(item, ancestor) {
    var cur = item
    while (cur) {
      if (cur === ancestor) return true
      cur = cur.parent
    }
    return false
  }

  function isInsideScroller(item) {
    return isInsideItem(item, scroller.contentItem)
  }

  function syncFormLayout(form) {
    if (form === quoteForm) authorGrid.forceLayout()
    if (form === authorForm) {
      if (authorPortraitPreviewBox.visible) previewBoxColumn.forceLayout()
      if (advancedFields.visible) advancedFields.forceLayout()
    }
    if (form && typeof form.forceLayout === "function") form.forceLayout()
    if (form === authorForm && authorFooter.visible) authorFooter.forceLayout()
    content.forceLayout()
  }

  function labelForControl(item) {
    if (item === authorNameField) return authorNameLabel
    if (item === authorDatesField) return authorDatesLabel
    if (item === authorImageField || item === chooseImageButton) return authorImageLabel
    if (item === authorCitationField) return authorCitationLabel
    if (item === authorTextField) return authorTextLabel
    if (item === authorSlugField) return authorSlugLabel
    if (item === citationField) return quoteCitationLabel
    if (item === textField) return quoteTextLabel
    if (item === secondsField) return secondsLabel
    return null
  }

  function reveal(item, labelItem) {
    if (!item || !isInsideScroller(item)) return
    if (!root.revealingAfterLayout) root.formScrollSeq++
    if (root.authorOpen && isInsideItem(item, authorForm)) root.syncFormLayout(authorForm)
    else if (root.quoteOpen && isInsideItem(item, quoteForm)) root.syncFormLayout(quoteForm)
    var pos = item.mapToItem(scroller.contentItem, 0, 0)
    var itemTop = pos.y
    var itemBottom = pos.y + item.height
    var top = itemTop
    var bottom = itemBottom
    var label = labelItem !== undefined ? labelItem : root.labelForControl(item)
    var labelPos = null
    if (label && label.visible && isInsideScroller(label)) {
      labelPos = label.mapToItem(scroller.contentItem, 0, 0)
      top = Math.min(top, labelPos.y)
      bottom = Math.max(bottom, labelPos.y + label.height)
    }
    if (bottom - top > scroller.height) {
      top = itemTop
      bottom = itemBottom
    }
    if (bottom - top > scroller.height) {
      if (top < scroller.contentY || top > scroller.contentY + scroller.height - 24) {
        scroller.contentY = Math.max(0, top - 8)
      }
    } else {
      if (top < scroller.contentY) scroller.contentY = Math.max(0, top - 8)
      else if (bottom > scroller.contentY + scroller.height) scroller.contentY = Math.max(0, bottom - scroller.height + 8)
      if (top < scroller.contentY) scroller.contentY = Math.max(0, Math.min(top, bottom - scroller.height))
      if (bottom > scroller.contentY + scroller.height) scroller.contentY = Math.max(0, bottom - scroller.height)
    }
    root.clampScroll()
  }

  function revealAfterLayout(form, first, second, focusTarget) {
    formScrollSeq++
    var seq = formScrollSeq
    var revealTargets = function() {
      if (seq !== root.formScrollSeq) return
      if (form === authorForm && (!root.opened || !root.authorOpen)) return
      if (form === quoteForm && (!root.opened || !root.quoteOpen)) return
      var prevRevealing = root.revealingAfterLayout
      root.revealingAfterLayout = true
      try {
        root.syncFormLayout(form)
        if (first) root.reveal(first)
        if (second) root.reveal(second)
        if (focusTarget && focusTarget.visible && focusTarget !== second) root.reveal(focusTarget)
      } finally {
        root.revealingAfterLayout = prevRevealing
      }
    }
    revealTargets()
    Qt.callLater(function() {
      if (seq !== root.formScrollSeq) return
      if (form === authorForm && (!root.opened || !root.authorOpen)) return
      if (form === quoteForm && (!root.opened || !root.quoteOpen)) return
      var prevRevealing = root.revealingAfterLayout
      root.revealingAfterLayout = true
      try {
        if (focusTarget && focusTarget.visible) root.focusField(focusTarget)
        revealTargets()
      } finally {
        root.revealingAfterLayout = prevRevealing
      }
      Qt.callLater(revealTargets)
    })
  }

  function toggleAuthorAdvanced() {
    confirmRemoveAuthor = ""
    authorAdvancedOpen = !authorAdvancedOpen
    if (authorAdvancedOpen) {
      revealAfterLayout(authorForm, advancedFields, authorSlugField, authorSlugField)
    } else {
      advancedToggle.forceActiveFocus()
      root.reveal(advancedToggle)
    }
  }

  function toggleCustomList() {
    confirmRemoveAuthor = ""
    listOpen = !listOpen
    if (!listOpen && customCountToggle.visible) {
      customCountToggle.forceActiveFocus()
      root.reveal(customCountToggle)
    }
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
    missingAuthorFields = []
    missingQuoteFields = []
    authorValidationError = false
    quoteValidationError = false
    pendingApplyNotice = ""
    rotationNotice = ""
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
    if (line === "") return fallback
    if (/^[a-z]/.test(line)) line = line.charAt(0).toUpperCase() + line.slice(1)
    return line
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
      pendingApplyNotice = ""
      rotationNotice = ""
      notice = ""
      authorValidationError = false
      quoteValidationError = false
      if ((addingAuthor || replacingAuthor) && authorOpen) {
        errorScope = "author"
      } else if (addingQuote && quoteOpen) {
        errorScope = "quote"
      } else {
        errorScope = ""
      }
      error = failed ? plainError(run.stderr, fallback) : "Could not read the settings."
      let slugCollision = errorScope === "author" && editingAuthorSlug === "" && /\b(?:slug|bundled author|already exists|reserved)\b/i.test(error)
      if (slugCollision) {
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
        if (slugCollision) {
          root.revealAfterLayout(authorForm, advancedFields, authorSlugField, authorSlugField)
        } else {
          root.revealAfterLayout(authorForm, null, null)
        }
      } else if (errorScope === "quote") {
        root.revealAfterLayout(quoteForm, quoteErrorText, quoteSubmitRow)
      } else {
        root.revealAfterLayout(null, statusSlot, null)
      }
    } else {
      error = ""
      errorScope = ""
      if (saving) {
        if (pendingApplyNotice !== "") {
          rotationNotice = pendingApplyNotice
          notice = pendingApplyNotice
          pendingApplyNotice = ""
          savedTimer.stop()
          root.revealAfterLayout(null, statusSlot, null)
        } else {
          rotationNotice = ""
          notice = "Saved"
          savedTimer.restart()
        }
      } else {
        pendingApplyNotice = ""
        rotationNotice = ""
        notice = ""
      }
    }
    saving = false
    addingAuthor = false
    replacingAuthor = false
    addingQuote = false
    activeAuthorSaveSlug = ""
    activeAuthorRemoveSlug = ""
    activeQuoteRemoveId = ""
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
    pendingApplyNotice = typeof parsed.notice === "string" ? parsed.notice : ""
    var saved = parsed.settings && parsed.settings.authors instanceof Array ? parsed.settings.authors : []
    settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : ({})
    samples = parsed.samples instanceof Array ? parsed.samples : []
    portraitFont = Number(parsed.portraitFont) || 8
    portraitLine = Number(parsed.portraitLine) || 11.2
    previewPortraitFont = Number(parsed.previewPortraitFont) || 6
    previewPortraitLine = Number(parsed.previewPortraitLine) || 8.4
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
      missingQuoteFields = []
      quoteValidationError = false
      citationField.text = ""
      textField.text = ""
      if (closingQuote) {
        restoreFormReturnY(function() { root.focusAfterFormClose("quote-opener", "") })
      }
    }
    var savedSlug = ""
    if (addingAuthor || replacingAuthor) {
      let closingAuthor = authorOpen
      savedSlug = activeAuthorSaveSlug !== "" ? activeAuthorSaveSlug : editingAuthorSlug
      clearPortraitPreview()
      authorOpen = false
      authorAdvancedOpen = false
      customAuthorSlug = ""
      missingAuthorFields = []
      authorValidationError = false
      editingAuthorSlug = ""
      editingAuthorOrigName = ""
      editingAuthorOrigDates = ""
      editingAuthorPortrait = ""
      authorNameField.text = ""
      authorSlugField.text = ""
      authorDatesField.text = ""
      authorImageField.text = ""
      authorCitationField.text = ""
      authorTextField.text = ""
      if (closingAuthor) restoreFormReturnY(function() { root.focusAfterFormClose("author-row", savedSlug) })
      else restoreFormReturnY()
    } else if (editingAuthorSlug !== "" && !samples.some(function(author) { return author.slug === root.editingAuthorSlug })) {
      closeAuthorForm()
    } else if (activeAuthorRemoveSlug !== "" && !authorOpen && !quoteOpen && root.opened) {
      let removedGone = !samples.some(function(author) { return author.slug === root.activeAuthorRemoveSlug })
      if (removedGone) {
        let firstRow = authorRows.count > 0 ? authorRows.itemAt(0) : null
        if (firstRow) firstRow.forceActiveFocus()
        else addAuthorButton.takeFocus()
      }
    } else if (activeQuoteRemoveId !== "" && !authorOpen && !quoteOpen && root.opened) {
      let quoteRemovedGone = !custom.some(function(item) { return item.id === root.activeQuoteRemoveId })
      if (quoteRemovedGone) {
        if (custom.length > 0 && customCountToggle.visible) {
          customCountToggle.forceActiveFocus()
          root.reveal(customCountToggle)
        } else {
          addQuoteButton.takeFocus()
          root.reveal(addQuoteButton)
        }
      }
    }
    if (secondsField.field) secondsField.field.value = interval
    if (!hasLocalSize && !resizing && !sizeProcess.running && pendingSizePayload === "") adoptPanelSize(parsed.panelSize)
    adopting = false
    return true
  }

  function toggleAuthor(slug) {
    confirmRemoveAuthor = ""
    clearRotationNotice()
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
      clearValidationState()
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
    clearValidationState()
    applyTimer.restart()
  }

  function applyNow() {
    if (!opened) return
    commitInterval()
    if (!selectedAuthors.length) {
      error = ""
      errorScope = ""
      clearValidationState()
      authorListHint = "Pick at least one author."
      root.reveal(rotationHeaderRow)
      return
    }
    authorListHint = ""
    if (busy) { applyQueued = true; return }
    var payload = {}
    if (pendingAuthor) {
      payload.addAuthor = pendingAuthor
      let hadExplicitAuthors = settings.authors instanceof Array && settings.authors.length > 0
      let selectionChanged = selectedAuthors.join(",") !== committedAuthors.join(",")
      let partialSelection = selectedAuthors.length < samples.length
      if (hadExplicitAuthors || selectionChanged || partialSelection) {
        let nextAuthors = selectedAuthors.slice()
        if (nextAuthors.indexOf(pendingAuthor.slug) === -1) nextAuthors.push(pendingAuthor.slug)
        payload.authors = nextAuthors
      }
      if (intervalApplied && interval !== committedInterval) payload.interval = interval
      activeAuthorSaveSlug = pendingAuthor.slug
      pendingAuthor = null
      addingAuthor = true
      if (pendingReplaceAuthor || pendingRemoveAuthor !== "" || pendingRemove !== "" || pendingQuote) applyQueued = true
    } else if (pendingReplaceAuthor) {
      payload.replaceAuthor = pendingReplaceAuthor
      if (selectedAuthors.join(",") !== committedAuthors.join(",")) payload.authors = selectedAuthors
      if (intervalApplied && interval !== committedInterval) payload.interval = interval
      activeAuthorSaveSlug = pendingReplaceAuthor.slug
      pendingReplaceAuthor = null
      replacingAuthor = true
      if (pendingRemoveAuthor !== "" || pendingRemove !== "" || pendingQuote) applyQueued = true
    } else if (pendingRemoveAuthor !== "") {
      let removeSlug = pendingRemoveAuthor
      let nextWithoutRemoved = selectedAuthors.filter(function(slug) { return slug !== removeSlug })
      let committedWithoutRemoved = committedAuthors.filter(function(slug) { return slug !== removeSlug })
      if (nextWithoutRemoved.length === 0 && committedWithoutRemoved.length > 0) {
        payload.authors = selectedAuthors
        if (intervalApplied && interval !== committedInterval) payload.interval = interval
        applyQueued = true
      } else {
        payload.removeAuthor = removeSlug
        activeAuthorRemoveSlug = removeSlug
        if (nextWithoutRemoved.length > 0 && nextWithoutRemoved.join(",") !== committedWithoutRemoved.join(",")) {
          payload.authors = nextWithoutRemoved
        }
        if (intervalApplied && interval !== committedInterval) payload.interval = interval
        pendingRemoveAuthor = ""
        if (pendingRemove !== "" || pendingQuote) applyQueued = true
      }
    } else {
      payload.authors = selectedAuthors
      if (intervalApplied) payload.interval = interval
      if (pendingRemove !== "") {
        payload.removeQuote = pendingRemove
        activeQuoteRemoveId = pendingRemove
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
    clearValidationState()
    notice = "Saving…"
    resetRun(applyRun)
    applyProcess.command = [command, "panel", "apply", JSON.stringify(payload)]
    applyProcess.running = true
  }

  function toggleQuoteForm() {
    confirmRemoveAuthor = ""
    clearRotationNotice()
    error = ""
    errorScope = ""
    authorListHint = ""
    if (quoteOpen) {
      closeQuoteForm()
      return
    }
    captureFormReturnY()
    cancelImagePick()
    clearPortraitPreview()
    clearPickerNotice()
    authorOpen = false
    missingAuthorFields = []
    authorValidationError = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    editingAuthorPortrait = ""
    quoteOpen = true
    root.revealAfterLayout(quoteForm, quoteForm, citationField, citationField)
  }

  function closeQuoteForm() {
    var wasOpen = quoteOpen
    quoteOpen = false
    missingQuoteFields = []
    quoteValidationError = false
    error = ""
    errorScope = ""
    if (wasOpen) restoreFormReturnY(function() { root.focusAfterFormClose("quote-opener", "") })
    else restoreFormReturnY()
  }

  function addQuote() {
    if (!root.quoteOpen || root.busy) return
    let missingKeys = []
    let missingLabels = []
    let firstMissingField = null
    if (newCitation.trim() === "") {
      missingKeys.push("citation")
      missingLabels.push("Citation")
      if (!firstMissingField) firstMissingField = citationField
    }
    if (newText.trim() === "") {
      missingKeys.push("text")
      missingLabels.push("Quote")
      if (!firstMissingField) firstMissingField = textField
    }
    if (missingKeys.length > 0) {
      notice = ""
      missingQuoteFields = missingKeys
      quoteValidationError = true
      errorScope = "quote"
      error = "Fill in " + joinFieldList(missingLabels) + "."
      root.revealAfterLayout(quoteForm, quoteErrorText, quoteSubmitRow, firstMissingField)
      return
    }
    if (newAuthor === "") {
      notice = ""
      missingQuoteFields = []
      quoteValidationError = false
      errorScope = "quote"
      error = "Pick an author."
      root.revealAfterLayout(quoteForm, quoteErrorText, quoteSubmitRow)
      return
    }
    missingQuoteFields = []
    quoteValidationError = false
    pendingQuote = { author: newAuthor, citation: newCitation.trim(), text: newText.trim() }
    applyNow()
  }

  function openAddAuthor() {
    cancelImagePick()
    clearPortraitPreview()
    clearPickerNotice()
    clearRotationNotice()
    confirmRemoveAuthor = ""
    error = ""
    errorScope = ""
    authorListHint = ""
    missingAuthorFields = []
    authorValidationError = false
    if (authorOpen && editingAuthorSlug === "") {
      closeAuthorForm()
      return
    }
    captureFormReturnY()
    quoteOpen = false
    missingQuoteFields = []
    quoteValidationError = false
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    editingAuthorPortrait = ""
    customAuthorSlug = ""
    authorAdvancedOpen = false
    authorNameField.text = ""
    authorSlugField.text = ""
    authorDatesField.text = ""
    authorImageField.text = ""
    authorCitationField.text = ""
    authorTextField.text = ""
    authorOpen = true
    root.revealAfterLayout(authorForm, authorForm, authorNameField, authorNameField)
  }

  function startEditAuthor(author) {
    cancelImagePick()
    clearPortraitPreview()
    clearPickerNotice()
    clearRotationNotice()
    confirmRemoveAuthor = ""
    error = ""
    errorScope = ""
    authorListHint = ""
    missingAuthorFields = []
    authorValidationError = false
    if (authorOpen && editingAuthorSlug === author.slug) {
      closeAuthorForm()
      return
    }
    captureFormReturnY()
    quoteOpen = false
    missingQuoteFields = []
    quoteValidationError = false
    editingAuthorSlug = author.slug
    editingAuthorOrigName = author.name
    editingAuthorOrigDates = author.dates
    editingAuthorPortrait = String(author.fullPortrait || "")
    customAuthorSlug = ""
    authorAdvancedOpen = false
    authorNameField.text = author.name
    authorSlugField.text = ""
    authorDatesField.text = author.dates
    authorImageField.text = ""
    authorCitationField.text = ""
    authorTextField.text = ""
    authorOpen = true
    root.revealAfterLayout(authorForm, authorForm, authorNameField, authorNameField)
  }

  function closeAuthorForm() {
    var wasOpen = authorOpen
    var editSlug = editingAuthorSlug
    cancelImagePick()
    clearPortraitPreview()
    clearPickerNotice()
    authorOpen = false
    authorAdvancedOpen = false
    missingAuthorFields = []
    authorValidationError = false
    error = ""
    errorScope = ""
    editingAuthorSlug = ""
    editingAuthorOrigName = ""
    editingAuthorOrigDates = ""
    editingAuthorPortrait = ""
    customAuthorSlug = ""
    if (wasOpen) restoreFormReturnY(function() { root.focusAfterFormClose(editSlug !== "" ? "author-edit" : "author-opener", editSlug) })
    else restoreFormReturnY()
  }

  function addAuthor() {
    submitAuthor()
  }

  function submitAuthor() {
    if (!root.authorOpen || root.busy || root.pickingImage) return
    if (editingAuthorSlug !== "") {
      if (newAuthorName.trim() === "") {
        notice = ""
        missingAuthorFields = ["name"]
        authorValidationError = true
        errorScope = "author"
        error = "Fill in Name."
        root.revealAfterLayout(authorForm, authorNameField, null, authorNameField)
        return
      }
      let hasCite = newAuthorCitation.trim() !== ""
      let hasWords = newAuthorText.trim() !== ""
      if (hasCite !== hasWords) {
        notice = ""
        let missingField = hasCite ? authorTextField : authorCitationField
        missingAuthorFields = [hasCite ? "text" : "citation"]
        authorValidationError = true
        errorScope = "author"
        error = hasCite ? "Fill in Quote to match the citation." : "Fill in Citation to match the quote."
        root.revealAfterLayout(authorForm, missingField, null, missingField)
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
        missingAuthorFields = []
        authorValidationError = false
        errorScope = "author"
        error = noAuthorChangesError
        return
      }
      missingAuthorFields = []
      authorValidationError = false
      stopPendingPortraitPreview()
      applyTimer.stop()
      pendingReplaceAuthor = patch
      applyNow()
      return
    }
    let missingKeys = []
    let missingLabels = []
    let firstMissingField = null
    if (newAuthorName.trim() === "") {
      missingKeys.push("name")
      missingLabels.push("Name")
      if (!firstMissingField) firstMissingField = authorNameField
    }
    if (newAuthorImage.trim() === "") {
      missingKeys.push("image")
      missingLabels.push("Portrait image")
      if (!firstMissingField) firstMissingField = authorImageField
    }
    if (newAuthorCitation.trim() === "") {
      missingKeys.push("citation")
      missingLabels.push("Citation")
      if (!firstMissingField) firstMissingField = authorCitationField
    }
    if (newAuthorText.trim() === "") {
      missingKeys.push("text")
      missingLabels.push("Quote")
      if (!firstMissingField) firstMissingField = authorTextField
    }
    if (newAuthorName.trim() !== "" && newAuthorSlug.trim() === "") {
      missingKeys.push("slug")
      missingLabels.push("Author id")
      authorAdvancedOpen = true
      if (!firstMissingField) firstMissingField = authorSlugField
    }
    if (missingKeys.length > 0) {
      notice = ""
      missingAuthorFields = missingKeys
      authorValidationError = true
      errorScope = "author"
      error = (missingKeys.length === 1 && missingKeys[0] === "slug")
        ? "Use letters or numbers in the name, or set an Author id under Advanced."
        : ("Fill in " + joinFieldList(missingLabels) + ".")
      if (firstMissingField === authorSlugField) {
        root.revealAfterLayout(authorForm, advancedFields, authorSlugField, authorSlugField)
      } else {
        root.revealAfterLayout(authorForm, firstMissingField, null, firstMissingField)
      }
      return
    }
    missingAuthorFields = []
    authorValidationError = false
    stopPendingPortraitPreview()
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
    property string accessibleName: ""
    property Item revealLabel: null
    property bool picked: false
    property bool destructive: false
    property bool available: true
    property bool tabFocusable: true
    property bool keepsRemoveConfirm: false
    readonly property bool buttonFocused: inner.activeFocus
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
      activeFocusOnTab: host.tabFocusable && host.available
      bordered: true
      foreground: root.ink
      accent: host.destructive ? Commons.Color.urgent : Commons.Color.accent
      Accessible.role: Accessible.Button
      Accessible.name: host.accessibleName !== "" ? host.accessibleName : host.label
      Accessible.onPressAction: {
        if (!host.available) return
        inner.forceActiveFocus()
        inner.clicked()
      }
      onClicked: {
        if (!host.keepsRemoveConfirm) root.confirmRemoveAuthor = ""
        host.activated()
      }
      onActiveFocusChanged: {
        if (activeFocus) root.reveal(host, host.revealLabel !== null ? host.revealLabel : undefined)
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
      Accessible.ignored: true
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
    property Item labelItem: null
    property string accessibleName: ""
    property bool invalid: false
    readonly property bool editFocused: edit.activeFocus
    readonly property real contentHeight: edit.contentHeight
    readonly property real viewportHeight: areaScroll.height
    signal submitted()
    onLabelItemChanged: edit.syncAccessibleLabel()

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
        Accessible.role: Accessible.EditableText
        Accessible.name: area.accessibleName !== "" ? area.accessibleName : (area.labelItem ? String(area.labelItem.text || "") : "")
        Accessible.description: area.placeholderText
        Accessible.multiLine: true
        function syncAccessibleLabel() {
          if (area.labelItem) edit.Accessible.labelledBy = area.labelItem
        }
        Component.onCompleted: syncAccessibleLabel()
        onActiveFocusChanged: {
          if (activeFocus) {
            root.confirmRemoveAuthor = ""
            root.reveal(area, area.labelItem !== null ? area.labelItem : undefined)
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
          var forward = (event.modifiers & Qt.ShiftModifier) === 0
          var next = edit.nextItemInFocusChain(forward)
          if (next) next.forceActiveFocus(forward ? Qt.TabFocusReason : Qt.BacktabFocusReason)
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
        font.italic: true
        wrapMode: Text.WordWrap
        Accessible.ignored: true
      }
    }

    Rectangle {
      anchors.fill: parent
      anchors.margins: -2
      enabled: false
      color: "transparent"
      radius: Style.cornerRadius
      border.width: (area.invalid || edit.activeFocus) ? 2 : 0
      border.color: area.invalid ? Commons.Color.urgent : Commons.Color.accent
    }
  }

  Timer { id: applyTimer; interval: 300; onTriggered: root.applyNow() }
  Timer {
    id: portraitPreviewTimer
    interval: 250
    onTriggered: root.runPortraitPreview(root.newAuthorImage)
  }
  Timer {
    id: savedTimer
    interval: 2200
    onTriggered: { if (root.notice === "Saved") root.notice = "" }
  }

  QtObject { id: stateRun; property bool exited: false; property int exitCode: 0; property string stdout: ""; property string stderr: ""; property int streamsLeft: 0 }
  QtObject { id: applyRun; property bool exited: false; property int exitCode: 0; property string stdout: ""; property string stderr: ""; property int streamsLeft: 0 }

  Component {
    id: portraitPreviewProcessComponent
    Process {
      id: previewProc
      property int requestId: 0
      property bool cancelled: false
      property bool processExited: false
      property bool settled: false
      property int exitStatus: 0
      property string stdoutText: ""
      property string stderrText: ""
      property int streamsLeft: 2
      stdout: StdioCollector {
        waitForEnd: true
        onStreamFinished: {
          previewProc.stdoutText = String(text || "")
          previewProc.streamsLeft--
          root.settlePortraitPreviewProcess(previewProc)
        }
      }
      stderr: StdioCollector {
        waitForEnd: true
        onStreamFinished: {
          previewProc.stderrText = String(text || "")
          previewProc.streamsLeft--
          root.settlePortraitPreviewProcess(previewProc)
        }
      }
      onExited: function(code) {
        previewProc.exitStatus = code
        previewProc.processExited = true
        root.settlePortraitPreviewProcess(previewProc)
      }
      onRunningChanged: {
        if (previewProc.cancelled && previewProc.running) {
          previewProc.running = false
          return
        }
        if (!previewProc.running && !previewProc.processExited && !previewProc.settled) {
          Qt.callLater(function() {
            if (previewProc && !previewProc.running && !previewProc.processExited && !previewProc.settled) {
              previewProc.processExited = true
              previewProc.exitStatus = 2
              previewProc.streamsLeft = 0
              root.settlePortraitPreviewProcess(previewProc)
            }
          })
        }
      }
    }
  }

  Component {
    id: pickImageProcessComponent
    Process {
      id: proc
      stdinEnabled: true
      property int requestId: 0
      property bool cancelled: false
      property bool processExited: false
      property bool settled: false
      property int exitStatus: 0
      property string stdoutText: ""
      property int streamsLeft: 1
      stdout: StdioCollector {
        waitForEnd: true
        onStreamFinished: {
          proc.stdoutText = String(text || "")
          proc.streamsLeft--
          root.settlePickProcess(proc)
        }
      }
      onExited: function(code) {
        proc.exitStatus = code
        proc.processExited = true
        root.settlePickProcess(proc)
      }
      onRunningChanged: {
        if (proc.cancelled && proc.running) {
          proc.running = false
          return
        }
        if (!proc.running && !proc.processExited && !proc.settled) {
          Qt.callLater(function() {
            if (proc && !proc.running && !proc.processExited && !proc.settled) {
              proc.processExited = true
              proc.exitStatus = 2
              proc.streamsLeft = 0
              root.settlePickProcess(proc)
            }
          })
        }
      }
    }
  }

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
          root.errorScope = ""
          root.error = root.plainError(text, "Could not open the preview.")
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
    visible: root.opened && !root.pickingImage
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omastoic-panel"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.pickingImage ? WlrKeyboardFocus.None : WlrKeyboardFocus.Exclusive

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
          : Math.min(
              content.implicitHeight
                + (authorFooter.visible ? authorFooter.implicitHeight + Style.space(8) : 0)
                + Style.spacing.popupPadding * 2,
              root.maxCardHeight(keyCatcher.height)
            )
        radius: Style.cornerRadius
        color: Commons.Color.popups.background
        border.width: Math.max(1, Style.space(1))
        border.color: Commons.Color.popups.border
        MouseArea { anchors.fill: parent; onClicked: root.confirmRemoveAuthor = "" }

        Flickable {
          id: scroller
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: authorFooter.visible ? authorFooter.top : parent.bottom
          anchors.topMargin: Style.spacing.popupPadding
          anchors.leftMargin: Style.spacing.popupPadding
          anchors.rightMargin: Style.spacing.popupPadding
          anchors.bottomMargin: authorFooter.visible ? Style.space(8) : Style.spacing.popupPadding
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
                      root.clearRotationNotice()
                      root.error = ""
                      root.errorScope = ""
                      root.clearValidationState()
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
                    text: root.preview ? (root.preview.citation !== "" ? (root.authorDisplayName(root.preview) + ", " + root.preview.citation) : root.authorDisplayName(root.preview)) : ""
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
                objectName: "authorHintText"
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
                Accessible.role: Accessible.AlertMessage
                Accessible.name: text
                readonly property string announcedText: root.opened && visible ? text : ""
                onAnnouncedTextChanged: if (announcedText !== "") Accessible.announce(announcedText, Accessible.Assertive)
              }
            }

            Repeater {
              id: authorRows
              model: root.samples
              delegate: Rectangle {
                id: authorRow
                required property var modelData
                readonly property string slug: String(authorRow.modelData.slug || "")
                readonly property bool selected: root.selectedAuthors.indexOf(authorRow.slug) !== -1
                function focusEditButton() { editButton.takeFocus() }
                width: parent.width
                implicitHeight: row.implicitHeight + Style.space(8)
                radius: Style.cornerRadius
                color: {
                  var on = authorRow.selected
                  if (on) return Qt.rgba(Commons.Color.accent.r, Commons.Color.accent.g, Commons.Color.accent.b, 0.16)
                  if (rowPress.containsMouse) return Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08)
                  return "transparent"
                }
                border.width: activeFocus ? Math.max(2, Style.space(2)) : (rowPress.containsMouse ? Math.max(1, Style.space(1)) : 0)
                border.color: activeFocus ? Commons.Color.accent : root.ink
                activeFocusOnTab: true
                Accessible.name: root.authorDisplayName(authorRow.modelData)
                Accessible.role: Accessible.CheckBox
                Accessible.checkable: true
                Accessible.checked: authorRow.selected
                Accessible.onToggleAction: root.toggleAuthor(authorRow.modelData.slug)
                Accessible.onPressAction: root.toggleAuthor(authorRow.modelData.slug)
                onActiveFocusChanged: if (activeFocus) root.reveal(authorRow)

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
                    color: authorRow.selected ? Commons.Color.accent : "transparent"
                    border.width: Math.max(1, Style.space(1))
                    border.color: authorRow.selected ? Commons.Color.accent : root.ink
                    Text {
                      anchors.centerIn: parent
                      visible: authorRow.selected
                      text: "✓"
                      color: Commons.Color.popups.background
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      Accessible.ignored: true
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
                      visible: authorRow.modelData.dates !== "" || root.hasDuplicateAuthorName(authorRow.modelData.name)
                      text: root.authorRowMeta(authorRow.modelData)
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
                      id: editButton
                      label: "Edit"
                      accessibleName: "Edit " + root.authorDisplayName(authorRow.modelData)
                      picked: root.authorOpen && root.editingAuthorSlug === authorRow.modelData.slug
                      available: !root.busy
                      onActivated: root.startEditAuthor(authorRow.modelData)
                    }
                    RingButton {
                      id: removeButton
                      label: root.confirmRemoveAuthor === authorRow.modelData.slug ? "Remove?" : "Remove"
                      accessibleName: "Remove " + root.authorDisplayName(authorRow.modelData) + (root.confirmRemoveAuthor === authorRow.modelData.slug ? "?" : "")
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
                  if ((event.modifiers & Qt.ControlModifier) !== 0) return
                  if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    root.toggleAuthor(modelData.slug)
                    event.accepted = true
                  }
                }
              }
            }

            Text {
              id: secondsLabel
              objectName: "secondsLabel"
              width: parent.width
              visible: root.intervalApplied
              text: "Seconds each quote stays up"
              color: root.quiet
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              Accessible.role: Accessible.StaticText
              Accessible.name: text
            }

            Item {
              width: secondsField.implicitWidth
              height: secondsField.implicitHeight
              visible: root.intervalApplied
              NumberField {
                id: secondsField
                objectName: "secondsField"
                label: ""
                value: root.interval
                from: 5
                to: 3600
                stepSize: 5
                foreground: root.ink
                Component.onCompleted: {
                  if (secondsField.field) {
                    secondsField.field.Accessible.name = Qt.binding(function() { return secondsLabel.text })
                    secondsField.field.Accessible.labelledBy = secondsLabel
                    if (secondsField.field.contentItem) {
                      secondsField.field.contentItem.Accessible.name = Qt.binding(function() { return secondsLabel.text })
                      secondsField.field.contentItem.Accessible.labelledBy = secondsLabel
                    }
                  }
                }
                onModified: function(value) { root.confirmRemoveAuthor = ""; root.interval = value; root.scheduleApply() }
                onActiveFocusChanged: if (activeFocus) root.reveal(secondsField, secondsLabel)
              }
              Connections {
                target: secondsField.field
                function onActiveFocusChanged() {
                  if (secondsField.field && secondsField.field.activeFocus) root.reveal(secondsField, secondsLabel)
                }
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
                id: addQuoteButton
                label: "Add your own quote"
                picked: root.quoteOpen
                onActivated: root.toggleQuoteForm()
              }
              RingButton {
                id: addAuthorButton
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
                id: quoteWhoLabel
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
                    label: root.authorDisplayName(modelData)
                    revealLabel: chipIndex < authorGrid.columns ? quoteWhoLabel : null
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
                id: quoteCitationLabel
                objectName: "quoteCitationLabel"
                text: "Citation"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              Item {
                width: parent.width
                height: citationField.implicitHeight
                TextField {
                  id: citationField
                  objectName: "quoteCitationField"
                  width: parent.width
                  Accessible.name: quoteCitationLabel.text
                  Accessible.description: placeholderText
                  Accessible.labelledBy: quoteCitationLabel
                  placeholderText: "Example: Meditations IV.17"
                  placeholderTextColor: root.hint
                  font.italic: text === ""
                  foreground: root.ink
                  onTextChanged: {
                    root.newCitation = text
                    if (text.trim() !== "") root.clearMissingQuoteField("citation")
                  }
                  Keys.onReturnPressed: root.addQuote()
                  onActiveFocusChanged: if (activeFocus) root.reveal(citationField, quoteCitationLabel)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: (root.isQuoteFieldMissing("citation") || citationField.activeFocus) ? 2 : 0
                  border.color: root.isQuoteFieldMissing("citation") ? Commons.Color.urgent : Commons.Color.accent
                }
              }
              Text {
                id: quoteTextLabel
                objectName: "quoteTextLabel"
                text: "Quote"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              QuoteArea {
                id: textField
                objectName: "quoteTextField"
                width: parent.width
                labelItem: quoteTextLabel
                placeholderText: "Type the quote"
                invalid: root.isQuoteFieldMissing("text")
                onTextChanged: {
                  root.newText = text
                  if (text.trim() !== "") root.clearMissingQuoteField("text")
                }
                onSubmitted: if (!root.busy) root.addQuote()
              }
              Text {
                width: parent.width
                visible: root.newCitation.trim() !== "" || root.newText.trim() !== ""
                text: {
                  var who = ""
                  for (let i = 0; i < root.samples.length; i++) {
                    if (root.samples[i].slug === root.newAuthor) who = root.authorDisplayName(root.samples[i])
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
                objectName: "quoteErrorText"
                width: parent.width
                visible: root.error !== "" && root.errorScope === "quote"
                text: root.error
                color: Commons.Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
                Accessible.role: Accessible.AlertMessage
                Accessible.name: text
                readonly property string announcedText: root.opened && visible ? text : ""
                onAnnouncedTextChanged: if (announcedText !== "") Accessible.announce(announcedText, Accessible.Assertive)
              }
              Row {
                id: quoteSubmitRow
                spacing: Style.space(8)
                RingButton {
                  id: quoteSubmitButton
                  label: "Add quote"
                  available: !root.busy
                  onActivated: root.addQuote()
                }
                RingButton {
                  id: quoteCancelButton
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
                text: "Edit " + root.editingAuthorHeading
                color: root.ink
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                id: authorNameLabel
                objectName: "authorNameLabel"
                text: "Name"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              Item {
                width: parent.width
                height: authorNameField.implicitHeight
                TextField {
                  id: authorNameField
                  objectName: "authorNameField"
                  width: parent.width
                  Accessible.name: authorNameLabel.text
                  Accessible.description: placeholderText
                  Accessible.labelledBy: authorNameLabel
                  placeholderText: "Example: Musonius Rufus"
                  placeholderTextColor: root.hint
                  font.italic: text === ""
                  foreground: root.ink
                  onTextChanged: {
                    root.newAuthorName = text
                    root.clearNoChangeAuthorError()
                    if (text.trim() !== "") root.clearMissingAuthorField("name")
                    if (root.derivedAuthorSlug !== "" || root.customAuthorSlug.trim() !== "") {
                      root.clearMissingAuthorField("slug")
                    }
                    if (root.editingAuthorSlug === "" && text.trim() !== "" && root.derivedAuthorSlug === "" && root.customAuthorSlug.trim() === "") {
                      root.authorAdvancedOpen = true
                    }
                  }
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorNameField, authorNameLabel)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: (root.isAuthorFieldMissing("name") || authorNameField.activeFocus) ? 2 : 0
                  border.color: root.isAuthorFieldMissing("name") ? Commons.Color.urgent : Commons.Color.accent
                }
              }
              Text {
                id: authorDatesLabel
                objectName: "authorDatesLabel"
                text: "Dates (optional)"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              Item {
                width: parent.width
                height: authorDatesField.implicitHeight
                TextField {
                  id: authorDatesField
                  objectName: "authorDatesField"
                  width: parent.width
                  Accessible.name: authorDatesLabel.text
                  Accessible.description: placeholderText
                  Accessible.labelledBy: authorDatesLabel
                  placeholderText: "Example: c. AD 30 – 100"
                  placeholderTextColor: root.hint
                  font.italic: text === ""
                  foreground: root.ink
                  onTextChanged: {
                    root.newAuthorDates = text
                    root.clearNoChangeAuthorError()
                  }
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorDatesField, authorDatesLabel)
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
                id: authorImageLabel
                objectName: "authorImageLabel"
                text: root.editingAuthorSlug !== "" ? "New portrait image (optional, JPEG or PNG)" : "Portrait image (JPEG or PNG)"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              Row {
                id: authorImageRow
                width: parent.width
                spacing: Style.space(8)
                Item {
                  width: Math.max(0, parent.width - chooseImageButton.implicitWidth - Style.space(8))
                  height: Math.max(authorImageField.implicitHeight, chooseImageButton.implicitHeight)
                  TextField {
                    id: authorImageField
                    objectName: "authorImageField"
                    width: parent.width
                    anchors.verticalCenter: parent.verticalCenter
                    Accessible.name: root.editingAuthorSlug !== "" ? "New portrait image path" : "Portrait image path"
                    Accessible.description: placeholderText
                    Accessible.labelledBy: authorImageLabel
                    placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current portrait" : "Choose or type an image path"
                    placeholderTextColor: root.hint
                    font.italic: text === ""
                    foreground: root.ink
                    onTextChanged: {
                      root.newAuthorImage = text
                      root.clearNoChangeAuthorError()
                      if (text.trim() !== "") root.clearMissingAuthorField("image")
                      if (root.notice === root.pickerUnavailableNotice || root.notice === root.pickerUnsupportedNotice) {
                        root.clearPickerNotice()
                        if (activeFocus) root.reveal(authorImageField, authorImageLabel)
                      }
                      root.schedulePortraitPreview(text, false)
                    }
                    onActiveFocusChanged: if (activeFocus) root.reveal(authorImageField, authorImageLabel)
                  }
                  Rectangle {
                    anchors.fill: authorImageField
                    anchors.margins: -2
                    enabled: false
                    color: "transparent"
                    radius: Style.cornerRadius
                    border.width: (root.isAuthorFieldMissing("image") || authorImageField.activeFocus) ? 2 : 0
                    border.color: root.isAuthorFieldMissing("image") ? Commons.Color.urgent : Commons.Color.accent
                  }
                }
                RingButton {
                  id: chooseImageButton
                  anchors.verticalCenter: parent.verticalCenter
                  label: "Choose image"
                  revealLabel: authorImageLabel
                  available: !root.busy && !root.pickingImage
                  onActivated: root.chooseAuthorImage()
                }
              }
              Rectangle {
                id: authorPortraitPreviewBox
                objectName: "authorPortraitPreviewBox"
                width: parent.width
                visible: root.showAuthorPortraitPreview
                implicitHeight: visible ? (previewBoxColumn.implicitHeight + Style.space(16)) : 0
                radius: Style.cornerRadius
                color: Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.04)
                border.width: Math.max(1, Style.space(1))
                border.color: root.portraitPreviewError !== ""
                  ? Commons.Color.urgent
                  : Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.22)

                Column {
                  id: previewBoxColumn
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.top: parent.top
                  anchors.margins: Style.space(8)
                  spacing: Style.space(6)

                  Text {
                    id: authorPortraitPreviewCaption
                    objectName: "authorPortraitPreviewCaption"
                    width: parent.width
                    visible: root.authorPortraitCaption !== ""
                    text: root.authorPortraitCaption
                    color: root.quiet
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                  }

                  Text {
                    id: authorPortraitPreviewText
                    objectName: "authorPortraitPreviewText"
                    visible: root.hasDisplayedAuthorPortrait
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: root.displayedAuthorPortrait
                    opacity: root.portraitPreviewLoading ? 0.45 : 1
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: root.previewPortraitFont
                    lineHeightMode: Text.FixedHeight
                    lineHeight: root.previewPortraitLine
                    wrapMode: Text.NoWrap
                  }

                  Text {
                    id: authorPortraitPreviewErrorText
                    objectName: "authorPortraitPreviewErrorText"
                    width: parent.width
                    visible: root.portraitPreviewError !== "" && !root.portraitPreviewLoading
                    text: root.portraitPreviewError
                    color: Commons.Color.urgent
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.WordWrap
                    Accessible.role: Accessible.AlertMessage
                    Accessible.name: text
                    readonly property string announcedText: root.opened && visible ? text : ""
                    onAnnouncedTextChanged: if (announcedText !== "") Accessible.announce(announcedText, Accessible.Assertive)
                  }
                }
              }
              Text {
                id: authorCitationLabel
                objectName: "authorCitationLabel"
                text: root.editingAuthorSlug !== "" ? "Replacement citation (optional)" : "Citation"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              Item {
                width: parent.width
                height: authorCitationField.implicitHeight
                TextField {
                  id: authorCitationField
                  objectName: "authorCitationField"
                  width: parent.width
                  Accessible.name: authorCitationLabel.text
                  Accessible.description: placeholderText
                  Accessible.labelledBy: authorCitationLabel
                  placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current quotes" : "Example: Lectures VI"
                  placeholderTextColor: root.hint
                  font.italic: text === ""
                  foreground: root.ink
                  onTextChanged: {
                    root.newAuthorCitation = text
                    root.clearNoChangeAuthorError()
                    if (text.trim() !== "") root.clearMissingAuthorField("citation")
                    else if (root.editingAuthorSlug !== "" && root.newAuthorText.trim() === "") root.clearMissingAuthorField("text")
                  }
                  onActiveFocusChanged: if (activeFocus) root.reveal(authorCitationField, authorCitationLabel)
                }
                Rectangle {
                  anchors.fill: parent
                  anchors.margins: -2
                  enabled: false
                  color: "transparent"
                  radius: Style.cornerRadius
                  border.width: (root.isAuthorFieldMissing("citation") || authorCitationField.activeFocus) ? 2 : 0
                  border.color: root.isAuthorFieldMissing("citation") ? Commons.Color.urgent : Commons.Color.accent
                }
              }
              Text {
                id: authorTextLabel
                objectName: "authorTextLabel"
                text: root.editingAuthorSlug !== "" ? "Replacement quote (optional)" : "Quote"
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.role: Accessible.StaticText
                Accessible.name: text
              }
              QuoteArea {
                id: authorTextField
                objectName: "authorTextField"
                width: parent.width
                labelItem: authorTextLabel
                placeholderText: root.editingAuthorSlug !== "" ? "Leave empty to keep current quotes" : "Type the quote"
                invalid: root.isAuthorFieldMissing("text")
                onTextChanged: {
                  root.newAuthorText = text
                  root.clearNoChangeAuthorError()
                  if (text.trim() !== "") root.clearMissingAuthorField("text")
                  else if (root.editingAuthorSlug !== "" && root.newAuthorCitation.trim() === "") root.clearMissingAuthorField("citation")
                }
                onSubmitted: if (!root.busy) root.submitAuthor()
              }
              Rectangle {
                id: advancedToggle
                objectName: "advancedToggle"
                visible: root.editingAuthorSlug === ""
                implicitWidth: advancedLabel.implicitWidth + Style.space(8)
                implicitHeight: advancedLabel.implicitHeight + Style.space(6)
                radius: Style.cornerRadius
                color: advancedHover.containsMouse ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.08) : "transparent"
                border.width: activeFocus ? 2 : 0
                border.color: Commons.Color.accent
                activeFocusOnTab: true
                Accessible.role: Accessible.Button
                Accessible.name: "Advanced"
                Accessible.expandable: true
                Accessible.expanded: root.authorAdvancedOpen
                Accessible.onPressAction: root.toggleAuthorAdvanced()
                onActiveFocusChanged: if (activeFocus) root.reveal(advancedToggle)
                Text {
                  id: advancedLabel
                  anchors.centerIn: parent
                  text: (root.authorAdvancedOpen ? "▾ " : "▸ ") + "Advanced"
                  color: root.quiet
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  Accessible.ignored: true
                }
                MouseArea {
                  id: advancedHover
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleAuthorAdvanced()
                }
                Keys.onPressed: function(event) {
                  if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    root.toggleAuthorAdvanced()
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
                  id: authorSlugLabel
                  objectName: "authorSlugLabel"
                  text: "Author id"
                  color: root.quiet
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  Accessible.role: Accessible.StaticText
                  Accessible.name: text
                }
                Item {
                  width: parent.width
                  height: authorSlugField.implicitHeight
                  TextField {
                    id: authorSlugField
                    objectName: "authorSlugField"
                    width: parent.width
                    Accessible.name: authorSlugLabel.text
                    Accessible.description: placeholderText
                    Accessible.labelledBy: authorSlugLabel
                    placeholderText: root.derivedAuthorSlug !== "" ? ("From name: " + root.derivedAuthorSlug) : "Example: musonius"
                    placeholderTextColor: root.hint
                    font.italic: text === ""
                    foreground: root.ink
                    onTextChanged: {
                      root.customAuthorSlug = text
                      if (text.trim() !== "") root.clearMissingAuthorField("slug")
                    }
                    onActiveFocusChanged: if (activeFocus) root.reveal(authorSlugField, authorSlugLabel)
                  }
                  Rectangle {
                    anchors.fill: parent
                    anchors.margins: -2
                    enabled: false
                    color: "transparent"
                    radius: Style.cornerRadius
                    border.width: (root.isAuthorFieldMissing("slug") || authorSlugField.activeFocus) ? 2 : 0
                    border.color: root.isAuthorFieldMissing("slug") ? Commons.Color.urgent : Commons.Color.accent
                  }
                }
              }
            }

            Rectangle {
              id: customCountToggle
              objectName: "customCountToggle"
              visible: root.custom.length > 0
              implicitWidth: customCountLabel.implicitWidth + Style.space(6)
              implicitHeight: customCountLabel.implicitHeight + Style.space(6)
              radius: Style.cornerRadius
              color: customCountHover.containsMouse ? Qt.rgba(root.ink.r, root.ink.g, root.ink.b, 0.06) : "transparent"
              border.width: activeFocus ? 2 : 0
              border.color: Commons.Color.accent
              activeFocusOnTab: !root.authorOpen
              Accessible.role: Accessible.Button
              Accessible.name: root.custom.length === 1 ? "1 custom quote" : (root.custom.length + " custom quotes")
              Accessible.expandable: true
              Accessible.expanded: root.listOpen
              Accessible.onPressAction: root.toggleCustomList()
              onActiveFocusChanged: if (activeFocus) root.reveal(customCountToggle)
              Text {
                id: customCountLabel
                anchors.centerIn: parent
                text: (root.listOpen ? "▾ " : "▸ ") + (root.custom.length === 1 ? "1 custom quote" : (root.custom.length + " custom quotes"))
                color: root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                Accessible.ignored: true
              }
              MouseArea {
                id: customCountHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.toggleCustomList()
              }
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                  root.toggleCustomList()
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
                    text: root.authorDisplayNameBySlug(customRow.modelData.author, customRow.modelData.name) + ", " + customRow.modelData.citation
                    color: root.ink
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                  }
                  RingButton {
                    label: "Remove"
                    accessibleName: "Remove " + root.authorDisplayNameBySlug(customRow.modelData.author, customRow.modelData.name) + ", " + customRow.modelData.citation
                    tabFocusable: !root.authorOpen
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
                id: statusMessageText
                objectName: "statusMessageText"
                width: parent.width
                text: root.statusText
                color: root.errorShownInStatus ? Commons.Color.urgent : root.quiet
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
                Accessible.role: root.errorShownInStatus ? Accessible.AlertMessage : Accessible.StaticText
                Accessible.name: root.statusText
                readonly property string announcedText: root.opened && text !== "" && text !== "Loading…" && text !== "Saving…" ? text : ""
                onAnnouncedTextChanged: if (announcedText !== "") Accessible.announce(announcedText, root.errorShownInStatus ? Accessible.Assertive : Accessible.Polite)
              }
            }
          }
        }

        Column {
          id: authorFooter
          objectName: "authorFooter"
          visible: root.authorOpen
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.margins: Style.spacing.popupPadding
          spacing: Style.space(8)

          PanelSeparator { foreground: root.ink }

          Text {
            id: authorErrorText
            objectName: "authorErrorText"
            width: parent.width
            visible: root.error !== "" && root.errorScope === "author"
            text: root.error
            color: Commons.Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
            Accessible.role: Accessible.AlertMessage
            Accessible.name: text
            readonly property string announcedText: root.opened && visible ? text : ""
            onAnnouncedTextChanged: if (announcedText !== "") Accessible.announce(announcedText, Accessible.Assertive)
          }

          Row {
            id: authorSubmitRow
            objectName: "authorSubmitRow"
            spacing: Style.space(8)
            RingButton {
              id: authorSubmitButton
              label: root.editingAuthorSlug !== "" ? "Save changes" : "Add author"
              available: !root.busy && !root.pickingImage
              onActivated: root.submitAuthor()
            }
            RingButton {
              id: authorCancelButton
              label: "Cancel"
              onActivated: root.closeAuthorForm()
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
