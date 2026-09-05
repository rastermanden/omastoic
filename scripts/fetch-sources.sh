#!/bin/bash
# Download the public-domain / CC0 source images named in assets/portraits.json
# from Wikimedia Commons into assets/sources/. They are not checked in; the
# committed art/*.txt is what omastoic actually ships.
#
# Portraits marked "origin": "local" are skipped — those images cannot be
# re-fetched from anywhere, so they live committed in assets/local/ instead.
#
# With --originals, fetch instead the full-resolution originals behind those
# committed copies. assets/local/ holds each one halved and greyscaled, which
# rebuilds art/ exactly but is no good for re-cropping; the originals are kept
# as a release asset so the repository stays small.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dest="$root/assets/sources"
originals="$root/assets/originals"
archive_url="https://github.com/rastermanden/omastoic/releases/download/portrait-sources/omastoic-portrait-originals.zip"

if [[ ${1:-} == "--originals" ]]; then
  if [[ -d $originals && -n $(ls -A "$originals" 2>/dev/null) ]]; then
    echo "have $originals"
    exit 0
  fi
  mkdir -p "$originals"
  tmp=$(mktemp -t omastoic-originals-XXXXXX.zip)
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --max-time 300 -o "$tmp" "$archive_url"
  unzip -q -o "$tmp" -d "$originals"
  echo "got  $(ls "$originals" | wc -l) files into $originals"
  exit 0
fi

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
