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

  // Adding a quote starts with an author: a Stoic, one of yours, or a new one.
  property bool adding: false
  property var myAuthors: []
  property string addAuthorSlug: ""
  property string newCitation: ""
  property string newText: ""
  // The "new author" form inside the add form.
  property bool newAuthorOpen: false
  property string newAuthorName: ""
  property string newAuthorDates: ""
  property string newAuthorImage: ""
  property bool newAuthorDrawing: false
  // An author is created and selected before the CLI has answered, so the quote
  // can be attached to them right away.
  property string pendingAuthor: ""
  property string pendingAuthorName: ""
  property bool picking: false
  // Where a picked picture goes: "" for the new-author form, or an author's slug.
  property string pickFor: ""

  readonly property var authorSlugs: roster.map(function(author) { return author.slug })
    .concat(myAuthors.map(function(author) { return author.slug }))
  readonly property bool authorChosen: addAuthorSlug !== ""
    && (authorSlugs.indexOf(addAuthorSlug) !== -1 || addAuthorSlug === pendingAuthor)
  readonly property string newAuthorSlug: slugFor(newAuthorName)

  function authorBySlug(slug) {
    if (slug === "") return null
    if (slug === pendingAuthor) return { slug: slug, name: pendingAuthorName || slug, dates: "", portrait: false }
    const known = roster.concat(myAuthors).find(function(author) { return author.slug === slug })
    return known || null
  }

  // Why a new author cannot be added yet, or "" when they can.
  readonly property string newAuthorBlock: {
    if (newAuthorName.trim() === "") return "Needs a name."
    const slug = newAuthorSlug
    if (slug === "") return "That name has no letters or numbers to make an author of."
    if (isStoic(slug)) return "That is one of the Stoics — pick their name above."
    if (myAuthors.some(function(author) { return author.slug === slug })) return "You already have that author — pick their name above."
    return ""
  }

  function chooseImage(author) {
    if (picking) return
    pickFor = author || ""
    picking = true
    pickProcess.running = true
  }

  function setPortrait(author, image) {
    send({ kind: "apply", payload: { portrait: { author: author, image: image } }, done: "Portrait saved" })
  }

  function removePortrait(author) {
    send({ kind: "apply", payload: { portrait: { author: author, remove: true } }, done: "Portrait removed" })
  }
  // The quote file keys authors by slug: "Tomas Sowell" becomes tomas-sowell,
  // and a known full or short name becomes that author's slug.
  function slugFor(raw) {
    const typed = String(raw || "").trim().toLowerCase()
    const known = roster.concat(myAuthors).find(function(author) {
      const name = String(author.name).toLowerCase()
      return name === typed || name.split(" ")[0] === typed || author.slug === typed
    })
    return known ? known.slug : slugOf(typed)
  }
  function isStoic(slug) { return roster.some(function(author) { return author.slug === slug }) }

  // Editing one of your quotes in place: click it, change it, Save or Delete.
  property string editingId: ""
  property string editText: ""
  property string editAuthor: ""
  property string editCitation: ""
  property bool confirmDelete: false
  // Keep the quote's own slug unless the author is actually edited: a stored
  // slug like "foo_bar" and its display name "Foo Bar" slugify differently.
  property string editBaseSlug: ""
  property string editBaseName: ""
  readonly property string editSlug: editAuthor === editBaseName && editBaseSlug !== "" ? editBaseSlug : slugFor(editAuthor)
  readonly property bool editReady: editText.trim() !== "" && editCitation.trim() !== "" && editSlug !== ""

  function startEdit(quote) {
    editingId = quote.id
    editText = quote.text
    editAuthor = quote.name
    editCitation = quote.citation
    editBaseSlug = quote.author
    editBaseName = quote.name
    confirmDelete = false
  }

  function stopEdit() {
    editingId = ""
    confirmDelete = false
  }

  function saveEdit() {
    if (!editReady || editingId === "") return
    send({
      kind: "apply",
      payload: { editQuote: { id: editingId, author: editSlug, citation: editCitation.trim(), text: editText.trim() } },
      done: "Quote saved",
      closesEdit: true,
    })
  }

  function deleteEdit() {
    if (editingId === "") return
    if (!confirmDelete) {
      confirmDelete = true
      return
    }
    send({ kind: "apply", payload: { deleteQuote: { id: editingId } }, done: "Quote deleted", closesEdit: true })
  }
  function slugOf(typed) { return typed.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64) }
  readonly property string addBlocker: {
    const missing = []
    if (!authorChosen) missing.push("an author")
    if (newCitation.trim() === "") missing.push("a citation")
    if (newText.trim() === "") missing.push("the quote")
    if (!missing.length) return ""
    return "Needs " + (missing.length === 1 ? missing[0] : missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1]) + "."
  }

  // One line that matches the tags below it.
  readonly property string headline: {
    if (!loaded) return ""
    const who = picked.length === 0 ? "Only yours"
      : picked.length === roster.length ? "All six Stoics"
      : roster.filter(function(author) { return picked.indexOf(author.slug) !== -1 }).map(shortName).join(", ")
    return who + " · " + rotatingCount + " of " + quotes.length + " quotes in rotation"
  }

  function hasPortrait(slug) {
    if (myAuthors.some(function(author) { return author.slug === slug && author.portrait })) return true
    return quotes.some(function(quote) { return quote.author === slug && quote.portrait })
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
    newAuthorOpen = false
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
      if (job.addedAuthor) {
        pendingAuthor = ""
        pendingAuthorName = ""
        addAuthorSlug = ""
      }
      if (job.kind !== "state") Qt.callLater(reload)
    } else if (!adoptState(run.stdout)) {
      error = "Could not read the omastoic state."
    } else if (job.kind !== "state") {
      notice = job.done || "Saved"
      noticeTimer.restart()
      if (job.closesEdit) stopEdit()
      if (job.addedAuthor) {
        pendingAuthor = ""
        pendingAuthorName = ""
        newAuthorOpen = false
        newAuthorName = ""
        newAuthorDates = ""
        newAuthorImage = ""
        newAuthorDrawing = false
        newAuthorField.text = ""
        newAuthorDatesField.text = ""
        newAuthorImageField.text = ""
      }
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
    maybePreview()
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
    myAuthors = parsed.myAuthors instanceof Array ? parsed.myAuthors : []
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

  // Test the result: let pending saves land, close the panel, start the saver.
  property bool previewWanted: false
  function startScreensaver() {
    if (intervalTimer.running) {
      intervalTimer.stop()
      intervalTimer.triggered()
    }
    previewWanted = true
    busyLabel = busy ? busyLabel : "Starting…"
    maybePreview()
  }

  function maybePreview() {
    if (!previewWanted || queue.length || stateProcess.running || applyProcess.running) return
    previewWanted = false
    busyLabel = ""
    dismiss()
    Quickshell.execDetached([command, "preview"])
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
      done: next.length ? "Saved" : "Only yours now",
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
      payload: { addQuote: { author: addAuthorSlug, citation: newCitation.trim(), text: newText.trim() } },
      done: "Added. It is in rotation.",
      added: true,
    })
  }

  // A new author: saved first, then selected, so the quote attaches to them.
  function createAuthor() {
    if (newAuthorBlock !== "" || !newAuthorOpen) return
    const slug = newAuthorSlug
    pendingAuthor = slug
    pendingAuthorName = newAuthorName.trim()
    addAuthorSlug = slug
    send({
      kind: "apply",
      payload: { addAuthor: newAuthorImage.trim()
        ? { slug: slug, name: newAuthorName.trim(), dates: newAuthorDates.trim(), image: newAuthorImage.trim(), drawing: newAuthorDrawing }
        : { slug: slug, name: newAuthorName.trim(), dates: newAuthorDates.trim() } },
      done: newAuthorImage.trim() ? "Author added, with a portrait." : "Author added.",
      addedAuthor: true,
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

  // Omarchy's own image grid over the usual picture folders; it prints the pick.
  Process {
    id: pickProcess
    command: ["bash", "-c", 'dirs=(); for d in "$HOME/Pictures" "$HOME/Pictures/Screenshots" "$HOME/Downloads" "$HOME/Desktop"; do [[ -d $d ]] && dirs+=("$d"); done; ((${#dirs[@]})) || exit 3; exec omarchy-menu-images --show-labels --filterable "${dirs[@]}"']
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        const chosen = String(text || "").trim()
        if (chosen === "") return
        if (root.pickFor === "") newAuthorImageField.text = chosen
        else root.setPortrait(root.pickFor, chosen)
      }
    }
    onExited: function(exitCode) {
      root.picking = false
      if (exitCode === 3) root.error = "No Pictures, Downloads or Desktop folder to choose from. Type the picture's path instead."
      else if (exitCode !== 0) root.error = "Omarchy's image picker did not open. Type the picture's path instead."
      if (root.pickFor === "") Qt.callLater(function() { if (root.opened) newAuthorImageField.forceActiveFocus() })
    }
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

    // Hidden, not closed, while Omarchy's image picker is up, so the form keeps what was typed.
    visible: root.opened && !root.picking
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

      Keys.onEscapePressed: root.editingId !== "" ? root.stopEdit() : root.adding ? root.adding = false : root.dismiss()

      Rectangle {
        id: card

        readonly property real pad: Style.spacing.popupPadding
        anchors.centerIn: parent
        width: Math.min(Style.space(620), keyCatcher.width - Style.space(48))
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
          spacing: Style.space(8)

          // Header: title, one-line status, and the summary that never truncates.
          Item {
            width: parent.width
            height: Math.max(titleText.implicitHeight, previewButton.height)

            Text {
              id: titleText
              text: "Stoics"
              color: Commons.Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Button {
              id: previewButton
              anchors.right: parent.right
              anchors.verticalCenter: titleText.verticalCenter
              text: "▶ Start screensaver"
              tooltipText: "Save, close this panel and show the Stoics now"
              bordered: true
              enabled: root.loaded && !root.previewWanted
              foreground: Commons.Color.popups.text
              fontSize: Style.font.bodySmall
              onClicked: root.startScreensaver()
            }

            Text {
              id: statusText
              anchors.right: previewButton.left
              anchors.rightMargin: Style.space(10)
              anchors.verticalCenter: titleText.verticalCenter
              text: root.busy ? root.busyLabel : root.notice !== "" ? "✓ " + root.notice : ""
              color: root.notice !== "" && !root.busy ? Commons.Color.accent : Qt.darker(Commons.Color.popups.text, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            // Seconds per quote: the one number in the header.
            Row {
              id: secondsRow
              anchors.right: statusText.left
              anchors.rightMargin: Style.space(12)
              anchors.verticalCenter: titleText.verticalCenter
              spacing: Style.space(6)

              Caption {
                height: secondsField.height
                verticalAlignment: Text.AlignVCenter
                text: "every"
              }

              NumberField {
                id: secondsField
                value: 60
                from: 1
                to: 3600
                stepSize: 5
                fieldWidth: Style.space(64)
                foreground: Commons.Color.popups.text
                onModified: function(value) { root.changeSeconds(value) }
              }

              Caption {
                height: secondsField.height
                verticalAlignment: Text.AlignVCenter
                text: "s"
              }
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

          // Rotation: one chip per Stoic, one for your own quotes.
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
              text: "Yours " + root.mine.length
              tooltipText: root.mineSwitchable.length ? "Switch all of yours on or off" : "Add a quote first"
              bordered: true
              selected: root.mineOn
              enabled: root.mineSwitchable.length > 0
              foreground: Commons.Color.popups.text
              fontSize: Style.font.bodySmall
              horizontalPadding: Style.space(8)
              onClicked: root.toggleMine()
            }
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
                { value: "mine", label: "Yours " + root.mine.length }
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
                if (root.adding) Qt.callLater(function() { textField.forceActiveFocus() })
              }
            }
          }

          // The add form: pick or add the author first, then attach the quote to them.
          Rectangle {
            width: parent.width
            visible: root.adding
            height: visible ? addForm.implicitHeight + Style.space(12) : 0
            radius: Style.cornerRadius
            color: "transparent"
            border.width: Math.max(1, Style.space(1))
            border.color: Commons.Color.popups.border

            Column {
              id: addForm
              anchors.fill: parent
              anchors.margins: Style.space(8)
              spacing: Style.space(6)

              Flow {
                width: parent.width
                spacing: Style.space(6)

                Repeater {
                  model: root.roster
                  delegate: Button {
                    required property var modelData
                    text: root.shortName(modelData)
                    tooltipText: modelData.name + " · " + modelData.dates
                    bordered: true
                    selected: root.addAuthorSlug === modelData.slug
                    foreground: Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    horizontalPadding: Style.space(8)
                    onClicked: {
                      root.addAuthorSlug = modelData.slug
                      root.newAuthorOpen = false
                    }
                  }
                }

                Repeater {
                  model: root.myAuthors
                  delegate: Button {
                    required property var modelData
                    text: modelData.name
                    tooltipText: modelData.quotes + (modelData.quotes === 1 ? " quote" : " quotes")
                      + (modelData.portrait ? " · has a portrait" : " · no portrait")
                    bordered: true
                    selected: root.addAuthorSlug === modelData.slug
                    foreground: Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    horizontalPadding: Style.space(8)
                    onClicked: {
                      root.addAuthorSlug = modelData.slug
                      root.newAuthorOpen = false
                    }
                  }
                }

                Button {
                  text: "+ New author"
                  tooltipText: "Add an author of your own, with an optional picture"
                  bordered: true
                  selected: root.newAuthorOpen
                  foreground: Commons.Color.popups.text
                  fontSize: Style.font.bodySmall
                  horizontalPadding: Style.space(8)
                  onClicked: {
                    root.newAuthorOpen = !root.newAuthorOpen
                    if (root.newAuthorOpen) Qt.callLater(function() { if (root.opened) newAuthorField.forceActiveFocus() })
                  }
                }
              }

              // A new author: a name, optional dates and an optional picture.
              Rectangle {
                width: parent.width
                visible: root.newAuthorOpen
                height: visible ? newAuthorForm.implicitHeight + Style.space(12) : 0
                radius: Style.cornerRadius
                color: "transparent"
                border.width: Math.max(1, Style.space(1))
                border.color: Commons.Color.popups.border

                Column {
                  id: newAuthorForm
                  anchors.fill: parent
                  anchors.margins: Style.space(8)
                  spacing: Style.space(6)

                  Row {
                    width: parent.width
                    spacing: Style.space(8)

                    TextField {
                      id: newAuthorField
                      width: (parent.width - parent.spacing) * 0.6
                      placeholderText: "Author's name, e.g. Tomas Sowell"
                      foreground: Commons.Color.popups.text
                      onTextChanged: root.newAuthorName = text
                      onAccepted: root.createAuthor()
                    }

                    TextField {
                      id: newAuthorDatesField
                      width: parent.width - newAuthorField.width - parent.spacing
                      placeholderText: "Dates (optional)"
                      foreground: Commons.Color.popups.text
                      onTextChanged: root.newAuthorDates = text
                      onAccepted: root.createAuthor()
                    }
                  }

                  Row {
                    width: parent.width
                    spacing: Style.space(8)

                    TextField {
                      id: newAuthorImageField
                      width: parent.width - newAuthorChoose.width - newAuthorDrawingButton.width - parent.spacing * 2
                      placeholderText: "Picture for their portrait (optional)"
                      foreground: Commons.Color.popups.text
                      onTextChanged: root.newAuthorImage = text
                      onAccepted: root.createAuthor()
                    }

                    Button {
                      id: newAuthorChoose
                      text: "Choose…"
                      tooltipText: "Pick from Pictures, Downloads or Desktop"
                      bordered: true
                      enabled: !root.picking
                      foreground: Commons.Color.popups.text
                      fontSize: Style.font.bodySmall
                      onClicked: root.chooseImage("")
                    }

                    Button {
                      id: newAuthorDrawingButton
                      text: "Drawing"
                      tooltipText: "Line art: sharp strokes instead of photo shading"
                      bordered: true
                      selected: root.newAuthorDrawing
                      foreground: Commons.Color.popups.text
                      fontSize: Style.font.bodySmall
                      onClicked: root.newAuthorDrawing = !root.newAuthorDrawing
                    }
                  }

                  Item {
                    width: parent.width
                    height: Math.max(newAuthorHint.implicitHeight, newAuthorCreate.height)

                    Caption {
                      id: newAuthorHint
                      anchors.left: parent.left
                      anchors.right: newAuthorCreate.left
                      anchors.rightMargin: Style.space(8)
                      anchors.verticalCenter: parent.verticalCenter
                      text: root.newAuthorBlock !== "" ? root.newAuthorBlock
                        : "Saved as “" + root.newAuthorSlug + "”."
                          + (root.newAuthorImage.trim() !== "" ? " Their portrait is set." : " No picture yet.")
                    }

                    Button {
                      id: newAuthorCreate
                      anchors.right: parent.right
                      text: "Add author"
                      bordered: true
                      enabled: root.newAuthorBlock === ""
                      foreground: Commons.Color.popups.text
                      fontSize: Style.font.bodySmall
                      onClicked: root.createAuthor()
                    }
                  }
                }
              }

              // The chosen author, and a portrait for them when they have none.
              Item {
                width: parent.width
                height: Math.max(addAuthorHint.implicitHeight, addAuthorPicture.height)

                Caption {
                  id: addAuthorHint
                  anchors.left: parent.left
                  anchors.right: addAuthorPicture.visible ? addAuthorPicture.left : parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  text: {
                    var author = root.authorBySlug(root.addAuthorSlug)
                    if (!author) return "Pick who said it above, or add an author of your own."
                    if (root.isStoic(author.slug)) return author.name + " uses their own portrait."
                    return author.name + (root.hasPortrait(author.slug) ? " has a portrait." : " has no portrait yet.")
                  }
                }

                Button {
                  id: addAuthorPicture
                  anchors.right: parent.right
                  visible: root.addAuthorSlug !== "" && !root.isStoic(root.addAuthorSlug) && !root.hasPortrait(root.addAuthorSlug)
                  text: "Add picture…"
                  tooltipText: "A portrait for every quote by this author"
                  bordered: true
                  enabled: !root.picking
                  foreground: Commons.Color.popups.text
                  fontSize: Style.font.bodySmall
                  onClicked: root.chooseImage(root.addAuthorSlug)
                }
              }

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
                  id: citationField
                  width: parent.width - addConfirm.width - parent.spacing
                  placeholderText: "Source, e.g. Letters 1"
                  foreground: Commons.Color.popups.text
                  onTextChanged: root.newCitation = text
                  onAccepted: root.addQuote()
                }

                Button {
                  id: addConfirm
                  text: "Add"
                  bordered: true
                  enabled: root.addBlocker === ""
                  foreground: Commons.Color.popups.text
                  fontSize: Style.font.bodySmall
                  onClicked: root.addQuote()
                }
              }

              Caption {
                id: addHint
                width: parent.width
                visible: root.addBlocker !== ""
                text: root.addBlocker
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
            height: Math.min(contentHeight, Math.max(Style.space(140), keyCatcher.height * 0.34))
            clip: true
            spacing: Style.space(2)
            boundsBehavior: Flickable.StopAtBounds
            model: root.shownQuotes

            delegate: Rectangle {
              id: quoteRow
              required property var modelData
              readonly property bool open: !!root.expanded[modelData.id]
              readonly property bool editing: root.editingId === modelData.id
              width: quoteView.width
              height: (editing ? editor.implicitHeight : rowBody.implicitHeight) + Style.space(8)
              radius: Style.cornerRadius
              color: rowMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.04) : "transparent"

              MouseArea {
                id: rowMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                // Yours open for editing; the Stoics' open to their full text.
                onClicked: {
                  if (quoteRow.modelData.custom) {
                    if (!quoteRow.editing) root.startEdit(quoteRow.modelData)
                    return
                  }
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
                visible: quoteRow.modelData.switchable && !quoteRow.editing
                foreground: Commons.Color.popups.text
                onToggled: root.keep(quoteRow.modelData.id, !quoteRow.modelData.kept)
              }

              Column {
                id: rowBody
                visible: !quoteRow.editing
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
                      + (quoteRow.modelData.portrait ? "" : " · no portrait")
                      + (quoteRow.modelData.inRotation ? ""
                        : !quoteRow.modelData.kept ? " · off"
                        : " · " + root.shortName(quoteRow.modelData) + " not picked")
                  }
                }
              }

              Column {
                id: editor
                visible: quoteRow.editing
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.margins: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)

                TextField {
                  width: parent.width
                  text: quoteRow.editing ? root.editText : ""
                  placeholderText: "The quote"
                  foreground: Commons.Color.popups.text
                  onTextEdited: { root.editText = text; root.confirmDelete = false }
                  onAccepted: root.saveEdit()
                }

                Row {
                  width: parent.width
                  spacing: Style.space(8)

                  TextField {
                    width: (parent.width - parent.spacing) / 2
                    text: quoteRow.editing ? root.editAuthor : ""
                    placeholderText: "Author"
                    foreground: Commons.Color.popups.text
                    onTextEdited: { root.editAuthor = text; root.confirmDelete = false }
                    onAccepted: root.saveEdit()
                  }

                  TextField {
                    width: (parent.width - parent.spacing) / 2
                    text: quoteRow.editing ? root.editCitation : ""
                    placeholderText: "Source"
                    foreground: Commons.Color.popups.text
                    onTextEdited: { root.editCitation = text; root.confirmDelete = false }
                    onAccepted: root.saveEdit()
                  }
                }

                Flow {
                  width: parent.width
                  spacing: Style.space(8)

                  Button {
                    text: "Save"
                    bordered: true
                    enabled: root.editReady
                    foreground: Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    onClicked: root.saveEdit()
                  }

                  Button {
                    text: "Cancel"
                    bordered: true
                    foreground: Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    onClicked: root.stopEdit()
                  }

                  // A picture is the author's portrait, for every quote by them.
                  Button {
                    visible: root.editSlug !== "" && !root.isStoic(root.editSlug)
                    text: root.hasPortrait(root.editSlug) ? "Change picture…" : "Add picture…"
                    tooltipText: "The portrait for every quote by this author"
                    bordered: true
                    enabled: !root.picking
                    foreground: Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    onClicked: root.chooseImage(root.editSlug)
                  }

                  Button {
                    visible: root.editSlug !== "" && !root.isStoic(root.editSlug) && root.hasPortrait(root.editSlug)
                    text: "Remove picture"
                    bordered: true
                    foreground: Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    onClicked: root.removePortrait(root.editSlug)
                  }

                  Button {
                    text: root.confirmDelete ? "Really delete?" : "Delete"
                    bordered: true
                    foreground: root.confirmDelete ? Commons.Color.urgent : Commons.Color.popups.text
                    fontSize: Style.font.bodySmall
                    onClicked: root.deleteEdit()
                  }
                }

                Caption {
                  width: parent.width
                  text: root.isStoic(root.editSlug) ? "Shown with " + root.editAuthor.trim() + "'s portrait. Esc or Cancel keeps it as it was."
                    : root.hasPortrait(root.editSlug) ? "Esc or Cancel keeps it as it was."
                    : "No portrait for this author yet: Add picture gives them one."
                }
              }
            }
          }

          Caption {
            width: parent.width
            visible: root.loaded && root.shownQuotes.length === 0
            text: root.listFilter === "mine" && root.mine.length === 0 ? "None of yours yet. Use + Add quote."
              : root.picked.length === 0 && root.mine.length === 0 ? "No Stoics picked. Click a name above, or use + Add quote."
              : "No quote matches."
          }
        }
      }
    }
  }
}
