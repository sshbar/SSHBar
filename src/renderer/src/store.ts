import { create } from 'zustand'
import type { FileSyncStatus, Host, HostInput, HostStats, PromptRequest, SessionStatus, Settings, TransferInfo } from '../../shared/types'
import { api } from './api'
import { disposeTerminal, pushTerminalData } from './terminalBus'
import { errorText } from './format'

export type SessionView = 'terminal' | 'files'

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
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

type Page = 'hosts' | 'settings'

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

  init(): Promise<void>
  setActive(id: Page | string): void
  connect(hostId: string): Promise<void>
  reconnect(sessionId: string): Promise<void>
  closeTab(sessionId: string): void
  setView(sessionId: string, view: SessionView): void
  openEditor(host: HostInput | null): void
  updateSettings(patch: Partial<Settings>): Promise<void>
  toast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  resolvePrompt(id: string): void
}

const HISTORY = 60
let toastSeq = 1
let initOnce: Promise<void> | null = null

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

  init() {
    // React StrictMode runs effects twice in development: subscribe exactly once,
    // otherwise every terminal chunk and every prompt would be delivered twice.
    initOnce ??= (async () => {
      const [hosts, settings, fileSync] = await Promise.all([api.hosts.list(), api.settings.get(), api.fileSync.status()])
      set({ hosts, settings, fileSync, ready: true })
      subscribe()
    })()
    return initOnce

    function subscribe(): void {

    api.hosts.onChanged((hosts) => set({ hosts }))
    api.settings.onChanged((settings) => set({ settings }))
    api.fileSync.onStatus((fileSync) => set({ fileSync }))

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
        filesOpened: false
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
  }
}))
