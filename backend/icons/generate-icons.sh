#!/bin/bash

# Icon generation script for Lily Tauri app
# Takes lily_icon_fullres.png and generates all required icon sizes
# Requires ImageMagick (convert command) and optionally icnsutils (png2icns)

set -e  # Exit on error

SOURCE="lily_icon_fullres.png"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# Check if source file exists
if [ ! -f "$SOURCE" ]; then
    echo "Error: $SOURCE not found in $SCRIPT_DIR"
    exit 1
fi

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo "Error: ImageMagick is not installed. Please install it first:"
    echo "  Ubuntu/Debian: sudo apt install imagemagick"
    echo "  Fedora: sudo dnf install ImageMagick"
    echo "  Arch: sudo pacman -S imagemagick"
    exit 1
fi

echo "Generating icons from $SOURCE..."

# Generate standard icon sizes for Tauri
# 32x32 - Small icon (Windows taskbar, Linux panel)
convert "$SOURCE" -resize 32x32 PNG32:32x32.png
echo "  Generated 32x32.png"

# 128x128 - Medium icon (Windows start menu, macOS)
convert "$SOURCE" -resize 128x128 PNG32:128x128.png
echo "  Generated 128x128.png"

# 128x128@2x - Retina icon (256x256 actual pixels)
convert "$SOURCE" -resize 256x256 PNG32:128x128@2x.png
echo "  Generated 128x128@2x.png (256x256)"

# Generate .ico for Windows (multi-size)
convert "$SOURCE" \
    \( -clone 0 -resize 16x16 \) \
    \( -clone 0 -resize 32x32 \) \
    \( -clone 0 -resize 48x48 \) \
    \( -clone 0 -resize 64x64 \) \
    \( -clone 0 -resize 128x128 \) \
    \( -clone 0 -resize 256x256 \) \
    -delete 0 icon.ico
echo "  Generated icon.ico (multi-size)"

# Generate .icns for macOS
if command -v png2icns &> /dev/null; then
    # png2icns needs specific sizes: 16, 32, 128, 256, 512, 1024
    ICNS_TMPDIR="$(mktemp -d)"
    convert "$SOURCE" -resize 16x16   "$ICNS_TMPDIR/icon_16.png"
    convert "$SOURCE" -resize 32x32   "$ICNS_TMPDIR/icon_32.png"
    convert "$SOURCE" -resize 128x128 "$ICNS_TMPDIR/icon_128.png"
    convert "$SOURCE" -resize 256x256 "$ICNS_TMPDIR/icon_256.png"
    convert "$SOURCE" -resize 512x512 "$ICNS_TMPDIR/icon_512.png"
    png2icns icon.icns \
        "$ICNS_TMPDIR/icon_16.png" \
        "$ICNS_TMPDIR/icon_32.png" \
        "$ICNS_TMPDIR/icon_128.png" \
        "$ICNS_TMPDIR/icon_256.png" \
        "$ICNS_TMPDIR/icon_512.png"
    rm -rf "$ICNS_TMPDIR"
    echo "  Generated icon.icns"
else
    echo "  Skipped icon.icns (install icnsutils: sudo apt install icnsutils)"
fi

echo ""
echo "Icon generation complete! Generated icons:"
ls -lh *.png *.ico *.icns 2>/dev/null | grep -v "$SOURCE"
