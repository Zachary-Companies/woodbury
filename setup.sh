#!/usr/bin/env bash
set -e

echo "Setting up woodbury..."
echo

echo "[1/3] Installing dependencies..."
npm install

echo
echo "[2/3] Building..."
npm run build

echo
echo "[3/3] Linking globally..."
npm link

echo
echo "Setup complete! You can now run 'woodbury' from any directory."
echo
echo "Quick start:"
echo "  woodbury                          Interactive REPL mode"
echo "  woodbury \"describe this project\"  One-shot mode"
echo "  woodbury --help                   Show all options"
