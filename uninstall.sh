#!/usr/bin/env bash
set -euo pipefail
plugins="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
for id in io.github.rastermanden.omastoic omastoic; do
  if [[ -x $plugins/$id/bin/omastoic ]]; then
    exec "$plugins/$id/bin/omastoic" uninstall "$@"
  fi
done
# Also works from a checkout after a partial setup. Never rm -rf an expected
# plugin path or hide a host removal failure behind a success message.
root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$root/bin/omastoic" uninstall "$@"
