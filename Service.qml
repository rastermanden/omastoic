import QtQuick
import Quickshell
import Quickshell.Io

// Omarchy clones the repo and loads this service; it never runs install hooks.
// So the first time the plugin is enabled we set up the rotation daemon, the
// menu row and the launcher, and hand the screensaver to the Stoics. Later
// loads only refresh that plumbing — they must not call `on` again, or they
// would steal the slot back after the user switched away.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string command: String(Qt.resolvedUrl("bin/omastoic")).replace(/^file:\/\//, "")

  Process {
    id: setupProcess
    command: [root.command, "setup", "--on-first", "--quiet"]
  }

  Component.onCompleted: setupProcess.running = true
}
