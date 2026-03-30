#!/bin/bash
# Build djtoolkit macOS .pkg + .dmg installer
# Run from repo root: bash packaging/macos/build.sh
set -euo pipefail

ARCH=$(uname -m)     # arm64 or x86_64
VERSION=${VERSION:-$(python3 -c "import tomllib; print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])")}

echo "Building djtoolkit $VERSION for $ARCH"

# ── 1. Verify fpcalc is available ──────────────────────────────────────────
if [ "$ARCH" = "arm64" ]; then
    FPCALC_PATH="/opt/homebrew/bin/fpcalc"
else
    FPCALC_PATH="/usr/local/bin/fpcalc"
fi

if [ ! -f "$FPCALC_PATH" ]; then
    echo "ERROR: fpcalc not found at $FPCALC_PATH"
    echo "Install with: brew install chromaprint"
    exit 1
fi
echo "✓ fpcalc found at $FPCALC_PATH"

# ── 2. Make installer scripts executable ───────────────────────────────────
chmod +x packaging/macos/scripts/preinstall
chmod +x packaging/macos/scripts/postinstall

# ── 3. PyInstaller — single-file executable ────────────────────────────────
echo "Running PyInstaller..."
uv run pyinstaller packaging/macos/djtoolkit.spec --clean --noconfirm

BINARY="dist/djtoolkit"
if [ ! -f "$BINARY" ]; then
    echo "ERROR: PyInstaller output not found at $BINARY"
    exit 1
fi
echo "✓ Binary built: $BINARY ($(du -sh "$BINARY" | cut -f1))"

# ── 4. Build .pkg ───────────────────────────────────────────────────────────
PKG_NAME="djtoolkit-${VERSION}-${ARCH}.pkg"
echo "Building $PKG_NAME..."

pkgbuild \
    --root dist \
    --identifier com.djtoolkit.agent \
    --version "$VERSION" \
    --install-location /usr/local/bin \
    --scripts packaging/macos/scripts \
    "$PKG_NAME"

echo "✓ Package built: $PKG_NAME"

# ── 5. Wrap in .dmg ─────────────────────────────────────────────────────────
DMG_NAME="djtoolkit-${VERSION}-${ARCH}.dmg"
echo "Creating $DMG_NAME..."

# Stage into a temp folder for hdiutil
TMP_DMG_DIR=$(mktemp -d)
cp "$PKG_NAME" "$TMP_DMG_DIR/"

hdiutil create \
    -volname "djtoolkit $VERSION" \
    -srcfolder "$TMP_DMG_DIR" \
    -ov -format UDZO \
    "$DMG_NAME"

rm -rf "$TMP_DMG_DIR"
echo "✓ Disk image created: $DMG_NAME ($(du -sh "$DMG_NAME" | cut -f1))"

echo ""
echo "Build complete:"
echo "  $PKG_NAME"
echo "  $DMG_NAME"
