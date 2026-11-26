import { create } from 'zustand'
import type { FileSyncStatus, ForwardState, Host, HostInput, HostStats, PromptRequest, SessionStatus, Settings, Snippet, TransferInfo } from '../../shared/types'
import type { UpdateInfo } from '../../shared/updateCheck'
import { api } from './api'
import { disposeTerminal, pushTerminalData } from './terminalBus'
import { errorText } from './format'

export type SessionView = 'terminal' | 'files' | 'ports'

export interface SessionState {
  id: string
  hostId: string
  label: string
  subtitle: string
  status: SessionStatus
  message?: string
  stats?: HostStats
  cpuHistory: number[]
  netHistory: { rx: number; tx: number }[]
  view: SessionView
  filesOpened: boolean
  forwards: ForwardState[]
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

type Page = 'hosts' | 'snippets' | 'settings'

interface State {
  ready: boolean
  hosts: Host[]
  settings: Settings | null
  sessions: Record<string, SessionState>
  tabs: string[]
  active: Page | string
  prompts: PromptRequest[]
  transfers: Record<string, TransferInfo>
  toasts: Toast[]
  editor: HostInput | null
  fileSync: FileSyncStatus | null
  snippets: Snippet[]
  /** session whose snippet palette is open */
  palette: string | null
  /** newer release found by the startup check, until dismissed */
  updateNotice: UpdateInfo | null

