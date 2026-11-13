# SSHBuddy

A cross-platform SSH client in the spirit of Termius, built with Electron, React, xterm.js and ssh2, and integrated with the Proton Pass CLI.

## Features

| | |
|---|---|
| **Cross-platform** | Windows, macOS and Linux (Electron). Installers via electron-builder: NSIS, DMG, AppImage/deb. |
| **Central host list** | Hosts with groups, tags, notes and search. Import from `~/.ssh/config` or JSON. Optional **sync across devices through Proton Pass** (end-to-end encrypted). |
| **Jump hosts** | Reach private servers through a bastion (ProxyJump). Chains like A → B → C work, every hop's host key is verified, and loops are detected. `ProxyJump` entries in `~/.ssh/config` are mapped when importing. |
| **Authentication** | Password, SSH key (file, pasted, or from Proton Pass), SSH agent (system, Proton Pass agent, custom socket), plus keyboard-interactive / 2FA prompts. Encrypted keys are supported. If a key is rejected it falls back to asking for a password, like OpenSSH. |
| **Proton Pass** | Passwords come from Login items and keys from SSH Key items, fetched on demand via `pass-cli` and kept in memory only. The `pass-cli ssh-agent` daemon can be started from the app. Host sync uses a Proton Pass note. |
| **Terminal** | xterm.js with 256 colours and truecolor, clickable links, copy/paste, multiple tabs and reconnect. |
| **File manager** | Dual-pane local ↔ remote SFTP browser. Drag & drop between panes or from the OS, upload/download of files *and folders*, rename, new folder, delete, and a transfer queue with progress, speed and cancel. |
| **Live stats (bottom panel)** | CPU % with sparkline, RAM (and swap), network ↓/↑ throughput, disk usage per mount, load average and uptime. Read from `/proc` over the existing connection, so nothing is installed on the server. |
| **Security** | Trust-on-first-use host key verification with a loud warning when a key changes. `~/.ssh/known_hosts` is honoured (read-only). Secrets saved on a device are encrypted with the OS keychain. Sandboxed renderer with a strict CSP. |

## Quick start

```bash
npm install
npm run dev          # run with hot reload
npm run build && npm start   # run the production build
```

Requires Node 20+ (tested with Node 24). With npm 11 the Electron binary downloads on first run.

## Proton Pass integration

Install the [Proton Pass CLI](https://proton.me/pass) and log in once in a terminal:

```bash
pass-cli login
```

Then in **Settings → Proton Pass**, press *Check*. GUI apps on macOS don't inherit your shell `PATH`, so SSHBuddy also looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If `pass-cli` lives somewhere else, set the full path there.

| What | How it's used |
|---|---|
| Password from Proton Pass | In the host editor choose *Password → Proton Pass* and pick a Login item. At connect time SSHBuddy runs `pass-cli item view --output json` and uses the item's password. |
| SSH key from Proton Pass | Choose *SSH key → Proton Pass* and pick an SSH Key item. If the key is encrypted, a custom field named `passphrase` on the item is used automatically. Otherwise you're asked once, and can save the passphrase on the device. |
| Proton Pass SSH agent | Choose *SSH agent → Proton Pass agent*. SSHBuddy runs `pass-cli ssh-agent daemon start --socket-path …` if the agent isn't running. |
| Host sync | **Settings → Sync hosts through Proton Pass** → pick a vault. SSHBuddy creates a note named **"SSHBuddy Sync"** and stores the host list in its `sshbuddy_hosts` field (gzip+base64 when large). Each device merges per host, newest change wins, and deletions propagate. |

Secrets fetched from Proton Pass are never written to disk. The sync payload contains host details and **references** (Proton Pass item IDs, key file paths, "saved on this device" markers), never passwords or keys.

## Where data lives

All files are in the app data directory (`~/.config/SSHBuddy` on Linux, `%APPDATA%\SSHBuddy` on Windows, `~/Library/Application Support/SSHBuddy` on macOS). They're written atomically with mode `0600`.

| File | Contents |
|---|---|
| `hosts.json` | Host list plus deletion tombstones (for sync). No secrets. |
| `secrets.json` | Passwords, keys and passphrases you chose to *save on this device*, encrypted with Electron `safeStorage`: macOS Keychain, Windows DPAPI, or libsecret/KWallet on Linux. If Linux has no keyring, saving is disabled instead of falling back to plain text. |
| `known_hosts.json` | Host keys you trusted in SSHBuddy. |
| `settings.json` | Preferences. |

Set `SSHBUDDY_DATA_DIR` to use a different directory, for example for a portable install or tests.

## Packaging

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS installer (build on Windows)
npm run dist:mac     # DMG (build on macOS; sign/notarize for distribution)
npm run dist:dir     # unpacked app for the current OS, quickest check
```

## Tests

```bash
npm test             # unit tests: stats parser, known_hosts, sync merge, ssh_config import, Proton Pass parsing
npm run test:it      # starts OpenSSH servers in Docker (scripts/it-server.sh) and runs SSH/SFTP/jump-host integration tests
npm run test:smoke   # headless Electron run: connect, type in the terminal, open files/settings, save screenshots
                     # set ELECTRON_RENDERER_URL=<vite dev server url> to run it against React dev mode (StrictMode)
SSHBUDDY_PP_LIVE=1 npx vitest run test/protonpass.live.test.ts   # read-only checks against your real pass-cli
```

The integration suite covers jump hosts (to a server that is only reachable through the bastion), password, retry and cancel, plain and encrypted keys, keys from Proton Pass, key-to-password fallback, host-key change detection, connection-refused errors, live stats, and SFTP folder upload/download round-trips with byte-level comparison and cancellation. Host sync runs against a fake `pass-cli` (`test/fixtures/fake-pass-cli.mjs`) that simulates two devices.

## Architecture

```
src/
  shared/            types + the preload API contract (SSHBuddyApi)
  main/              Electron main process (all network, file and secret access)
    index.ts         window, IPC handlers (sender-checked), prompt broker, sync scheduling
    ssh/session.ts   one SSH connection: auth state machine, host-key check, shell, stats channel, SFTP channels
    ssh/stats.ts     remote stats script + /proc parser (CPU/RAM/net deltas, df)
    ssh/sftp.ts      SFTP helpers and transfer planning
    transfers.ts     transfer queue (3 parallel jobs, each on its own SFTP channel so cancel = close channel)
    protonpass.ts    pass-cli wrapper (execFile, never a shell)
    sync.ts          Proton Pass host sync (merge, tombstones, compression)
    sshconfig.ts     ~/.ssh/config import (Include, wildcards, first-match-wins)
    store/           hosts, encrypted secrets, settings, known hosts
  preload/index.ts   contextBridge → window.sshbuddy
  renderer/src/      React UI (zustand store, xterm terminal, file panes, stats bar, dialogs)
```

The renderer runs sandboxed with `contextIsolation` and has no Node access. Saved secrets never travel to it. Terminal output goes over IPC straight into xterm, bypassing React state.

## Known limitations / next steps

- Port forwarding isn't implemented yet. `ProxyCommand` isn't supported; imported hosts that use it get a note.
- Live CPU/RAM/network stats need a Linux server. macOS/BSD hosts show disk usage only.
- Only tested on Linux so far. Windows and macOS builds are configured but unverified.
- Proton Pass sync was tested against a simulated CLI. Its write commands (`item create note`, `item update --field`) come from `pass-cli --help` but haven't been run against a real vault yet.
- No snippets, split panes or mobile apps yet.
