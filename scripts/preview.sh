#!/bin/bash
# Render a screensaver text canvas to a PNG at the terminal's cell aspect ratio,
# so the art can be judged the way it will actually look on screen.
set -euo pipefail
in=${1:?usage: preview.sh <canvas.txt> [out.png] [pointsize]}
out=${2:-/tmp/claude-1000/preview.png}
size=${3:-24}
spacing=$(awk -v s="$size" 'BEGIN { printf "%d", s * 0.187 }')
magick -background '#000000' -fill '#e8e4dc' \
  -font /usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf \
  -pointsize "$size" -interline-spacing "$spacing" \
  "label:@$in" -bordercolor '#000000' -border 24 "$out"
identify -format '%f %wx%h\n' "$out"
