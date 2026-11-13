import { describe, expect, it } from 'vitest'
import { convertTermix, isTermixExport } from '../src/main/importers/termix'
import { sanitizeHost } from '../src/main/store/hosts'
import type { HostAuth } from '../src/shared/types'

const sample = {
  exportedAt: '2026-11-13T02:31:21.941Z',
  credentials: [
    { alias: 'Main Auth', name: 'Main Auth', authType: 'key', username: 'admin' },
    { alias: 'Shared PW', name: 'Shared PW', authType: 'password', username: 'svc' }
  ],
  hosts: [
    { name: 'web', ip: '10.0.0.5', port: 22, username: 'deploy', folder: 'Local', authType: 'credential', credentialAlias: 'Main Auth', connectionType: 'ssh', socks5Port: 1080 },
    { name: 'nas', ip: '10.0.0.6', port: 2200, username: '', folder: null, authType: 'credential', credentialAlias: 'Main Auth', connectionType: 'ssh' },
    { name: 'pi', ip: '10.0.0.7', port: 22, username: 'pi', folder: '', authType: 'key', connectionType: 'ssh' },
    { name: 'router', ip: '10.0.0.1', port: 22, username: 'root', folder: 'Remote', authType: 'password', connectionType: 'ssh' },
    { name: 'svc', ip: '10.0.0.8', port: 22, username: '', folder: 'Local', authType: 'credential', credentialAlias: 'Shared PW', connectionType: 'ssh' },
    { name: 'win', ip: '10.0.0.9', port: 3389, username: 'u', authType: 'password', connectionType: 'rdp' }
  ]
}

const pp: HostAuth = {
  method: 'key',
  password: { source: 'prompt' },
  key: { source: 'protonpass', shareId: 'share', itemId: 'item', title: 'My SSH Key' },
  passphrase: { source: 'prompt' },
  agent: 'system',
  agentSocket: ''
}

describe('Termix import', () => {
  it('recognises Termix exports but not SSHBuddy ones', () => {
    expect(isTermixExport(sample)).toBe(true)
    expect(isTermixExport({ app: 'SSHBuddy', version: 1, hosts: [{ id: 'x', hostname: 'a' }] })).toBe(false)
    expect(isTermixExport({ hosts: [] })).toBe(false)
  })

  it('maps folders, ports, users, credentials and auth types', () => {
    const { hosts, skipped } = convertTermix(sample, { keyAuth: pp })
    expect(skipped).toEqual([{ name: 'win', reason: 'RDP connections are not supported' }])
    const by = Object.fromEntries(hosts.map((h) => [h.label, h]))
    expect(by.web).toMatchObject({ hostname: '10.0.0.5', port: 22, username: 'deploy', group: 'Local', auth: { method: 'key', key: { source: 'protonpass', title: 'My SSH Key' } } })
    expect(by.nas).toMatchObject({ port: 2200, username: 'admin', group: '' }) // username from the credential
    expect(by.pi.auth.method).toBe('key') // own key -> same key auth
    expect(by.router).toMatchObject({ group: 'Remote', auth: { method: 'password', password: { source: 'prompt' } } })
    expect(by.svc).toMatchObject({ username: 'svc', auth: { method: 'password' } }) // password credential
    // every converted host passes SSHBuddy's validation
    for (const h of hosts) expect(() => sanitizeHost(h)).not.toThrow()
  })

  it('without a key mapping, key hosts ask for a password and carry a note', () => {
    const { hosts } = convertTermix(sample)
    const web = hosts.find((h) => h.label === 'web')!
    expect(web.auth.method).toBe('password')
    expect(web.notes).toMatch(/Main Auth/)
  })
})
