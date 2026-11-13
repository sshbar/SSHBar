import { join } from 'node:path'
import type { Settings } from '../../shared/types'
import { readJsonSync, writeJson } from './jsonFile'
import { sanitizeSettings } from '../../shared/settingsModel'

export { sanitizeSettings }

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
    this.data = sanitizeSettings({
      ...this.data,
      ...patch,
      sync: { ...this.data.sync, ...(patch.sync ?? {}) },
      fileSync: { ...this.data.fileSync, ...(patch.fileSync ?? {}) }
    })
    await writeJson(this.file, this.data)
    return this.get()
  }
}
