#!/usr/bin/env bash
# Remove leftover omastoic files after `omarchy plugin remove`.
# Lives outside the plugin tree so it can still run once the folder is gone.
set -euo pipefail

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}"
PLUGIN_DIR="$CONFIG/omarchy/plugins/omastoic"
PLUGIN="$PLUGIN_DIR/manifest.json"

# The directory existing is enough: a git checkout can briefly unlink
# manifest.json, and pruning then would tear down a live install.
if [[ -e $PLUGIN_DIR || -f $PLUGIN ]]; then
  exit 0
fi
sleep 2
if [[ -e $PLUGIN_DIR || -f $PLUGIN ]]; then
  exit 0
fi

MENU="$CONFIG/omarchy/extensions/omarchy-menu.jsonc"
LAUNCHER="$HOME/.local/bin/omastoic"
BASH_COMPLETION="$DATA/bash-completion/completions/omastoic"
FISH_COMPLETION="$DATA/fish/vendor_completions.d/omastoic.fish"
UNIT="$CONFIG/systemd/user/omastoic.service"
PRUNE_UNIT="$CONFIG/systemd/user/omastoic-prune.service"
PRUNE_PATH="$CONFIG/systemd/user/omastoic-prune.path"
BRANDING="$CONFIG/omarchy/branding/screensaver.txt"
BACKUP="$CONFIG/omarchy/branding/screensaver.txt.pre-omastoic"
WRITTEN="$STATE/omastoic/written.sha"
LIB="$HOME/.local/lib/omastoic"

if command -v omarchy-toggle >/dev/null 2>&1; then
  omarchy-toggle omastoic off >/dev/null 2>&1 || true
fi

if [[ -f $WRITTEN && -f $BRANDING ]]; then
  current=$(sha256sum "$BRANDING" | awk '{print $1}')
  expected=$(tr -d '[:space:]' < "$WRITTEN")
  if [[ $current == "$expected" && -f $BACKUP ]]; then
    cp "$BACKUP" "$BRANDING"
  fi
fi
rm -f "$BACKUP" "$WRITTEN"

if [[ -f $MENU ]]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$MENU" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
nxt = re.sub(
    r"(?:\r?\n)*[ \t]*// >>> omastoic:begin[\s\S]*?// <<< omastoic:end[ \t]*(?=\r?\n|$)",
    "",
    text,
    count=1,
)
if nxt != text:
    path.write_text(nxt)
PY
  else
    sed -i '/\/\/ >>> omastoic:begin/,/\/\/ <<< omastoic:end/d' "$MENU"
  fi
fi

rm -f "$LAUNCHER" "$BASH_COMPLETION" "$FISH_COMPLETION"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now omastoic.service >/dev/null 2>&1 || true
  systemctl --user disable --now omastoic-prune.path >/dev/null 2>&1 || true
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "$UNIT" "$PRUNE_UNIT" "$PRUNE_PATH"

rm -rf "$LIB"
