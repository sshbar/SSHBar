#!/usr/bin/env bash
# Disposable OpenSSH servers in Docker for the integration and smoke tests.
#   scripts/it-server.sh        start (prints the env vars to export)
#   scripts/it-server.sh stop   remove everything
#
# sshbar-it         published on 127.0.0.1:$SSHBAR_IT_PORT (default 2222), TCP forwarding enabled
#                   (bastion / port-forward tests). Windows may reserve 2222 (Hyper-V): pick another port.
# sshbar-it-target  NOT published; reachable only as "sb-target:2222" from inside the bastion's network
set -euo pipefail
NET=sshbar-it-net
BASTION=sshbar-it
TARGET=sshbar-it-target
DIR="${SSHBAR_IT_KEYDIR:-$(pwd)/test/.data}"
PORT="${SSHBAR_IT_PORT:-2222}"

if [[ "${1:-}" == "stop" ]]; then
  docker rm -f "$BASTION" "$TARGET" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "stopped"
  exit 0
fi

mkdir -p "$DIR"
[[ -f "$DIR/id_plain" ]] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/id_plain" -C sshbar-it-plain
[[ -f "$DIR/id_enc" ]] || ssh-keygen -q -t ed25519 -N 'correct horse' -f "$DIR/id_enc" -C sshbar-it-enc
docker rm -f "$BASTION" "$TARGET" >/dev/null 2>&1 || true
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

run() { # name hostname [extra docker args...]
  local name=$1 host=$2
  shift 2
  docker run -d --name "$name" --hostname "$host" --network "$NET" --network-alias "$host" "$@" \
    -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
    -e PASSWORD_ACCESS=true -e USER_NAME=tester -e USER_PASSWORD=s3cret-pw \
    -e PUBLIC_KEY="$(cat "$DIR/id_plain.pub" "$DIR/id_enc.pub")" \
    lscr.io/linuxserver/openssh-server:latest >/dev/null
}
run "$BASTION" sb-bastion -p "127.0.0.1:$PORT:2222"
run "$TARGET" sb-target

for _ in $(seq 1 60); do (echo >/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.5; done
for _ in $(seq 1 60); do docker exec "$BASTION" test -f /config/sshd/sshd_config && break; sleep 0.5; done
sleep 1
# allow -L / -R / -D and jump-host forwarding on the bastion, then make sshd reload its config
# (the pattern is anchored so it can't match this sh -c command line itself)
docker exec "$BASTION" sh -c 'sed -i "s/^AllowTcpForwarding no/AllowTcpForwarding yes/" /config/sshd/sshd_config && kill -HUP $(pgrep -f "^sshd")'
sleep 1
for _ in $(seq 1 40); do (echo >/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.5; done
echo "export SSHBAR_IT_KEYDIR=$DIR SSHBAR_IT_PORT=$PORT"
