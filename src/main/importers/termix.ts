// Converts a Termix host export ("Export hosts" / share JSON) into SSHBuddy hosts.
// Self-contained (type-only imports) so scripts can run it directly with Node's type stripping.
import { randomUUID } from 'node:crypto'
import type { HostAuth, HostInput } from '../../shared/types'

interface TermixCredential {
  alias?: string
  name?: string
  authType?: string
  username?: string
}

interface TermixHost {
  name?: string
  ip?: string
  port?: number | string
  username?: string
  folder?: string | null
  authType?: string
  credentialAlias?: string | null
  connectionType?: string
  tags?: unknown
  notes?: string
}

export interface TermixExport {
  exportedAt?: string
  credentials?: TermixCredential[]
  hosts: TermixHost[]
}

export function isTermixExport(x: unknown): x is TermixExport {
  const o = x as Partial<TermixExport>
  return (
    !!o &&
    typeof o === 'object' &&
    Array.isArray(o.hosts) &&
    o.hosts.length > 0 &&
    o.hosts.every((h) => h && typeof h === 'object' && 'ip' in h && ('authType' in h || 'connectionType' in h))
  )
}

export interface TermixConvertOptions {
  /** Auth for hosts whose key lived in Termix (authType "key" or a key credential). */
  keyAuth?: HostAuth
}

export interface TermixConvertResult {
  hosts: HostInput[]
  skipped: { name: string; reason: string }[]
}

const promptAuth = (): HostAuth => ({
  method: 'password',
  password: { source: 'prompt' },
  key: { source: 'file', path: '' },
  passphrase: { source: 'prompt' },
  agent: 'system',
  agentSocket: ''
})

/**
 * Termix exports never contain passwords or private keys, so:
 *  - password hosts become "ask every time" (tick "save on this device" on first connect)
 *  - key / credential hosts use `keyAuth` when given; otherwise they fall back to a password
 *    prompt with a note naming the Termix credential so the key can be chosen later
 */
export function convertTermix(data: TermixExport, opts: TermixConvertOptions = {}): TermixConvertResult {
  const creds = new Map((data.credentials ?? []).filter((c) => c.alias).map((c) => [c.alias!, c]))
  const hosts: HostInput[] = []
  const skipped: TermixConvertResult['skipped'] = []

  for (const t of data.hosts) {
    const name = (t.name ?? '').trim() || (t.ip ?? '').trim()
    const type = (t.connectionType ?? 'ssh').toLowerCase()
    if (type !== 'ssh') {
      skipped.push({ name, reason: `${type.toUpperCase()} connections are not supported` })
      continue
    }
    const hostname = (t.ip ?? '').trim()
    if (!hostname || /[\s/\\]/.test(hostname)) {
      skipped.push({ name, reason: 'missing or invalid address' })
      continue
    }
    const port = Number(t.port)
    const cred = t.credentialAlias ? creds.get(t.credentialAlias) : undefined
    const authType = (t.authType ?? '').toLowerCase()
    const usesKey = authType === 'key' || (authType === 'credential' && (cred?.authType ?? 'key').toLowerCase() !== 'password')

    const notes: string[] = []
    let auth: HostAuth
    if (usesKey && opts.keyAuth) {
      auth = structuredClone(opts.keyAuth)
    } else {
      auth = promptAuth()
      if (usesKey) notes.push(`Termix used ${cred ? `the key credential "${t.credentialAlias}"` : 'an SSH key'} for this host — choose a key in the host editor.`)
    }
    if (t.notes && typeof t.notes === 'string') notes.unshift(t.notes)

    hosts.push({
      id: randomUUID(),
      label: name,
      group: (t.folder ?? '').trim(),
      hostname,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
      username: (t.username || cred?.username || '').trim(),
      auth,
      jumpHostId: '',
      forwards: [],
      tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
      notes: notes.join('\n')
    })
  }
  return { hosts, skipped }
}
