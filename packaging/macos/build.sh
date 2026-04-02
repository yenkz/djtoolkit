#!/bin/bash
# Build djtoolkit macOS — onedir mode (avoids macOS 15 Team ID signing issue)
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

# ── 2. PyInstaller — onedir mode ──────────────────────────────────────────
# Onedir avoids the macOS 15 Team ID mismatch that breaks onefile mode.
# The onefile binary extracts to /tmp and the extracted Python.framework
# retains the original Team ID, causing dlopen failures.
export VENV_SITE_PACKAGES=$(uv run python -c "import site; print(site.getsitepackages()[0])")
echo "VENV_SITE_PACKAGES=$VENV_SITE_PACKAGES"

echo "Running PyInstaller (onedir)..."
uv run pyinstaller packaging/macos/djtoolkit-onedir.spec --clean --noconfirm

BINARY="dist/djtoolkit/djtoolkit"
if [ ! -f "$BINARY" ]; then
    echo "ERROR: PyInstaller output not found at $BINARY"
    exit 1
fi

# Re-sign all native libraries with ad-hoc (strip any real Team IDs)
echo "Re-signing native libraries..."
SIGNED=0
while IFS= read -r -d '' f; do
    codesign --force --sign - "$f" 2>/dev/null
    SIGNED=$((SIGNED + 1))
done < <(find "dist/djtoolkit/_internal" -type f \( -name "*.dylib" -o -name "*.so" \) -print0)
codesign --force --sign - "$BINARY"
echo "✓ Re-signed $SIGNED libraries + bootloader"

echo "✓ Binary built: $BINARY ($(du -sh dist/djtoolkit | cut -f1) total)"

# ── 3. Create Homebrew tarball ─────────────────────────────────────────────
# Tar the entire onedir output. The Homebrew formula extracts it and creates
# a wrapper script that points to the binary inside.
TAR_NAME="djtoolkit-${VERSION}-arm64.tar.gz"
tar czf "${TAR_NAME}" -C dist djtoolkit
echo "✓ Tarball: ${TAR_NAME} ($(du -sh "${TAR_NAME}" | cut -f1))"

echo ""
echo "Build complete: ${TAR_NAME}"
