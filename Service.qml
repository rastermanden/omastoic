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
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var pluginRegistry: null
  property string omarchyPath: ""

  readonly property string command: String(Qt.resolvedUrl("bin/omastoic")).replace(/^file:\/\//, "")

  Process {
    id: setupProcess
    command: [root.command, "setup", "--on-first", "--quiet"]
  }

  Component.onCompleted: setupProcess.running = true
}
