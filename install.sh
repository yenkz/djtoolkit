#!/bin/bash
# install-djtoolkit.sh — One-line installer for DJ Toolkit on macOS
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yenkz/djtoolkit/main/install.sh | bash

set -euo pipefail

APP_NAME="djtoolkit"
REPO="yenkz/djtoolkit"

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}▸${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || error "This installer is for macOS only."

ARCH=$(uname -m)
case "$ARCH" in
  arm64)  ARCH_LABEL="aarch64" ;;
  x86_64) ARCH_LABEL="x86_64" ;;
  *)      error "Unsupported architecture: $ARCH" ;;
esac

info "Detected macOS ${ARCH_LABEL}"

info "Checking latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
  | grep '"tag_name"' | grep 'agent-v' | head -1 | sed 's/.*"agent-v\(.*\)".*/\1/')
[[ -n "$LATEST" ]] || error "Could not determine latest version."
info "Latest version: ${BOLD}v${LATEST}${NC}"

DMG_NAME="${APP_NAME}_${LATEST}_${ARCH_LABEL}.dmg"
DMG_URL="https://github.com/${REPO}/releases/download/agent-v${LATEST}/${DMG_NAME}"
TMP_DMG="/tmp/${DMG_NAME}"

info "Downloading ${DMG_NAME}..."
curl -fSL --progress-bar -o "$TMP_DMG" "$DMG_URL" \
  || error "Download failed. Check: ${DMG_URL}"

info "Installing..."
MOUNT_POINT=$(hdiutil attach -nobrowse -quiet "$TMP_DMG" \
  | grep '/Volumes/' | tail -1 | sed 's/.*\(\/Volumes\/.*\)/\1/' | xargs)
[[ -d "$MOUNT_POINT" ]] || error "Failed to mount DMG."

APP_SRC=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -print -quit)
[[ -n "$APP_SRC" ]] || error "No .app found in DMG."

APP_DEST="/Applications/${APP_NAME}.app"
[[ -d "$APP_DEST" ]] && rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST" || error "Copy failed."

hdiutil detach -quiet "$MOUNT_POINT" 2>/dev/null || true
rm -f "$TMP_DMG"

xattr -cr "$APP_DEST" 2>/dev/null || true

info "Installed to ${BOLD}/Applications/${APP_NAME}.app${NC}"
info "Launching..."
open "$APP_DEST"

echo ""
echo -e "${GREEN}${BOLD}✓ DJ Toolkit installed!${NC}"
echo -e "  Complete the setup wizard, then find the icon in your menu bar."
echo -e "${DIM}  To uninstall: rm -rf /Applications/${APP_NAME}.app ~/.djtoolkit${NC}"
