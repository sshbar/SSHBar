#!/usr/bin/env bash
# Disposable demo servers for the README screenshots (scripts/demo.cjs), in Docker.
#   scripts/demo-servers.sh        start
#   scripts/demo-servers.sh stop   remove everything
#
# bastion  published on 127.0.0.1:$SSHBAR_DEMO_PORT (default 22), user "deploy", TCP forwarding on
# app-1    NOT published; reachable only through the bastion, with a small app checked out to browse
# Only made-up content: nothing from this computer ends up in the screenshots.
set -euo pipefail
NET=sshbar-demo-net
BASTION=sshbar-demo-bastion
APP=sshbar-demo-app
DIR="${SSHBAR_DEMO_KEYDIR:-$(pwd)/test/.data/demo}"
PORT="${SSHBAR_DEMO_PORT:-22}"

if [[ "${1:-}" == "stop" ]]; then
  docker rm -f "$BASTION" "$APP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "stopped"
  exit 0
fi

mkdir -p "$DIR"
[[ -f "$DIR/id_demo" ]] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/id_demo" -C deploy@laptop
docker rm -f "$BASTION" "$APP" >/dev/null 2>&1 || true
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

run() { # name hostname [extra docker args...]
  local name=$1 host=$2
  shift 2
  docker run -d --name "$name" --hostname "$host" --network "$NET" --network-alias "$host" "$@" \
    -e PUID=1000 -e PGID=1000 -e TZ=Europe/Bucharest \
    -e USER_NAME=deploy -e PUBLIC_KEY="$(cat "$DIR/id_demo.pub")" \
    lscr.io/linuxserver/openssh-server:latest >/dev/null
}
run "$BASTION" bastion -p "127.0.0.1:$PORT:2222"
run "$APP" app-1

for c in "$BASTION" "$APP"; do
  for _ in $(seq 1 60); do docker exec "$c" test -f /config/sshd/sshd_config && break; sleep 0.5; done
done
sleep 1

# A friendlier shell than the image's default: coloured prompt, colours for ls, no login banner.
setup_shell='
  cat > /config/.bashrc <<"RC"
PS1="\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ "
alias ls="ls --color=auto"
alias ll="ls -lh --color=auto"
RC
  echo ". ~/.bashrc" > /config/.bash_profile
  : > /etc/motd
  sed -i "s/^AllowTcpForwarding no/AllowTcpForwarding yes/" /config/sshd/sshd_config
  kill -HUP $(pgrep -f "^sshd")
'
docker exec "$BASTION" sh -c "$setup_shell"
docker exec "$APP" sh -c "$setup_shell"

# Something to look at on app-1: a small web shop, its logs and a database backup.
docker exec "$APP" sh -c '
  cd /config && mkdir -p apps/shop/src apps/shop/public/img apps/shop/logs backups
  cd apps/shop
  printf "services:\n  web:\n    image: nginx:1.29\n    ports: [\"8080:80\"]\n  db:\n    image: postgres:17\n" > docker-compose.yml
  printf "# Shop\n\nSmall demo shop served by nginx.\n" > README.md
  for f in app.js cart.js checkout.js api.js; do head -c 4096 /dev/urandom | base64 > src/$f; done
  for f in hero.jpg logo.png banner.webp; do head -c 350000 /dev/urandom > public/img/$f; done
  printf "<!doctype html><title>Shop</title>\n" > public/index.html
  for i in $(seq 1 400); do echo "203.0.113.$((i % 250)) - - [26/Nov/2026:10:$((i % 60)):00 +0200] \"GET /products/$i HTTP/1.1\" 200 $((1000 + i))"; done > logs/access.log
  echo "2026-11-26 10:41:07 [info] checkout service ready on :8080" > logs/app.log
  head -c 48000000 /dev/urandom > /config/backups/db-2026-11-25.sql.gz
  chown -R 1000:1000 /config/apps /config/backups
'
# htop for the main screenshot (needs internet; the demo still runs without it)
docker exec "$APP" apk add --no-cache htop >/dev/null 2>&1 || echo "htop not installed (offline?): the hero shot shows ls instead"
for _ in $(seq 1 40); do (echo >/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.5; done
echo "demo servers up: bastion on 127.0.0.1:$PORT, key $DIR/id_demo"
