import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProtonPass } from '../src/main/protonpass'
import { HostStore } from '../src/main/store/hosts'
import { SettingsStore } from '../src/main/store/settings'
import { SnippetStore } from '../src/main/store/snippets'
import { SYNC_FIELD, SYNC_NOTE_TITLE, syncHosts } from '../src/main/sync'
import { emptyHost } from '../src/shared/defaults'

const FAKE = resolve(__dirname, 'fixtures/fake-pass-cli.mjs')
const d = process.platform === 'win32' ? describe.skip : describe

d('two devices syncing through (fake) Proton Pass', () => {
  it('creates the sync note, converges both ways and propagates deletes', async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), 'sb-pp-')), 'state.json')
    process.env.FAKE_PASS_STATE = stateFile
    const pp = new ProtonPass(() => FAKE)
    const device = async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sb-dev-'))
      const settings = new SettingsStore(dir)
      await settings.update({ sync: { ...settings.get().sync, enabled: true, shareId: 'vault-A' } })
      return { hosts: new HostStore(dir), settings, snippets: new SnippetStore(dir) }
    }
    const a = await device()
    const b = await device()

    const web = await a.hosts.save({ ...emptyHost(), label: 'web', hostname: 'web.example', auth: { ...emptyHost().auth, password: { source: 'protonpass', shareId: 'vault-A', itemId: 'login-1' } } })
    const r1 = await syncHosts(pp, a.hosts, a.settings, a.snippets)
    expect(r1).toMatchObject({ ok: true, pushed: 1 })
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ title: SYNC_NOTE_TITLE, item_type: 'note' })
    expect(state.items[0].extra_fields[0].name).toBe(SYNC_FIELD)
    // no secrets in the payload, only the reference
    expect(state.items[0].extra_fields[0].content.Text).toContain('login-1')

    const r2 = await syncHosts(pp, b.hosts, b.settings, b.snippets)
    expect(r2).toMatchObject({ ok: true, pulled: 1 })
    expect(b.hosts.list().map((h) => h.label)).toEqual(['web'])
    expect(b.settings.get().sync.itemId).toBe(a.settings.get().sync.itemId)

    // snippets travel the same way
    await a.snippets.save({ name: 'uptime', command: 'uptime' })
    await syncHosts(pp, a.hosts, a.settings, a.snippets)
    await syncHosts(pp, b.hosts, b.settings, b.snippets)
    expect(b.snippets.list().map((x) => x.command)).toEqual(['uptime'])

    // B adds a host and deletes web; A syncs and sees both changes
    await b.hosts.save({ ...emptyHost(), label: 'db', hostname: 'db.example' })
    await b.hosts.remove(web.id)
    await syncHosts(pp, b.hosts, b.settings, b.snippets)
    await syncHosts(pp, a.hosts, a.settings, a.snippets)
    expect(a.hosts.list().map((h) => h.label)).toEqual(['db'])

    // idempotent: syncing again without changes doesn't write
    const writesBefore = JSON.parse(readFileSync(stateFile, 'utf8')).log.filter((l: string) => l.startsWith('item update')).length
    await syncHosts(pp, a.hosts, a.settings, a.snippets)
    const writesAfter = JSON.parse(readFileSync(stateFile, 'utf8')).log.filter((l: string) => l.startsWith('item update')).length
    expect(writesAfter).toBe(writesBefore)
  })

  it('reports CLI errors without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-dev-'))
    const settings = new SettingsStore(dir)
    await settings.update({ sync: { ...settings.get().sync, shareId: 'v' } })
    const res = await syncHosts(new ProtonPass(() => '/nonexistent/pass-cli'), new HostStore(dir), settings)
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/not found/)
    expect(settings.get().sync.lastError).toMatch(/not found/)
  })
})
