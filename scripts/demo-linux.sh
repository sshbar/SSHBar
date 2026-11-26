#!/usr/bin/env bash
# README screenshots from the Linux app, made in Docker (works the same from Linux, macOS or Windows).
#   scripts/demo-servers.sh     the demo SSH servers
#   scripts/demo-linux.sh       builds the runner image once (~600 MB of downloads), then runs scripts/demo.cjs
#
# The repository is mounted read-only and copied into the container: your own node_modules and files
# stay as they are. "This computer" in the shots is /home/alex inside the container. The container
# reaches the bastion published on this computer through host.docker.internal.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd -W 2>/dev/null || pwd) # Docker on Windows wants D:/... paths
IMAGE=sshbar-demo-runner
KEYDIR="${SSHBAR_DEMO_KEYDIR:-$ROOT/test/.data/demo}"
OUT="${DEMO_OUT:-$ROOT/docs/media}"
PORT="${SSHBAR_DEMO_PORT:-22}"
export MSYS_NO_PATHCONV=1 # Git Bash: leave the container paths alone

[[ -f "$KEYDIR/id_demo" ]] || { echo "no demo key in $KEYDIR: run scripts/demo-servers.sh first" >&2; exit 1; }

# a small build context: only what npm ci needs (not the whole repository and its node_modules)
CTX="$ROOT/test/.data/demo/image"
rm -rf "$CTX" && mkdir -p "$CTX"
cp package.json package-lock.json "$CTX/"
docker build -q -t "$IMAGE" -f scripts/demo.Dockerfile "$CTX" >/dev/null

mkdir -p "$OUT"
docker run --rm \
  -v "$ROOT:/src:ro" -v "$OUT:/out" -v "$KEYDIR:/keys:ro" \
  --add-host host.docker.internal:host-gateway \
  -e DEMO_OUT=/out -e DEMO_KEY=/keys/id_demo -e DEMO_HOME=/home/alex \
  -e DEMO_BASTION_ADDR=host.docker.internal -e SSHBAR_DEMO_PORT="$PORT" \
  "$IMAGE" sh -c '
    cp -r /src/src /src/scripts /src/build /src/electron.vite.config.ts /src/tsconfig.json /src/tsconfig.node.json /src/tsconfig.web.json /app/ &&
    npx electron-vite build >/dev/null &&
    xvfb-run -a -s "-screen 0 1600x1000x24" npx electron --no-sandbox scripts/demo.cjs 2>&1 | grep -v -e dbus -e "Fontconfig"'
