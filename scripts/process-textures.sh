#!/usr/bin/env bash
# Turn raw Nano Banana art in raw-art/ into game textures in public/textures/.
# Needs uv (for numpy + pillow) and ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/textures
mkdir -p "$OUT"
for t in seabed rock rust; do
  uv run --quiet --with numpy --with pillow python scripts/seamless.py "raw-art/$t.jpg" "$OUT/$t.jpg" 1024
done
# Far backdrop: 4096 wide keeps it sharp on large screens.
magick raw-art/backdrop.jpg -resize 4096x -quality 86 "$OUT/backdrop.jpg"
ls -la "$OUT"
