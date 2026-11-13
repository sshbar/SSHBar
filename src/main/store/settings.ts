import { join } from 'node:path'
import type { Settings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { readJsonSync, writeJson } from './jsonFile'

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS
  const sync = { ...d.sync, ...(raw.sync ?? {}) }
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
    sync: {
      enabled: Boolean(sync.enabled),
      shareId: String(sync.shareId ?? ''),
      vaultName: String(sync.vaultName ?? ''),
      itemId: String(sync.itemId ?? ''),
      lastSyncAt: Number(sync.lastSyncAt) || 0,
      lastError: String(sync.lastError ?? '')
    }
  }
}

export class SettingsStore {
  private file: string
  private data: Settings

  constructor(dir: string) {
    this.file = join(dir, 'settings.json')
    this.data = sanitizeSettings(readJsonSync<Partial<Settings>>(this.file, {}))
  }

  get(): Settings {
    return structuredClone(this.data)
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.data = sanitizeSettings({ ...this.data, ...patch, sync: { ...this.data.sync, ...(patch.sync ?? {}) } })
    await writeJson(this.file, this.data)
    return this.get()
  }
}
