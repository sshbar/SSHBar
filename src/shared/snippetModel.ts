import type { Snippet } from './types'

export function sanitizeSnippet(input: Partial<Snippet>, now = Date.now()): Snippet {
  const command = typeof input.command === 'string' ? input.command.slice(0, 20_000) : ''
  if (!command.trim()) throw new Error('A snippet needs a command')
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : ''
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : globalThis.crypto.randomUUID(),
    name: name || command.trim().split('\n')[0].slice(0, 60),
    command,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now
  }
}
