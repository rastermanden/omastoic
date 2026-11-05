#!/usr/bin/env bash
# Independent of Bun and the plugin tree. Also reconciles disable: hot reload
# leaves shell.json enabled, so destroying/recreating the QML item is a no-op.
set -euo pipefail
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/omastoic"
PLUGIN_DIR="$CONFIG/omarchy/plugins/io.github.rastermanden.omastoic"
LEGACY_DIR="$CONFIG/omarchy/plugins/omastoic"
SHELL_CONFIG="$CONFIG/omarchy/shell.json"

installed() { [[ -e $PLUGIN_DIR || -e $LEGACY_DIR ]]; }
active() {
  # A transient/invalid config is not evidence that the plugin was disabled.
  [[ -f $SHELL_CONFIG ]] || return 0
  jq -e 'type == "object" and ((.plugins // []) | type == "array")' "$SHELL_CONFIG" >/dev/null 2>&1 || return 0
  jq -e 'any(.plugins[]?; (.id == "io.github.rastermanden.omastoic" or .id == "omastoic") and .enabled != false)' "$SHELL_CONFIG" >/dev/null || return 1
  # Host branding commands (including Restore Default) win even when no saver
  # window is open. The path unit watches this file as well as shell.json.
  if [[ -f $STATE/written.sha ]]; then
    [[ -f $CONFIG/omarchy/branding/screensaver.txt ]] || return 1
    local current expected
    current=$(sha256sum "$CONFIG/omarchy/branding/screensaver.txt"); current=${current%% *}
    expected=$(< "$STATE/written.sha")
    [[ $current == "$expected" ]] || return 1
  fi
  return 0
}
if installed && active; then exit 0; fi
# Let a checkout/remove+add or an atomic config replacement settle.
sleep 2
if installed && active; then exit 0; fi

mkdir -p "$STATE"
exec 9>"$STATE/transaction.flock"
flock --exclusive --wait 15 9 || { echo 'omastoic: cleanup busy; retry prune.sh' >&2; exit 1; }
trap '[[ -z ${temp:-} ]] || rm -f -- "$temp"' EXIT
if installed && active; then exit 0; fi

owns() {
  local id=$1 path=$2 current expected
  [[ -f $path && ! -L $path && -f $STATE/owned/$id ]] || return 1
  current=$(sha256sum "$path"); current=${current%% *}
  expected=$(< "$STATE/owned/$id")
  [[ $current == "$expected" ]]
}
remove_owned() {
  if owns "$1" "$2"; then rm -f "$2"; fi
  rm -f "$STATE/owned/$1"
}
UNIT="$CONFIG/systemd/user/omastoic.service"
PRUNE_PATH="$CONFIG/systemd/user/omastoic-prune.path"
PRUNE_UNIT="$CONFIG/systemd/user/omastoic-prune.service"
BRANDING="$CONFIG/omarchy/branding/screensaver.txt"
BACKUP="$BRANDING.pre-omastoic"

# Fail loudly and retain units/records if systemd cannot stop the service.
if owns unit "$UNIT"; then systemctl --user disable --now omastoic.service; fi
if command -v omarchy-toggle >/dev/null 2>&1; then omarchy-toggle omastoic off; fi
if [[ -f $STATE/written.sha && -f $BRANDING ]]; then
  current=$(sha256sum "$BRANDING"); current=${current%% *}
  expected=$(< "$STATE/written.sha")
  if [[ $current == "$expected" ]]; then
    if [[ -f $STATE/displaced.kind && $(< "$STATE/displaced.kind") == absent ]]; then
      rm -f "$BRANDING"
    elif owns backup "$BACKUP"; then
      temp=$(mktemp "$BRANDING.omastoic-prune-XXXXXXXX")
      cp "$BACKUP" "$temp"
      mv "$temp" "$BRANDING"
    elif [[ -f $STATE/displaced.kind && $(< "$STATE/displaced.kind") == file ]]; then
      echo "omastoic: displaced branding backup changed or is missing: $BACKUP; restore it and retry cleanup" >&2
      exit 1
    fi
  fi
fi
remove_owned backup "$BACKUP"
rm -f "$STATE/written.sha" "$STATE/displaced.kind"
# Disable keeps plumbing for re-enable; remove tears it down entirely.
if installed; then exit 0; fi

if owns prune-path "$PRUNE_PATH"; then systemctl --user disable --now omastoic-prune.path; fi
MENU="$CONFIG/omarchy/extensions/omarchy-menu.jsonc"
if [[ -f $MENU ]]; then
  # jq is already a host dependency. Python preserves comments/whitespace and
  # validates the host JSONC grammar before atomically replacing the document.
  python3 - "$MENU" <<'PY'
import json, os, pathlib, re, sys, tempfile
path = pathlib.Path(sys.argv[1])
text = path.read_text()
nxt = re.sub(r"\n  // >>> omastoic:begin v2[^\n]*\n[\s\S]*?  // <<< omastoic:end\n", "", text, count=1)
if nxt == text:
    nxt = re.sub(r"(?:\r?\n)*[ \t]*// >>> omastoic:begin[^\n]*\n[\s\S]*?// <<< omastoic:end[ \t]*(?=\r?\n|$)", "", text, count=1)
if nxt != text:
    stripped = re.sub(r"^\s*//[^\n]*(\n|$)", "", nxt, flags=re.M)
    if stripped.strip(): json.loads(re.sub(r",(\s*[}\]])", r"\1", stripped))
    fd, temp = tempfile.mkstemp(prefix=".omastoic-menu-", dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream: stream.write(nxt)
        if path.read_text() != text: raise RuntimeError('menu changed during cleanup; retry')
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)
PY
fi
LAUNCHER="$HOME/.local/bin/omastoic"
if [[ -L $LAUNCHER && -f $STATE/launcher.target && $(readlink "$LAUNCHER") == "$(< "$STATE/launcher.target")" ]]; then rm -f "$LAUNCHER"; fi
remove_owned bash "$DATA/bash-completion/completions/omastoic"
remove_owned fish "$DATA/fish/vendor_completions.d/omastoic.fish"
remove_owned unit "$UNIT"
remove_owned prune-unit "$PRUNE_UNIT"
remove_owned prune-path "$PRUNE_PATH"
remove_owned prune-script "$HOME/.local/lib/omastoic/prune.sh"
rm -f "$STATE/installed" "$STATE/launcher.target"
systemctl --user daemon-reload
