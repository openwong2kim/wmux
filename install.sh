#!/bin/bash
# wmux installer for WSL/Git Bash
# Usage: curl -fsSL https://raw.githubusercontent.com/openwong2kim/wmux/main/install.sh | bash

set -e

REPO="openwong2kim/wmux"
INSTALL_DIR="$HOME/.wmux"

echo ""
echo "  wmux installer"
echo "  AI Agent Terminal for Windows"
echo ""

# Check node
if ! command -v node &> /dev/null; then
    echo "  [!] Node.js is required. Install from https://nodejs.org"
    exit 1
fi

NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "  [!] Node.js 18+ required (found $(node -v))"
    exit 1
fi

echo "  [1/4] Cloning repository..."
rm -rf "$INSTALL_DIR"
git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR" 2>/dev/null

echo "  [2/4] Installing dependencies..."
cd "$INSTALL_DIR"
npm install --no-audit --no-fund 2>/dev/null

echo "  [3/4] Building CLI..."
npm run build:cli 2>/dev/null
npm link 2>/dev/null

echo "  [4/4] Done!"
echo ""
echo "  Usage:"
echo "    cd $INSTALL_DIR"
echo "    npm start              # Run wmux"
echo "    wmux --help            # CLI help"
echo ""
