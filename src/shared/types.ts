// Types shared between the main process, preload bridge and renderer.

/** Where a secret (password / passphrase) comes from at connect time. */
export type CredentialRef =
  | { source: 'prompt' }
  | { source: 'local' }
  | { source: 'protonpass'; shareId: string; itemId: string; title?: string }

/** Where a private key comes from at connect time. */
export type KeyRef =
  | { source: 'file'; path: string }
  | { source: 'local' }
  | { source: 'protonpass'; shareId: string; itemId: string; title?: string }

export type AuthMethod = 'password' | 'key' | 'agent'
export type AgentKind = 'system' | 'protonpass' | 'custom'

export interface HostAuth {
  method: AuthMethod
  password: CredentialRef
  key: KeyRef
  passphrase: CredentialRef
  agent: AgentKind
  agentSocket: string
}

export interface Host {
  id: string
  label: string
  group: string
  hostname: string
  port: number
  username: string
  auth: HostAuth
  tags: string[]
  notes: string
  createdAt: number
  updatedAt: number
}

export type HostInput = Omit<Host, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

export type SecretKind = 'password' | 'key' | 'passphrase'

export interface Settings {
  protonPassCli: string
  protonPassAgentSocket: string
  terminalFontSize: number
  terminalFontFamily: string
  terminalScrollback: number
  terminalCursorStyle: 'block' | 'bar' | 'underline'
  statsIntervalSec: number
  sync: SyncSettings
}

export interface SyncSettings {
  enabled: boolean
  shareId: string
  vaultName: string
  itemId: string
  lastSyncAt: number
  lastError: string
}

export interface SecretBackendInfo {
  available: boolean
  backend: string
  reason?: string
}

// ---------- Proton Pass ----------

export interface PPStatus {
  installed: boolean
  loggedIn: boolean
  version?: string
  username?: string
  error?: string
}

export interface PPVault {
  shareId: string
  name: string
}

export type PPItemType = 'login' | 'ssh_key' | 'note' | 'custom' | 'alias' | 'credit_card' | 'identity' | 'wifi' | string

export interface PPItem {
  id: string
  shareId: string
  title: string
  type: PPItemType
}

export interface PPAgentStatus {
  running: boolean
  socketPath: string
  detail: string
}

// ---------- Sessions ----------

export type SessionStatus = 'connecting' | 'authenticating' | 'connected' | 'closed' | 'error'

export interface CpuStat {
  percent: number
  cores: number
}

export interface MemStat {
  totalBytes: number
  usedBytes: number
  swapTotalBytes: number
  swapUsedBytes: number
}

export interface NetStat {
  rxBytesPerSec: number
  txBytesPerSec: number
  rxTotalBytes: number
  txTotalBytes: number
  interfaces: string[]
}

export interface DiskStat {
  mount: string
  filesystem: string
  totalBytes: number
  usedBytes: number
}

export interface HostStats {
  at: number
  os?: string
  kernel?: string
  hostname?: string
  cpu?: CpuStat
  mem?: MemStat
  net?: NetStat
  disks: DiskStat[]
  load?: [number, number, number]
  uptimeSec?: number
  supported: boolean
}

export type SessionEvent =
  | { type: 'status'; sessionId: string; status: SessionStatus; message?: string }
  | { type: 'data'; sessionId: string; data: Uint8Array }
  | { type: 'stats'; sessionId: string; stats: HostStats }
  | { type: 'closed'; sessionId: string; reason?: string }

// ---------- Prompts (main -> renderer -> main) ----------

export interface PromptField {
  label: string
  secret: boolean
}

export type PromptRequest =
  | {
      id: string
      kind: 'hostkey'
      sessionId?: string
      host: string
      port: number
      keyType: string
      fingerprint: string
      /** 'unknown' = first connection, 'changed' = key differs from the stored one */
      state: 'unknown' | 'changed'
      knownFingerprints: string[]
    }
  | {
      id: string
      kind: 'credentials'
      sessionId?: string
      title: string
      message: string
      fields: PromptField[]
      /** Offer a "save on this device" checkbox */
      allowRemember: boolean
    }

export interface PromptResponse {
  ok: boolean
  values?: string[]
  /** For hostkey prompts: trust permanently. For credential prompts: save locally. */
  remember?: boolean
}

// ---------- Files ----------

export type FileKind = 'file' | 'dir' | 'link' | 'other'

export interface FileEntry {
  name: string
  path: string
  kind: FileKind
  /** For links: whether the target is a directory */
  isDirLink?: boolean
  size: number
  mtime: number
  mode: number
  permissions: string
}

export interface DirListing {
  path: string
  parent: string | null
  entries: FileEntry[]
}

export interface LocalRoots {
  home: string
  sep: string
  roots: string[]
  downloads: string
}

export type TransferDirection = 'upload' | 'download'
export type TransferState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TransferInfo {
  id: string
  sessionId: string
  direction: TransferDirection
  name: string
  source: string
  destination: string
  state: TransferState
  bytesTotal: number
  bytesDone: number
  filesTotal: number
  filesDone: number
  bytesPerSec: number
  error?: string
  startedAt: number
  finishedAt?: number
}

export interface KnownHostEntry {
  hostKey: string
  keyType: string
  fingerprint: string
  addedAt: number
}

export interface SyncResult {
  ok: boolean
  message: string
  pulled: number
  pushed: number
  at: number
}

export interface ImportResult {
  added: number
  skipped: number
}
