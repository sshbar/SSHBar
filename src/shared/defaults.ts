import type { HostAuth, HostInput, Settings } from './types'

export const DEFAULT_AUTH: HostAuth = {
  method: 'password',
  password: { source: 'prompt' },
  key: { source: 'file', path: '' },
  passphrase: { source: 'prompt' },
  agent: 'system',
  agentSocket: ''
}

export function emptyHost(): HostInput {
  return {
    label: '',
    group: '',
    hostname: '',
    port: 22,
    username: '',
    auth: structuredClone(DEFAULT_AUTH),
    jumpHostId: '',
    forwards: [],
    tags: [],
    notes: ''
  }
}

export const DEFAULT_SETTINGS: Settings = {
  protonPassCli: 'pass-cli',
  protonPassAgentSocket: '',
  terminalFontSize: 14,
  terminalFontFamily:
    '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
  terminalScrollback: 10000,
  terminalCursorStyle: 'block',
  statsIntervalSec: 3,
  sync: {
    enabled: false,
    shareId: '',
    vaultName: '',
    itemId: '',
    lastSyncAt: 0,
    lastError: ''
  },
  fileSync: {
    enabled: false,
    path: '',
    includeSecrets: true,
    rememberPassword: true,
    lastSyncAt: 0,
    lastError: ''
  }
}

/** Fill any missing fields of a (possibly older / partially synced) host record. */
export function normalizeAuth(auth: Partial<HostAuth> | undefined): HostAuth {
  const a = { ...structuredClone(DEFAULT_AUTH), ...(auth ?? {}) }
  if (!['password', 'key', 'agent'].includes(a.method)) a.method = 'password'
  if (!['system', 'protonpass', 'custom'].includes(a.agent)) a.agent = 'system'
  if (typeof a.agentSocket !== 'string') a.agentSocket = ''
  return a
}
