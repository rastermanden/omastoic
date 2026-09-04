#!/bin/bash
# Render a screensaver canvas to a PNG at the terminal's cell aspect ratio —
# the quickest way to judge a new portrait.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$root/bin/omastoic" render-png "${1:?usage: preview.sh <canvas.txt> [out.png]}" "${2:-/tmp/omastoic-preview.png}"