  init(): Promise<void>
  openPalette(sessionId: string | null): void
  setActive(id: Page | string): void
  connect(hostId: string): Promise<void>
  reconnect(sessionId: string): Promise<void>
  closeTab(sessionId: string): void
  setView(sessionId: string, view: SessionView): void
  setForwards(sessionId: string, forwards: ForwardState[]): void
  openEditor(host: HostInput | null): void
  updateSettings(patch: Partial<Settings>): Promise<void>
  toast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  resolvePrompt(id: string): void
  /** hide the update notice; `skip` also stops it from coming back for this version */
  dismissUpdate(skip: boolean): void
}

const HISTORY = 60
let toastSeq = 1
let initOnce: Promise<void> | null = null
/** let startup (and a first connection) finish before talking to GitHub */
const UPDATE_CHECK_DELAY_MS = 5000

export const useStore = create<State>((set, get) => ({
  ready: false,
  hosts: [],
  settings: null,
  sessions: {},
  tabs: [],
  active: 'hosts',
  prompts: [],
  transfers: {},
  toasts: [],
  editor: null,
  fileSync: null,
  snippets: [],
  palette: null,
  updateNotice: null,

  openPalette(sessionId) {
    set({ palette: sessionId })
  },

  init() {
    // React StrictMode runs effects twice in development: subscribe exactly once,
    // otherwise every terminal chunk and every prompt would be delivered twice.
    initOnce ??= (async () => {
      const [hosts, settings, fileSync, snippets] = await Promise.all([api.hosts.list(), api.settings.get(), api.fileSync.status(), api.snippets.list()])
      set({ hosts, settings, fileSync, snippets, ready: true })
      subscribe()
      setTimeout(() => void checkForUpdatesAtStartup(), UPDATE_CHECK_DELAY_MS)
    })()
    return initOnce

    async function checkForUpdatesAtStartup(): Promise<void> {
      if (!get().settings?.checkForUpdates) return
      // offline, firewalled or rate-limited: say nothing, the next start tries again
      const info = await api.updates.check().catch(() => null)
      if (info?.available && info.latest !== get().settings?.skippedUpdate) set({ updateNotice: info })
    }

    function subscribe(): void {

    api.hosts.onChanged((hosts) => set({ hosts }))
    api.settings.onChanged((settings) => set({ settings }))
    api.fileSync.onStatus((fileSync) => set({ fileSync }))
    api.snippets.onChanged((snippets) => set({ snippets }))

    api.ssh.onEvent((ev) => {
      if (ev.type === 'data') return pushTerminalData(ev.sessionId, ev.data)
      const s = get().sessions[ev.sessionId]
      if (!s) return
      if (ev.type === 'status') {
        set({ sessions: { ...get().sessions, [s.id]: { ...s, status: ev.status, message: ev.message } } })
      } else if (ev.type === 'stats') {
        const cpuHistory = ev.stats.cpu ? [...s.cpuHistory, ev.stats.cpu.percent].slice(-HISTORY) : s.cpuHistory
        const netHistory = ev.stats.net
          ? [...s.netHistory, { rx: ev.stats.net.rxBytesPerSec, tx: ev.stats.net.txBytesPerSec }].slice(-HISTORY)
          : s.netHistory
        set({ sessions: { ...get().sessions, [s.id]: { ...s, stats: ev.stats, cpuHistory, netHistory } } })
      } else if (ev.type === 'forwards') {
        set({ sessions: { ...get().sessions, [s.id]: { ...s, forwards: ev.forwards } } })
      } else if (ev.type === 'closed') {
        const status = s.status === 'error' ? 'error' : 'closed'
        set({ sessions: { ...get().sessions, [s.id]: { ...s, status, message: ev.reason ?? s.message } } })
      }
    })

    api.prompts.onRequest((req) => {
      if (!get().prompts.some((p) => p.id === req.id)) set({ prompts: [...get().prompts, req] })
    })
    api.prompts.onCancel((id) => set({ prompts: get().prompts.filter((p) => p.id !== id) }))

    api.sftp.onTransfer((t) => set({ transfers: { ...get().transfers, [t.id]: t } }))
    }
  },

  setActive(id) {
    set({ active: id })
  },

  async connect(hostId) {
    const host = get().hosts.find((h) => h.id === hostId)
    if (!host) return
    try {
      const id = await api.ssh.open(hostId, 120, 32)
      const s: SessionState = {
        id,
        hostId,
        label: host.label,
        subtitle: `${host.username ? host.username + '@' : ''}${host.hostname}`,
        status: 'connecting',
        cpuHistory: [],
        netHistory: [],
        view: 'terminal',
        filesOpened: false,
        forwards: []
      }
      set({ sessions: { ...get().sessions, [id]: s }, tabs: [...get().tabs, id], active: id })
    } catch (e) {
      get().toast('error', errorText(e))
    }
  },

  async reconnect(sessionId) {
    const old = get().sessions[sessionId]
    if (!old) return
    const host = get().hosts.find((h) => h.id === old.hostId)
    if (!host) return get().toast('error', 'This host no longer exists')
    try {
      const id = await api.ssh.open(old.hostId, 120, 32)
      const sessions = { ...get().sessions }
      delete sessions[sessionId]
      sessions[id] = {
        ...old,
        id,
        label: host.label,
        status: 'connecting',
        message: undefined,
        stats: undefined,
        cpuHistory: [],
        netHistory: [],
        forwards: [],
        filesOpened: old.view === 'files'
      }
      disposeTerminal(sessionId)
      set({ sessions, tabs: get().tabs.map((t) => (t === sessionId ? id : t)), active: id })
    } catch (e) {
      get().toast('error', errorText(e))
    }
  },

  closeTab(sessionId) {
    void api.ssh.close(sessionId)
    void api.sftp.clearTransfers(sessionId)
    disposeTerminal(sessionId)
    const tabs = get().tabs
    const idx = tabs.indexOf(sessionId)
    const nextTabs = tabs.filter((t) => t !== sessionId)
    const sessions = { ...get().sessions }
    delete sessions[sessionId]
    const transfers = Object.fromEntries(Object.entries(get().transfers).filter(([, t]) => t.sessionId !== sessionId))
    let active = get().active
    if (active === sessionId) active = nextTabs[Math.min(idx, nextTabs.length - 1)] ?? 'hosts'
    set({ tabs: nextTabs, sessions, active, transfers })
  },

  setView(sessionId, view) {
    const s = get().sessions[sessionId]
    if (!s) return
    set({ sessions: { ...get().sessions, [sessionId]: { ...s, view, filesOpened: s.filesOpened || view === 'files' } } })
  },

  setForwards(sessionId, forwards) {
    const s = get().sessions[sessionId]
    if (s) set({ sessions: { ...get().sessions, [sessionId]: { ...s, forwards } } })
  },

  openEditor(host) {
    set({ editor: host })
  },

  async updateSettings(patch) {
    try {
      const settings = await api.settings.update(patch)
      set({ settings })
    } catch (e) {
      get().toast('error', errorText(e))
    }
  },

  toast(kind, text) {
    const id = toastSeq++
    set({ toasts: [...get().toasts, { id, kind, text }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },

  resolvePrompt(id) {
    set({ prompts: get().prompts.filter((p) => p.id !== id) })
  },

  dismissUpdate(skip) {
    const notice = get().updateNotice
    set({ updateNotice: null })
    if (skip && notice) void get().updateSettings({ skippedUpdate: notice.latest })
  }
}))
