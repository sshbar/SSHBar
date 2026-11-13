import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KnownHostsStore, checkAgainstKnownHostsText, fingerprint, hostKeyName, keyTypeOf, patternsMatch } from '../src/main/store/knownHosts'

function fakeKey(type: string, body: string): Buffer {
  const t = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length)
  return Buffer.concat([len, t, Buffer.from(body)])
}

describe('known hosts', () => {
  const key = fakeKey('ssh-ed25519', 'AAAA-one')
  const other = fakeKey('ssh-ed25519', 'BBBB-two')

  it('names hosts like OpenSSH', () => {
    expect(hostKeyName('example.com', 22)).toBe('example.com')
    expect(hostKeyName('example.com', 2222)).toBe('[example.com]:2222')
    expect(keyTypeOf(key)).toBe('ssh-ed25519')
    expect(fingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
  })

  it('matches plain, wildcard, negated and hashed patterns', () => {
    expect(patternsMatch('a.com,b.com', 'b.com')).toBe(true)
    expect(patternsMatch('*.corp,!bad.corp', 'x.corp')).toBe(true)
    expect(patternsMatch('*.corp,!bad.corp', 'bad.corp')).toBe(false)
    const salt = randomBytes(20)
    const hash = createHmac('sha1', salt).update('[h.example]:2222').digest('base64')
    expect(patternsMatch(`|1|${salt.toString('base64')}|${hash}`, '[h.example]:2222')).toBe(true)
    expect(patternsMatch(`|1|${salt.toString('base64')}|${hash}`, 'h.example')).toBe(false)
  })

  it('detects trusted, changed and unknown keys in known_hosts text', () => {
    const text = `# comment\nsrv.example ssh-ed25519 ${key.toString('base64')}\n@cert-authority *.example ssh-ed25519 AAAA\n`
    expect(checkAgainstKnownHostsText(text, 'srv.example', 'ssh-ed25519', key.toString('base64')).state).toBe('trusted')
    expect(checkAgainstKnownHostsText(text, 'srv.example', 'ssh-ed25519', other.toString('base64')).state).toBe('changed')
    expect(checkAgainstKnownHostsText(text, 'new.example', 'ssh-ed25519', key.toString('base64')).state).toBe('unknown')
    // a different key type for the same host is not a "change"
    expect(checkAgainstKnownHostsText(text, 'srv.example', 'ssh-rsa', 'xyz').state).toBe('unknown')
  })

  it('trust-on-first-use store, combined with the system file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-kh-'))
    const sys = join(dir, 'known_hosts')
    writeFileSync(sys, `[sys.example]:2200 ssh-ed25519 ${key.toString('base64')}\n`)
    const store = new KnownHostsStore(dir, [sys])
    expect(store.check('sys.example', 2200, key).state).toBe('trusted')
    expect(store.check('sys.example', 2200, other).state).toBe('changed')
    expect(store.check('app.example', 22, key).state).toBe('unknown')
    await store.trust('app.example', 22, key)
    expect(store.check('app.example', 22, key).state).toBe('trusted')
    const changed = store.check('app.example', 22, other)
    expect(changed.state).toBe('changed')
    // persisted
    expect(new KnownHostsStore(dir, []).check('app.example', 22, key).state).toBe('trusted')
    await store.remove('app.example')
    expect(store.check('app.example', 22, key).state).toBe('unknown')
  })
})
