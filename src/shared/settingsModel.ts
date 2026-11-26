import type { Settings } from './types'
import { DEFAULT_SETTINGS } from './defaults'

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS
  const sync = { ...d.sync, ...(raw.sync ?? {}) }
  const fs = { ...d.fileSync, ...(raw.fileSync ?? {}) }
  return {
    protonPassCli: typeof raw.protonPassCli === 'string' && raw.protonPassCli.trim() ? raw.protonPassCli.trim() : d.protonPassCli,
    protonPassAgentSocket: typeof raw.protonPassAgentSocket === 'string' ? raw.protonPassAgentSocket.trim() : d.protonPassAgentSocket,
    terminalFontSize: clampInt(raw.terminalFontSize, 8, 32, d.terminalFontSize),
    terminalFontFamily:
      typeof raw.terminalFontFamily === 'string' && raw.terminalFontFamily.trim() ? raw.terminalFontFamily : d.terminalFontFamily,
    terminalScrollback: clampInt(raw.terminalScrollback, 500, 200_000, d.terminalScrollback),
    terminalCursorStyle: ['block', 'bar', 'underline'].includes(raw.terminalCursorStyle as string)
      ? (raw.terminalCursorStyle as Settings['terminalCursorStyle'])
      : d.terminalCursorStyle,
    statsIntervalSec: clampInt(raw.statsIntervalSec, 1, 60, d.statsIntervalSec),
    snippetSuggestions: raw.snippetSuggestions !== false,
    checkForUpdates: raw.checkForUpdates !== false,
    skippedUpdate: typeof raw.skippedUpdate === 'string' ? raw.skippedUpdate.slice(0, 64) : '',
    sync: {
      enabled: Boolean(sync.enabled),
      shareId: String(sync.shareId ?? ''),
      vaultName: String(sync.vaultName ?? ''),
      itemId: String(sync.itemId ?? ''),
      lastSyncAt: Number(sync.lastSyncAt) || 0,
      lastError: String(sync.lastError ?? '')
    },
    fileSync: {
      enabled: Boolean(fs.enabled),
      path: typeof fs.path === 'string' ? fs.path : '',
      includeSecrets: fs.includeSecrets !== false,
      sharePassSecrets: fs.sharePassSecrets === true,
      pathLabel: typeof fs.pathLabel === 'string' ? fs.pathLabel.slice(0, 300) : '',
      rememberPassword: fs.rememberPassword !== false,
      lastSyncAt: Number(fs.lastSyncAt) || 0,
      lastError: String(fs.lastError ?? '')
    }
  }
}
