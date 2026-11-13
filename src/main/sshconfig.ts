import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostInput, PortForward } from '../shared/types'
import { emptyHost } from '../shared/defaults'

interface Block {
  patterns: string[]
  options: [string, string][]
}

function globRe(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}

function matches(patterns: string[], alias: string): boolean {
  let ok = false
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globRe(p.slice(1)).test(alias)) return false
    } else if (globRe(p).test(alias)) ok = true
  }
  return ok
}

function unquote(v: string): string {
  return v.replace(/^"(.*)"$/, '$1')
}

/** Parse OpenSSH client config text into blocks (Include is resolved; Match blocks are skipped). */
export function parseSshConfig(text: string, baseDir = join(homedir(), '.ssh'), depth = 0): Block[] {
  const blocks: Block[] = [{ patterns: ['*'], options: [] }]
  let cur: Block | null = blocks[0]
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      cur = { patterns: value.split(/\s+/).map(unquote), options: [] }
      blocks.push(cur)
    } else if (key === 'match') {
      cur = null
    } else if (key === 'include' && depth < 5) {
      for (const inc of value.split(/\s+/)) {
        const path = isAbsolute(inc) ? inc : inc.startsWith('~') ? join(homedir(), inc.slice(1)) : join(baseDir, inc)
        const files = basename(path).includes('*')
          ? (() => {
              try {
                const re = globRe(basename(path))
                return readdirSync(dirname(path))
                  .filter((f) => re.test(f))
                  .map((f) => join(dirname(path), f))
              } catch {
                return []
              }
            })()
          : [path]
        for (const f of files) {
          try {
            blocks.push(...parseSshConfig(readFileSync(f, 'utf8'), baseDir, depth + 1).slice(1))
          } catch {
            /* missing include */
          }
        }
      }
    } else if (cur) {
      cur.options.push([key, unquote(value)])
    }
  }
  return blocks
}

/** Turn parsed config into host records for every concrete (non-wildcard) Host alias. */
export type ImportedHost = HostInput & { jumpAlias?: string }

/** Split "[bind_address:]port" (also "[::1]:port" and "*:port"). */
function splitBind(v: string): { address: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(v)
  if (m) return { address: (m[1] ?? m[2]) === '*' ? '0.0.0.0' : (m[1] ?? m[2]), port: Number(m[3]) }
  return { address: '127.0.0.1', port: Number(v) }
}

/** Parse LocalForward / RemoteForward / DynamicForward values into port forwards. */
export function parseForward(kind: 'localforward' | 'remoteforward' | 'dynamicforward', value: string): PortForward | null {
  const [bindSpec, destSpec] = value.trim().split(/\s+/)
  if (!bindSpec) return null
  const bind = splitBind(bindSpec)
  if (!Number.isInteger(bind.port) || bind.port < 0 || bind.port > 65535) return null
  const base = { id: randomUUID(), label: '', bindAddress: bind.address, bindPort: bind.port, autoStart: true }
  if (kind === 'dynamicforward') return { ...base, type: 'dynamic', destHost: '', destPort: 0 }
  if (!destSpec) return null
  const dest = splitBind(destSpec)
  if (!dest.port || dest.address === '127.0.0.1' && !destSpec.includes(':')) return null
  return { ...base, type: kind === 'localforward' ? 'local' : 'remote', destHost: dest.address, destPort: dest.port }
}

/** `ProxyJump [user@]alias[:port]` → alias, when it is a single hop (chains can't be mapped to one host). */
export function proxyJumpAlias(value: string | undefined): string | undefined {
  if (!value || value.includes(',') || value.toLowerCase() === 'none') return undefined
  return value.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
}

export function hostsFromSshConfig(blocks: Block[], env: { hasAgent: boolean; defaultKey?: string }): ImportedHost[] {
  const aliases: string[] = []
  for (const b of blocks) {
    for (const p of b.patterns) {
      if (!/[*?!]/.test(p) && !aliases.includes(p)) aliases.push(p)
    }
  }
  const out: ImportedHost[] = []
  for (const alias of aliases) {
    const opts = new Map<string, string>()
    const forwards: PortForward[] = []
    for (const b of blocks) {
      if (!matches(b.patterns, alias)) continue
      for (const [k, v] of b.options) {
        // forwards accumulate (every matching line applies); everything else is first-match-wins
        if (k === 'localforward' || k === 'remoteforward' || k === 'dynamicforward') {
          const f = parseForward(k, v)
          if (f) forwards.push(f)
        } else if (!opts.has(k)) opts.set(k, v)
      }
    }
    const h = emptyHost()
    h.forwards = forwards
    h.label = alias
    h.hostname = opts.get('hostname')?.replace(/%h/g, alias) ?? alias
    h.port = Number(opts.get('port')) || 22
    h.username = opts.get('user') ?? ''
    h.group = 'Imported'
    // Mirror what `ssh` would do: explicit IdentityFile, else the agent, else a default key, else password.
    const identity = opts.get('identityfile')
    const agentSock = opts.get('identityagent')
    if (identity) {
      h.auth.method = 'key'
      h.auth.key = { source: 'file', path: identity }
    } else if (agentSock && agentSock.toLowerCase() !== 'none') {
      h.auth.method = 'agent'
      h.auth.agent = agentSock === 'SSH_AUTH_SOCK' ? 'system' : 'custom'
      h.auth.agentSocket = agentSock === 'SSH_AUTH_SOCK' ? '' : agentSock
    } else if (env.hasAgent) {
      h.auth.method = 'agent'
      h.auth.agent = 'system'
    } else if (env.defaultKey) {
      h.auth.method = 'key'
      h.auth.key = { source: 'file', path: env.defaultKey }
    }
    const notes: string[] = []
    const jumpAlias = proxyJumpAlias(opts.get('proxyjump'))
    if (opts.has('proxyjump') && !jumpAlias) notes.push(`ProxyJump ${opts.get('proxyjump')} (multi-hop chains must be set up host by host)`)
    if (opts.has('proxycommand')) notes.push(`ProxyCommand ${opts.get('proxycommand')} (not supported)`)
    h.notes = notes.join('\n')
    out.push({ ...h, jumpAlias })
  }
  return out
}
