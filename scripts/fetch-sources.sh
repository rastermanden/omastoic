#!/bin/bash
# Download the public-domain / CC0 source images named in assets/portraits.json
# from Wikimedia Commons into assets/sources/. They are not checked in; the
# committed art/*.txt is what omastoic actually ships.
#
# Portraits marked "origin": "local" are skipped — those images cannot be
# re-fetched from anywhere, so they live committed in assets/local/ instead.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dest="$root/assets/sources"
mkdir -p "$dest"
missing=0

while IFS=$'\t' read -r origin file; do
  if [[ $origin == local ]]; then
    if [[ -s $root/assets/local/$file ]]; then
      echo "local $file"
    else
      echo "local $file — MISSING from assets/local/" >&2
      missing=1
    fi
    continue
  fi
  out="$dest/$file"
  [[ -s $out ]] && { echo "have $file"; continue; }
  encoded=$(printf %s "$file" | jq -sRr @uri)
  curl -fsSL --max-time 60 -o "$out" \
    "https://commons.wikimedia.org/wiki/Special:FilePath/$encoded?width=960"
  echo "got  $file"
done < <(jq -r '.portraits[] | [(.origin // "commons"), .file] | @tsv' "$root/assets/portraits.json")

exit $missing
