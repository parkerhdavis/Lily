#!/bin/bash

# Icon generation script for Lily Tauri app
# Generates all required icon sizes from source PNGs and copies them to
# every location that needs them (Tauri bundle config, frontend public/).
# Requires ImageMagick (convert command) and optionally icnsutils (png2icns)

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PUBLIC_DIR="$PROJECT_ROOT/frontend/public"

# Source files
APP_ICON="lily-icon-fullres.png"            # Main app icon (Tauri bundle + taskbar)
SPLASH_DARK="lily-icon-fullres-trans-inv.png"   # Splash screen icon (dark mode)
SPLASH_LIGHT="lily-icon-fullres-trans.png"      # Splash screen icon (light mode)

cd "$SCRIPT_DIR"

# Check source files exist
for src in "$APP_ICON" "$SPLASH_DARK" "$SPLASH_LIGHT"; do
	if [ ! -f "$src" ]; then
		echo "Error: $src not found in $SCRIPT_DIR"
		exit 1
	fi
done

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
	echo "Error: ImageMagick is not installed. Please install it first:"
	echo "  Ubuntu/Debian: sudo apt install imagemagick"
	echo "  Fedora: sudo dnf install ImageMagick"
	echo "  Arch: sudo pacman -S imagemagick"
	exit 1
fi

# ─── Tauri bundle icons (from app icon) ─────────────────────────────────

echo "Generating Tauri bundle icons from $APP_ICON..."

# 32x32 - Small icon (Windows taskbar, Linux panel)
convert "$APP_ICON" -resize 32x32 PNG32:32x32.png
echo "  Generated 32x32.png"

# 128x128 - Medium icon (Windows start menu, macOS)
convert "$APP_ICON" -resize 128x128 PNG32:128x128.png
echo "  Generated 128x128.png"

# 128x128@2x - Retina icon (256x256 actual pixels)
convert "$APP_ICON" -resize 256x256 PNG32:128x128@2x.png
echo "  Generated 128x128@2x.png (256x256)"

# .ico for Windows (multi-size)
convert "$APP_ICON" \
	\( -clone 0 -resize 16x16 \) \
	\( -clone 0 -resize 32x32 \) \
	\( -clone 0 -resize 48x48 \) \
	\( -clone 0 -resize 64x64 \) \
	\( -clone 0 -resize 128x128 \) \
	\( -clone 0 -resize 256x256 \) \
	-delete 0 icon.ico
echo "  Generated icon.ico (multi-size)"

# .icns for macOS
if command -v png2icns &> /dev/null; then
	ICNS_TMPDIR="$(mktemp -d)"
	convert "$APP_ICON" -resize 16x16   "$ICNS_TMPDIR/icon_16.png"
	convert "$APP_ICON" -resize 32x32   "$ICNS_TMPDIR/icon_32.png"
	convert "$APP_ICON" -resize 128x128 "$ICNS_TMPDIR/icon_128.png"
	convert "$APP_ICON" -resize 256x256 "$ICNS_TMPDIR/icon_256.png"
	convert "$APP_ICON" -resize 512x512 "$ICNS_TMPDIR/icon_512.png"
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

# ─── Frontend public/ assets ───────────────────────────────────────────

echo ""
echo "Copying to frontend/public/..."

mkdir -p "$PUBLIC_DIR"

cp "$SPLASH_DARK" "$PUBLIC_DIR/lily-icon-trans-inv.png"
echo "  Copied $SPLASH_DARK -> lily-icon-trans-inv.png"

cp "$SPLASH_LIGHT" "$PUBLIC_DIR/lily-icon-trans.png"
echo "  Copied $SPLASH_LIGHT -> lily-icon-trans.png"

# ─── Summary ───────────────────────────────────────────────────────────

echo ""
echo "Done! Generated Tauri bundle icons:"
ls -lh 32x32.png 128x128.png 128x128@2x.png icon.ico icon.icns 2>/dev/null
echo ""
echo "Frontend public/ contents:"
ls -lh "$PUBLIC_DIR"/lily-icon-*.png
