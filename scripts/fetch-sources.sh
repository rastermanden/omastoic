#!/bin/bash
# Download the public-domain / CC0 source images named in assets/portraits.json
# from Wikimedia Commons into assets/sources/. They are not checked in; the
# committed art/*.txt is what omastoic actually ships.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dest="$root/assets/sources"
mkdir -p "$dest"

while IFS= read -r file; do
  out="$dest/$file"
  [[ -s $out ]] && { echo "have $file"; continue; }
  encoded=$(printf %s "$file" | jq -sRr @uri)
  curl -fsSL --max-time 60 -o "$out" \
    "https://commons.wikimedia.org/wiki/Special:FilePath/$encoded?width=960"
  echo "got  $file"
done < <(jq -r '.portraits[].file' "$root/assets/portraits.json")
