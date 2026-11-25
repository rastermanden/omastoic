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

is_truthy_env() {
  case "${1:-}" in
    ""|0|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]) return 1 ;;
    *) return 0 ;;
  esac
}

is_system_binary() {
  case "$1" in
    /usr/*|/bin/*|/sbin/*|/run/current-system/*|/nix/store/*) return 0 ;;
    *) return 1 ;;
  esac
}

passwd_home() {
  local uid line="" home=""
  uid=$(id -u)
  if command -v getent >/dev/null 2>&1; then
    line=$(getent passwd "$uid" 2>/dev/null || true)
    if [[ -n $line ]]; then
      IFS=: read -r _ _ _ _ _ home _ <<< "$line" || true
    fi
  fi
  if [[ -z $home && -r /etc/passwd ]]; then
    home=$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null || true)
  fi
  printf '%s' "$home"
}

canonical_path() {
  local p="$1"
  readlink -f -- "$p" 2>/dev/null || { [[ $p == "/" ]] && printf '/' || printf '%s' "${p%/}"; }
}

should_skip_systemctl() {
  if is_truthy_env "${OMASTOIC_NO_SYSTEMCTL:-}"; then return 0; fi
  local bin resolved
  bin=$(command -v systemctl 2>/dev/null || true)
  [[ -n $bin ]] || return 0
  resolved=$(canonical_path "$bin")
  if ! is_system_binary "$resolved"; then return 1; fi
  case "${NODE_ENV:-}" in [Tt][Ee][Ss][Tt]) return 0 ;; esac
  case "${BUN_ENV:-}" in [Tt][Ee][Ss][Tt]) return 0 ;; esac
  [[ -n ${HOME:-} ]] || return 0
  local pw_home
  pw_home=$(passwd_home)
  if [[ -n $pw_home && $(canonical_path "$HOME") != "$(canonical_path "$pw_home")" ]]; then
    return 0
  fi
  return 1
}

run_systemctl() {
  if should_skip_systemctl; then return 0; fi
  systemctl "$@"
}

# Fail loudly and retain units/records if systemd cannot stop the service.
if owns unit "$UNIT"; then run_systemctl --user disable --now omastoic.service; fi
if command -v omarchy-toggle >/dev/null 2>&1; then omarchy-toggle omastoic off; fi

still_ours() {
  [[ -f $STATE/written.sha && -e $BRANDING ]] || return 1
  local current expected
  current=$(sha256sum -- "$BRANDING"); current=${current%% *}
  expected=$(< "$STATE/written.sha")
  [[ $current == "$expected" ]]
}
# A symlink stays a symlink. The bytes land on its target.
commit_branding() {
  local payload=$1 final=$BRANDING
  if [[ -L $BRANDING ]]; then
    final=$(readlink -f -- "$BRANDING") || {
      echo "omastoic: screensaver symlink is dangling — leaving it and keeping the backup" >&2
      return 1
    }
    if [[ ! -f $final || -L $final ]]; then
      echo "omastoic: screensaver symlink does not point at a regular file — leaving it and keeping the backup" >&2
      return 1
    fi
  elif [[ -e $BRANDING && ! -f $BRANDING ]]; then
    echo "omastoic: screensaver path is not a regular file — leaving it and keeping the backup" >&2
    return 1
  fi
  if ! still_ours; then
    echo "omastoic: the screensaver file changed after we wrote it — leaving it in place and keeping the backup" >&2
    return 1
  fi
  local tmp
  tmp=$(mktemp "${final}.omastoic-XXXXXXXX") || return 2
  # set -e does not apply while this function runs from `if commit_branding`.
  if ! cp -- "$payload" "$tmp"; then
    rm -f -- "$tmp"
    echo "omastoic: could not copy the screensaver backup — leaving the active file and the backup" >&2
    return 2
  fi
  local src_size tmp_size
  src_size=$(stat -c '%s' -- "$payload") || { rm -f -- "$tmp"; return 2; }
  tmp_size=$(stat -c '%s' -- "$tmp") || { rm -f -- "$tmp"; return 2; }
  if [[ $src_size != "$tmp_size" ]] || ! cmp -s -- "$payload" "$tmp"; then
    rm -f -- "$tmp"
    echo "omastoic: screensaver backup copy was incomplete — leaving the active file and the backup" >&2
    return 2
  fi
  if ! python3 -c 'import os,sys; fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)' "$tmp"; then
    rm -f -- "$tmp"
    echo "omastoic: could not commit the screensaver backup copy — leaving the active file and the backup" >&2
    return 2
  fi
  if [[ -n ${OMASTOIC_BEFORE_BRANDING_REPLACE:-} ]]; then
    if ! bash -c "$OMASTOIC_BEFORE_BRANDING_REPLACE"; then
      rm -f -- "$tmp"
      echo "omastoic: could not finish the screensaver restore — leaving the active file and the backup" >&2
      return 2
    fi
  fi
  if ! still_ours; then
    rm -f -- "$tmp"
    echo "omastoic: the screensaver file changed after we wrote it — leaving it in place and keeping the backup" >&2
    return 1
  fi
  if ! mv -- "$tmp" "$final"; then
    rm -f -- "$tmp"
    echo "omastoic: could not replace the screensaver file — leaving the active file and the backup" >&2
    return 2
  fi
}
clear_branding() {
  if ! still_ours; then
    echo "omastoic: the screensaver file changed after we wrote it — leaving it in place and keeping the backup" >&2
    return 1
  fi
  if [[ -L $BRANDING ]]; then
    # Remove the link, not the file it names. Deleting that file would leave
    # the link dangling and could remove a canvas the user moved aside.
    if ! still_ours; then
      echo "omastoic: the screensaver file changed after we wrote it — leaving it in place and keeping the backup" >&2
      return 1
    fi
    if ! rm -f -- "$BRANDING"; then
      echo "omastoic: could not remove the screensaver link — leaving it in place" >&2
      return 2
    fi
    return
  fi
  if [[ -e $BRANDING && ! -f $BRANDING ]]; then
    echo "omastoic: screensaver path is not a regular file — leaving it in place" >&2
    return 1
  fi
  if ! rm -f -- "$BRANDING"; then
    echo "omastoic: could not remove the screensaver file — leaving it in place" >&2
    return 2
  fi
}

restored=0
if [[ -f $STATE/written.sha ]]; then
  kind=""
  [[ -f $STATE/displaced.kind ]] && kind=$(< "$STATE/displaced.kind")
  if [[ $kind == absent && ! -e $BRANDING ]]; then
    restored=1
  elif still_ours; then
    if [[ $kind == absent ]]; then
      if clear_branding; then
        restored=1
      else
        rc=$?
        if [[ $rc -ne 1 ]]; then exit "$rc"; fi
      fi
    elif owns backup "$BACKUP"; then
      if commit_branding "$BACKUP"; then
        restored=1
      else
        rc=$?
        if [[ $rc -ne 1 ]]; then exit "$rc"; fi
      fi
    elif [[ $kind == file ]]; then
      echo "omastoic: displaced branding backup changed or is missing: $BACKUP; restore the backup before retrying off/uninstall" >&2
      exit 1
    elif [[ -f ${OMARCHY_PATH:-/usr/share/omarchy}/logo.txt ]]; then
      if commit_branding "${OMARCHY_PATH:-/usr/share/omarchy}/logo.txt"; then
        restored=1
      else
        rc=$?
        if [[ $rc -ne 1 ]]; then exit "$rc"; fi
      fi
    fi
  else
    echo "omastoic: the screensaver file changed after we wrote it — leaving it in place and keeping the backup" >&2
  fi
fi
if [[ $restored == 1 ]]; then
  remove_owned backup "$BACKUP"
  rm -f "$STATE/written.sha" "$STATE/displaced.kind"
fi
# Disable keeps plumbing for re-enable; remove tears it down entirely.
if installed; then exit 0; fi

if owns prune-path "$PRUNE_PATH"; then run_systemctl --user disable --now omastoic-prune.path; fi
MENU="$CONFIG/omarchy/extensions/omarchy-menu.jsonc"
if [[ -f $MENU ]]; then
  # jq is already a host dependency. Python preserves comments/whitespace and
  # validates the host JSONC grammar before atomically replacing the document.
  python3 - "$MENU" <<'PY'
import json, os, pathlib, re, sys, tempfile
path = pathlib.Path(sys.argv[1])
dest = path.resolve(strict=True) if path.is_symlink() else path
if path.is_symlink() and (not dest.is_file() or dest.is_symlink()):
    raise SystemExit(f"omastoic: refusing to replace symlink {path}")
text = path.read_text()
nxt = re.sub(r"\n  // >>> omastoic:begin v2[^\n]*\n[\s\S]*?  // <<< omastoic:end\n", "", text, count=1)
if nxt == text:
    nxt = re.sub(r"(?:\r?\n)*[ \t]*// >>> omastoic:begin[^\n]*\n[\s\S]*?// <<< omastoic:end[ \t]*(?=\r?\n|$)", "", text, count=1)
if nxt != text:
    stripped = re.sub(r"^\s*//[^\n]*(\n|$)", "", nxt, flags=re.M)
    if stripped.strip(): json.loads(re.sub(r",(\s*[}\]])", r"\1", stripped))
    fd, temp = tempfile.mkstemp(prefix=".omastoic-menu-", dir=dest.parent)
    try:
        with os.fdopen(fd, 'w') as stream: stream.write(nxt)
        if path.read_text() != text: raise RuntimeError('menu changed during cleanup; retry')
        os.replace(temp, dest)
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
rmdir "$HOME/.local/lib/omastoic" 2>/dev/null || true
rm -f "$STATE/installed" "$STATE/launcher.target"
# Drop runtime state. Leave transaction.flock: this script holds it on fd 9.
if [[ -d $STATE ]]; then
  find "$STATE" -mindepth 1 -maxdepth 1 ! -name transaction.flock -exec rm -rf -- {} +
fi
run_systemctl --user daemon-reload
