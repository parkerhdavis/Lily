#!/bin/bash

# Icon generation script for Lily Tauri app
# Generates all required icon sizes from source PNGs and copies them to
# every location that needs them (Tauri bundle config, frontend public/).
# Requires ImageMagick (v6 or v7) and optionally icnsutils (png2icns)

set -e  # Exit on error

# ─── Configuration ────────────────────────────────────────────────────
# ICON_SHAPE controls the app icon shape for platform bundles.
# Options: "square", "rounded", "circle"
ICON_SHAPE="rounded"

# Corner radius percentage for "rounded" mode (0-50, where 50 = circle)
ROUNDED_PERCENT=18

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PUBLIC_DIR="$PROJECT_ROOT/frontend/public"

# Source files
APP_ICON="lily-icon-fullres.png"            # Main app icon (square base)
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

# Detect ImageMagick version (v7 uses `magick`, v6 uses `convert`)
if command -v magick &> /dev/null; then
	IM="magick"
elif command -v convert &> /dev/null; then
	IM="convert"
else
	echo "Error: ImageMagick is not installed. Please install it first:"
	echo "  Ubuntu/Debian: sudo apt install imagemagick"
	echo "  Fedora: sudo dnf install ImageMagick"
	echo "  Arch: sudo pacman -S imagemagick"
	exit 1
fi

# ─── Shape masking ────────────────────────────────────────────────────
# apply_shape <input> <size> <output>
# Resizes to <size>x<size> and applies the configured ICON_SHAPE mask.
apply_shape() {
	local input="$1" size="$2" output="$3"

	case "$ICON_SHAPE" in
		square)
			$IM "$input" -resize "${size}x${size}" "PNG32:$output"
			;;
		rounded)
			local radius=$(( size * ROUNDED_PERCENT / 100 ))
			$IM "$input" -resize "${size}x${size}" -alpha set \
				\( -size "${size}x${size}" xc:none \
				   -fill white -draw "roundrectangle 0,0,$((size-1)),$((size-1)),${radius},${radius}" \) \
				-compose DstIn -composite "PNG32:$output"
			;;
		circle)
			local half=$(( size / 2 ))
			$IM "$input" -resize "${size}x${size}" -alpha set \
				\( -size "${size}x${size}" xc:none \
				   -fill white -draw "circle ${half},${half} ${half},0" \) \
				-compose DstIn -composite "PNG32:$output"
			;;
		*)
			echo "Error: Unknown ICON_SHAPE '$ICON_SHAPE' (use square, rounded, or circle)"
			exit 1
			;;
	esac
}

# ─── Tauri bundle icons (from app icon) ─────────────────────────────────

echo "Generating Tauri bundle icons from $APP_ICON (shape: $ICON_SHAPE)..."

apply_shape "$APP_ICON" 32 32x32.png
echo "  Generated 32x32.png"

apply_shape "$APP_ICON" 128 128x128.png
echo "  Generated 128x128.png"

apply_shape "$APP_ICON" 256 "128x128@2x.png"
echo "  Generated 128x128@2x.png (256x256)"

apply_shape "$APP_ICON" 512 512x512.png
echo "  Generated 512x512.png"

# .ico for Windows (multi-size)
ICO_TMPDIR="$(mktemp -d)"
for s in 16 32 48 64 128 256; do
	apply_shape "$APP_ICON" "$s" "$ICO_TMPDIR/icon_${s}.png"
done
$IM "$ICO_TMPDIR"/icon_*.png icon.ico
rm -rf "$ICO_TMPDIR"
echo "  Generated icon.ico (multi-size)"

# .icns for macOS
ICNS_TMPDIR="$(mktemp -d)"
for s in 16 32 128 256 512; do
	apply_shape "$APP_ICON" "$s" "$ICNS_TMPDIR/icon_${s}.png"
done

if command -v iconutil &> /dev/null; then
	# macOS: use built-in iconutil (requires an .iconset directory)
	ICONSET_DIR="$ICNS_TMPDIR/icon.iconset"
	mkdir -p "$ICONSET_DIR"
	cp "$ICNS_TMPDIR/icon_16.png"  "$ICONSET_DIR/icon_16x16.png"
	cp "$ICNS_TMPDIR/icon_32.png"  "$ICONSET_DIR/icon_16x16@2x.png"
	cp "$ICNS_TMPDIR/icon_32.png"  "$ICONSET_DIR/icon_32x32.png"
	# Generate a 64px icon for 32x32@2x
	apply_shape "$APP_ICON" 64 "$ICONSET_DIR/icon_32x32@2x.png"
	cp "$ICNS_TMPDIR/icon_128.png" "$ICONSET_DIR/icon_128x128.png"
	cp "$ICNS_TMPDIR/icon_256.png" "$ICONSET_DIR/icon_128x128@2x.png"
	cp "$ICNS_TMPDIR/icon_256.png" "$ICONSET_DIR/icon_256x256.png"
	cp "$ICNS_TMPDIR/icon_512.png" "$ICONSET_DIR/icon_256x256@2x.png"
	cp "$ICNS_TMPDIR/icon_512.png" "$ICONSET_DIR/icon_512x512.png"
	# Generate a 1024px icon for 512x512@2x
	apply_shape "$APP_ICON" 1024 "$ICONSET_DIR/icon_512x512@2x.png"
	iconutil -c icns -o icon.icns "$ICONSET_DIR"
	echo "  Generated icon.icns (via iconutil)"
elif command -v png2icns &> /dev/null; then
	# Linux: use png2icns from icnsutils
	png2icns icon.icns \
		"$ICNS_TMPDIR/icon_16.png" \
		"$ICNS_TMPDIR/icon_32.png" \
		"$ICNS_TMPDIR/icon_128.png" \
		"$ICNS_TMPDIR/icon_256.png" \
		"$ICNS_TMPDIR/icon_512.png"
	echo "  Generated icon.icns (via png2icns)"
else
	rm -rf "$ICNS_TMPDIR"
	echo "Error: Cannot generate icon.icns — no supported tool found."
	echo "  macOS:  iconutil is built-in (should always be available)"
	echo "  Linux:  sudo apt install icnsutils"
	exit 1
fi
rm -rf "$ICNS_TMPDIR"

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
echo "Done! Generated Tauri bundle icons (shape: $ICON_SHAPE):"
ls -lh 32x32.png 128x128.png 128x128@2x.png 512x512.png icon.ico icon.icns 2>/dev/null
echo ""
echo "Frontend public/ contents:"
ls -lh "$PUBLIC_DIR"/lily-icon-*.png
