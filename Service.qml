import QtQuick
import Quickshell
import Quickshell.Io

// Headless singleton (kinds: service). Omarchy injects shell/manifest when it
// creates this item inside omarchy-shell — no second Quickshell process.
//
// The shell has no install hook, so the first enable runs `setup --on-first`:
// launcher, menu row, user systemd unit, and the screensaver slot. Later loads
// only refresh that plumbing. They must not call `on` again, or they would
// steal the slot back after the user switched away.
//
// `omarchy plugin update` git-pulls this tree. The shell reloads QML when it
// notices, but that does not always recreate a service that is already loaded.
// Watching the plugin dir re-runs setup so menu rows, completions and the unit
// follow the new tree without a shell restart.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var pluginRegistry: null
  property string omarchyPath: ""

  readonly property string command: String(Qt.resolvedUrl("bin/omastoic")).replace(/^file:\/\//, "")
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, "")

  function runSetup(onFirst) {
    if (setupProcess.running) {
      setupTimer.restart()
      return
    }
    var args = [root.command, "setup", "--quiet"]
    if (onFirst) args = [root.command, "setup", "--on-first", "--quiet"]
    setupProcess.command = args
    setupProcess.running = true
  }

  Process {
    id: setupProcess
  }

  // A git checkout writes many files; wait until the tree is still, then setup
  // once. Do not pass --on-first: that is only for the first enable.
  Timer {
    id: setupTimer
    interval: 400
    onTriggered: root.runSetup(false)
  }

  FileView {
    path: root.pluginDir
    watchChanges: true
    printErrors: false
    onFileChanged: setupTimer.restart()
  }

  FileView {
    path: root.pluginDir + "/manifest.json"
    watchChanges: true
    printErrors: false
    onFileChanged: setupTimer.restart()
  }

  Component.onCompleted: root.runSetup(true)
}
