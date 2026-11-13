import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Snippet, SnippetInput } from '../../shared/types'
import { readJsonSync, writeJson } from './jsonFile'

interface SnippetsFile {
  version: 1
  snippets: Snippet[]
  deleted: Record<string, number>
}

export function sanitizeSnippet(input: Partial<Snippet>, now = Date.now()): Snippet {
  const command = typeof input.command === 'string' ? input.command.slice(0, 20_000) : ''
  if (!command.trim()) throw new Error('A snippet needs a command')
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : ''
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : randomUUID(),
    name: name || command.trim().split('\n')[0].slice(0, 60),
    command,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now
  }
}

/** Saved commands, with deletion tombstones so removals propagate through sync. */
export class SnippetStore {
  private file: string
  private data: SnippetsFile
  private listeners = new Set<(s: Snippet[]) => void>()

  constructor(dir: string) {
    this.file = join(dir, 'snippets.json')
    const raw = readJsonSync<Partial<SnippetsFile>>(this.file, {})
    const snippets: Snippet[] = []
    for (const s of raw.snippets ?? []) {
      try {
        snippets.push(sanitizeSnippet(s))
      } catch {
        /* drop invalid */
      }
    }
    this.data = { version: 1, snippets, deleted: raw.deleted ?? {} }
  }

  list(): Snippet[] {
    return structuredClone(this.data.snippets)
  }

  tombstones(): Record<string, number> {
    return { ...this.data.deleted }
  }

  onChange(cb: (s: Snippet[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async save(input: SnippetInput): Promise<Snippet> {
    const now = Date.now()
    const existing = input.id ? this.data.snippets.find((s) => s.id === input.id) : undefined
    const snip = sanitizeSnippet({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }, now)
    this.data.snippets = existing ? this.data.snippets.map((s) => (s.id === snip.id ? snip : s)) : [...this.data.snippets, snip]
    delete this.data.deleted[snip.id]
    await this.persist()
    return structuredClone(snip)
  }

  async remove(id: string): Promise<void> {
    this.data.snippets = this.data.snippets.filter((s) => s.id !== id)
    this.data.deleted[id] = Date.now()
    await this.persist()
  }

  async replaceAll(snippets: Snippet[], deleted: Record<string, number>): Promise<void> {
    this.data.snippets = snippets
    this.data.deleted = deleted
    await this.persist()
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, this.data)
    const snap = this.list()
    for (const l of this.listeners) l(snap)
  }
}
