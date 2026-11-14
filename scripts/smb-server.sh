#!/usr/bin/env bash
# Disposable Samba server in Docker for testing the Android app's NAS (SMB) sync file support.
#   scripts/smb-server.sh              start on 127.0.0.1:4450 (SMB 2.1 – 3.1.1)
#   scripts/smb-server.sh smb2         start with SMB 2.1 only (no encryption)
#   scripts/smb-server.sh stop         remove it
#
# Login tester / sshbar-test. Shares:
#   NAS     read-write, contains Nicolae/SSHSyncFile/ (like a typical NAS layout)
#   Secure  read-write, encryption required
#   Public  read-only, guest access
# Reach it from the phone with: adb reverse tcp:4450 tcp:4450  (then address 127.0.0.1:4450)
set -euo pipefail
NAME=sshbar-smb
PORT="${SSHBAR_SMB_PORT:-4450}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
[[ "${1:-}" == "stop" ]] && { echo "stopped"; exit 0; }

MAXPROTO=SMB3_11
[[ "${1:-}" == "smb2" ]] && MAXPROTO=SMB2_10

IMAGE=sshbar-smb-test:1
docker image inspect "$IMAGE" >/dev/null 2>&1 || printf 'FROM alpine:3.20\nRUN apk add --no-cache samba\n' | docker build -q -t "$IMAGE" - >/dev/null

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:445" -e MAXPROTO="$MAXPROTO" "$IMAGE" sh -c '
set -e
adduser -D -H tester
printf "sshbar-test\nsshbar-test\n" | smbpasswd -a -s tester >/dev/null
mkdir -p /srv/nas/Nicolae/SSHSyncFile /srv/secure /srv/public
echo "hello" > /srv/public/readme.txt
chown -R tester /srv/nas /srv/secure
cat > /etc/samba/smb.conf <<EOF
[global]
  server role = standalone server
  server min protocol = SMB2_10
  server max protocol = $MAXPROTO
  disable netbios = yes
  smb ports = 445
  map to guest = bad user
  load printers = no
  log level = 1
[NAS]
  path = /srv/nas
  read only = no
  valid users = tester
[Secure]
  path = /srv/secure
  read only = no
  valid users = tester
  smb encrypt = required
[Public]
  path = /srv/public
  read only = yes
  guest ok = yes
EOF
exec smbd --foreground --no-process-group --debug-stdout
' >/dev/null

for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q 'daemon_ready\|smbd version'; then
    sleep 1
    echo "SMB test server on 127.0.0.1:$PORT (max protocol $MAXPROTO), login tester / sshbar-test"
    exit 0
  fi
  sleep 1
done
docker logs "$NAME" | tail -20
exit 1
