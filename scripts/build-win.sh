#!/usr/bin/env bash
# Build the Windows installer + portable exe on Linux (or macOS) without installing Wine:
# runs electron-builder inside its official Docker image that ships Wine.
#   scripts/build-win.sh
# On Windows itself just run: npm run dist:win
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=electronuserland/builder:wine
npx electron-vite build
mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home \
  -e USE_SYSTEM_WINE=true \
  -e ELECTRON_CACHE=/cache/electron \
  -e ELECTRON_BUILDER_CACHE=/cache/electron-builder \
  -v "$PWD":/project \
  -v "$HOME/.cache/electron":/cache/electron \
  -v "$HOME/.cache/electron-builder":/cache/electron-builder \
  -w /project \
  "$IMAGE" \
  bash -c 'mkdir -p "$HOME" && node_modules/.bin/electron-builder --win'
ls -la dist/*.exe
