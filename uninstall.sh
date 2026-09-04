#!/usr/bin/env bash
set -euo pipefail

plugin_id="io.github.rastermanden.omastoic"
legacy_id="omastoic"
plugins="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
target="$plugins/$plugin_id"
legacy="$plugins/$legacy_id"

if [[ -x $target/bin/omastoic ]]; then
  "$target/bin/omastoic" uninstall
elif [[ -x $legacy/bin/omastoic ]]; then
  "$legacy/bin/omastoic" uninstall
elif command -v omastoic >/dev/null 2>&1; then
  omastoic uninstall
fi

if command -v omarchy >/dev/null 2>&1; then
  omarchy plugin remove "$plugin_id" --yes 2>/dev/null || true
  omarchy plugin remove "$legacy_id" --yes 2>/dev/null || true
fi
rm -rf "$target" "$legacy"
echo "omastoic removed. Your quotes are still in ${XDG_CONFIG_HOME:-$HOME/.config}/omastoic/."
