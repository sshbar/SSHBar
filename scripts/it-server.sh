#!/usr/bin/env bash
# Starts a disposable OpenSSH server in Docker for the integration and smoke tests.
#   scripts/it-server.sh           -> start (prints the env vars to export)
#   scripts/it-server.sh stop      -> remove the container
set -euo pipefail
NAME=sshbuddy-it
DIR="${SSHBUDDY_IT_KEYDIR:-$(pwd)/test/.data}"
if [[ "${1:-}" == "stop" ]]; then docker rm -f "$NAME" >/dev/null && echo "stopped"; exit 0; fi
mkdir -p "$DIR"
[[ -f "$DIR/id_plain" ]] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/id_plain" -C sshbuddy-it-plain
[[ -f "$DIR/id_enc" ]] || ssh-keygen -q -t ed25519 -N 'correct horse' -f "$DIR/id_enc" -C sshbuddy-it-enc
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 127.0.0.1:2222:2222 \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=s3cret-pw \
  -e PUBLIC_KEY="$(cat "$DIR/id_plain.pub" "$DIR/id_enc.pub")" \
  lscr.io/linuxserver/openssh-server:latest >/dev/null
for _ in $(seq 1 60); do (echo >/dev/tcp/127.0.0.1/2222) 2>/dev/null && break; sleep 0.5; done
sleep 2
echo "export SSHBUDDY_IT_KEYDIR=$DIR SSHBUDDY_IT_PORT=2222"
