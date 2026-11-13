# Security policy

SSHbar handles SSH credentials, so security reports are taken seriously.

**Please don't open a public issue for a vulnerability.** Email **contact@nicuorlov.com** with:

- what you found and its impact,
- steps to reproduce (a proof of concept helps),
- the SSHbar version and operating system.

You'll get an acknowledgement within a few days, and a fix or mitigation plan once the issue is confirmed. Fixes ship as a new release on the [Releases page](../../releases).

## Scope highlights

- Credential handling: OS-keychain storage, Proton Pass integration, the encrypted sync file
- Host key verification and jump-host chains
- IPC between the sandboxed renderer and the main process
- Port forwarding (listeners bind to 127.0.0.1 by default)
