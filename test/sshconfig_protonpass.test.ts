import { describe, expect, it } from 'vitest'
import { hostsFromSshConfig, parseSshConfig } from '../src/main/sshconfig'
import { extractPassword, extractSshKey } from '../src/main/protonpass'

describe('~/.ssh/config import', () => {
  const cfg = `
Host *
  User defaultuser
  ServerAliveInterval 30

Host web prod-web
  HostName 10.0.0.5
  Port 2200
  IdentityFile ~/.ssh/web_ed25519

Host db
  HostName db.internal
  User postgres
  ProxyJump bastion

Host bastion
  HostName bastion.example.com

Host *.corp
  User corpuser

Match host foo
  User ignored
`
  it('creates one host per concrete alias with first-match-wins semantics', () => {
    const hosts = hostsFromSshConfig(parseSshConfig(cfg, '/nonexistent'), { hasAgent: false, defaultKey: '~/.ssh/id_ed25519' })
    const by = Object.fromEntries(hosts.map((h) => [h.label, h]))
    expect(Object.keys(by)).toEqual(['web', 'prod-web', 'db', 'bastion'])
    expect(by.web).toMatchObject({ hostname: '10.0.0.5', port: 2200, username: 'defaultuser' })
    expect(by.web.auth).toMatchObject({ method: 'key', key: { source: 'file', path: '~/.ssh/web_ed25519' } })
    // Host * comes first, so its User wins (OpenSSH semantics)
    expect(by.db.username).toBe('defaultuser')
    expect(by.db.notes).toContain('ProxyJump bastion')
    expect(by.bastion.auth).toMatchObject({ method: 'key', key: { path: '~/.ssh/id_ed25519' } })
  })

  it('prefers the agent when one is running', () => {
    const hosts = hostsFromSshConfig(parseSshConfig('Host a\n  HostName a.example\n', '/x'), { hasAgent: true })
    expect(hosts[0].auth).toMatchObject({ method: 'agent', agent: 'system' })
  })
})

describe('Proton Pass item extraction', () => {
  it('reads login passwords', () => {
    const view = { item: { content: { title: 't', content: { Login: { username: 'u', password: 'pw1', urls: [] } }, extra_fields: [] } } }
    expect(extractPassword(view)).toBe('pw1')
  })

  it('falls back to a hidden custom field', () => {
    const view = { item: { content: { content: { Custom: {} }, extra_fields: [{ name: 'note', content: { Text: 'x' } }, { name: 'Password', content: { Hidden: 'pw2' } }] } } }
    expect(extractPassword(view)).toBe('pw2')
  })

  it('reads SSH keys and a passphrase field', () => {
    const view = {
      item: {
        content: {
          content: {
            SshKey: {
              private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\n...',
              public_key: 'ssh-ed25519 AAAA',
              sections: [{ section_name: 'Extra', section_fields: [{ name: 'Passphrase', content: { Hidden: 'pp' } }] }]
            }
          },
          extra_fields: []
        }
      }
    }
    const k = extractSshKey(view)
    expect(k.privateKey).toContain('BEGIN OPENSSH')
    expect(k.passphrase).toBe('pp')
  })

  it('rejects non-key items', () => {
    expect(() => extractSshKey({ item: { content: { content: { Login: {} } } } })).toThrow(/not an SSH key/)
  })
})
