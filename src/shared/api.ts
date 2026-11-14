import type {
  DirListing,
  FileSyncStatus,
  SmbEntry,
  SmbLogin,
  SmbSaved,
  ForwardState,
  PortForward,
  Host,
  HostInput,
  ImportResult,
  KnownHostEntry,
  LocalRoots,
  PPAgentStatus,
  PPItem,
  PPStatus,
  PPVault,
  PromptRequest,
  PromptResponse,
  SecretBackendInfo,
  SecretKind,
  SessionEvent,
  Snippet,
  SnippetInput,
  Settings,
  SyncResult,
  TransferInfo
} from './types'

export type Unsubscribe = () => void

/** The API the preload script exposes to the renderer as `window.sshbar`. */
export interface SSHbarApi {
  platform: string

  hosts: {
    list(): Promise<Host[]>
    save(host: HostInput): Promise<Host>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<Host>
    importSshConfig(): Promise<ImportResult>
    exportJson(): Promise<boolean>
    importJson(): Promise<ImportResult>
    onChanged(cb: (hosts: Host[]) => void): Unsubscribe
  }

  snippets: {
    list(): Promise<Snippet[]>
    save(s: SnippetInput): Promise<Snippet>
    remove(id: string): Promise<void>
    onChanged(cb: (s: Snippet[]) => void): Unsubscribe
  }

  secrets: {
    backend(): Promise<SecretBackendInfo>
    set(hostId: string, kind: SecretKind, value: string): Promise<void>
    has(hostId: string): Promise<Record<SecretKind, boolean>>
    remove(hostId: string, kind: SecretKind): Promise<void>
  }

  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    onChanged(cb: (s: Settings) => void): Unsubscribe
  }

  knownHosts: {
    list(): Promise<KnownHostEntry[]>
    remove(hostKey: string): Promise<void>
  }

  protonPass: {
    status(): Promise<PPStatus>
    vaults(): Promise<PPVault[]>
    items(shareId: string, type?: 'login' | 'ssh-key'): Promise<PPItem[]>
    agentStatus(): Promise<PPAgentStatus>
    agentStart(vaultShareId?: string): Promise<PPAgentStatus>
    agentStop(): Promise<PPAgentStatus>
    sync(): Promise<SyncResult>
  }

  fileSync: {
    status(): Promise<FileSyncStatus>
    choosePath(mode: 'create' | 'open'): Promise<string | null>
    enable(opts: { path: string; password: string; includeSecrets: boolean; rememberPassword: boolean; create: boolean }): Promise<SyncResult>
    unlock(password: string, remember: boolean): Promise<SyncResult>
    disable(): Promise<void>
    syncNow(): Promise<SyncResult>
    changePassword(newPassword: string): Promise<SyncResult>
    setIncludeSecrets(include: boolean): Promise<SyncResult>
    setSharePassSecrets(share: boolean): Promise<SyncResult>
    /** human-readable name for a sync file path (Android: picker display name for content:// URIs) */
    describePath?(path: string): string
    /** Android: the sync file on an SMB share (NAS), reached without a separate app */
    smb?: {
      saved(): Promise<SmbSaved | null>
      list(login: SmbLogin, dir: string): Promise<SmbEntry[]>
      /** saves the login on this device and returns the sync path for the file */
      choose(login: SmbLogin, filePath: string): Promise<string>
    }
    onStatus(cb: (s: FileSyncStatus) => void): Unsubscribe
  }

  ssh: {
    open(hostId: string, cols: number, rows: number): Promise<string>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    close(sessionId: string): Promise<void>
    listForwards(sessionId: string): Promise<ForwardState[]>
    startForward(sessionId: string, forward: PortForward): Promise<ForwardState>
    stopForward(sessionId: string, forwardId: string): Promise<void>
    onEvent(cb: (ev: SessionEvent) => void): Unsubscribe
  }

  prompts: {
    onRequest(cb: (req: PromptRequest) => void): Unsubscribe
    onCancel(cb: (id: string) => void): Unsubscribe
    respond(id: string, res: PromptResponse): void
  }

  sftp: {
    home(sessionId: string): Promise<string>
    list(sessionId: string, path: string): Promise<DirListing>
    mkdir(sessionId: string, path: string): Promise<void>
    rename(sessionId: string, from: string, to: string): Promise<void>
    remove(sessionId: string, paths: string[]): Promise<void>
    download(sessionId: string, remotePaths: string[], localDir: string): Promise<string[]>
    upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string[]>
    cancelTransfer(transferId: string): Promise<void>
    clearTransfers(sessionId: string): Promise<void>
    onTransfer(cb: (t: TransferInfo) => void): Unsubscribe
  }

  local: {
    roots(): Promise<LocalRoots>
    list(path: string): Promise<DirListing>
    mkdir(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    trash(paths: string[]): Promise<void>
    open(path: string): Promise<void>
    join(dir: string, name: string): Promise<string>
  }

  dialog: {
    pickKeyFile(): Promise<string | null>
  }

  clipboard: {
    read(): Promise<string>
    write(text: string): Promise<void>
  }

  /** Resolve the absolute path of a File dropped from the OS. */
  pathForFile(file: File): string
  openExternal(url: string): Promise<void>
  appInfo(): Promise<{ version: string; electron: string; platform: string }>
}
