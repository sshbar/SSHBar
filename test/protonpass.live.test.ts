/**
 * Read-only checks against the real Proton Pass CLI (never views item contents).
 * Run with SSHBUDDY_PP_LIVE=1 npx vitest run test/protonpass.live.test.ts
 */
import { describe, expect, it } from 'vitest'
import { ProtonPass, defaultAgentSocket, resolveCli } from '../src/main/protonpass'

const d = process.env.SSHBUDDY_PP_LIVE ? describe : describe.skip

d('Proton Pass CLI (live, read-only)', () => {
  const pp = new ProtonPass(() => 'pass-cli')

  it('resolves the CLI and reports a logged-in session', async () => {
    expect(resolveCli('pass-cli')).toMatch(/pass-cli(\.exe)?$/)
    const st = await pp.status()
    expect(st.installed).toBe(true)
    expect(st.loggedIn).toBe(true)
    expect(st.version).toMatch(/Proton Pass CLI/)
  })

  it('lists vaults and items by type', async () => {
    const vaults = await pp.vaults()
    expect(vaults.length).toBeGreaterThan(0)
    expect(vaults.every((v) => v.shareId && typeof v.name === 'string')).toBe(true)
    let keys = 0
    let logins = 0
    for (const v of vaults) {
      const k = await pp.items(v.shareId, 'ssh-key')
      expect(k.every((i) => i.type === 'ssh_key')).toBe(true)
      keys += k.length
      logins += (await pp.items(v.shareId, 'login')).length
    }
    console.log(`vaults=${vaults.length} sshKeys=${keys} logins=${logins}`)
    expect(logins).toBeGreaterThan(0)
  }, 120_000)

  it('reads SSH agent daemon status', async () => {
    const st = await pp.agentStatus(defaultAgentSocket())
    expect(typeof st.running).toBe('boolean')
  })
})
