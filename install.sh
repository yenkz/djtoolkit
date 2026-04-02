#!/bin/bash
# install-djtoolkit.sh — One-line installer for DJ Toolkit on macOS
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yenkz/djtoolkit/main/install.sh | bash

set -euo pipefail

APP_NAME="djtoolkit"
REPO="yenkz/djtoolkit"
INSTALL_DIR="/usr/local/bin"

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
  | grep '"tag_name"' | grep -v 'agent-v' | head -1 | sed 's/.*"v\(.*\)".*/\1/')
[[ -n "$LATEST" ]] || error "Could not determine latest version."
info "Latest version: ${BOLD}v${LATEST}${NC}"

PKG_NAME="${APP_NAME}-${LATEST}-${ARCH}.pkg"
PKG_URL="https://github.com/${REPO}/releases/download/v${LATEST}/${PKG_NAME}"
TMP_PKG="/tmp/${PKG_NAME}"

info "Downloading ${PKG_NAME}..."
curl -fSL --progress-bar -o "$TMP_PKG" "$PKG_URL" \
  || error "Download failed. Check: ${PKG_URL}"

info "Installing (may ask for password)..."
sudo installer -pkg "$TMP_PKG" -target / \
  || error "Installation failed."

rm -f "$TMP_PKG"

info "Installed to ${BOLD}${INSTALL_DIR}/${APP_NAME}${NC}"

echo ""
echo -e "${GREEN}${BOLD}✓ djtoolkit installed!${NC}"
echo -e ""
echo -e "  Get started:"
echo -e "    ${BOLD}djtoolkit setup${NC}          # browser-based setup wizard"
echo -e "    ${BOLD}djtoolkit setup --terminal${NC} # terminal-based setup"
echo -e ""
echo -e "${DIM}  To uninstall: sudo rm /usr/local/bin/djtoolkit && rm -rf ~/.djtoolkit${NC}"
