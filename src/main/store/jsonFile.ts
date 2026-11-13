import { promises as fs, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Read a JSON file synchronously, returning `fallback` if it is missing or unreadable. */
export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/**
 * Write JSON atomically (write to temp file, then rename) with owner-only permissions.
 * Writes to the same file are serialized so a slow write never overwrites a newer one.
 */
const queues = new Map<string, Promise<void>>()

export function writeJson(file: string, data: unknown): Promise<void> {
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      await fs.rename(tmp, file)
    })
  queues.set(file, next)
  return next
}

/** Write text atomically (temp file + rename), serialized per file like writeJson. */
export function writeText(file: string, text: string): Promise<void> {
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await fs.writeFile(tmp, text, { mode: 0o600 })
      await fs.rename(tmp, file)
    })
  queues.set(file, next)
  return next
}
