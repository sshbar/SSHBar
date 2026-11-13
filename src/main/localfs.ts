import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import type { DirListing, FileEntry, LocalRoots } from '../shared/types'
import { permString } from './ssh/sftp'

export async function localRoots(downloads: string): Promise<LocalRoots> {
  const roots: string[] = []
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      try {
        await fs.access(`${letter}:\\`)
        roots.push(`${letter}:\\`)
      } catch {
        /* drive not present */
      }
    }
  } else {
    roots.push('/')
  }
  return { home: homedir(), sep, roots, downloads }
}

export async function localList(path: string): Promise<DirListing> {
  const dir = resolve(path)
  const names = await fs.readdir(dir)
  const entries: FileEntry[] = []
  await Promise.all(
    names.map(async (name) => {
      const full = join(dir, name)
      try {
        const lst = await fs.lstat(full)
        const entry: FileEntry = {
          name,
          path: full,
          kind: lst.isDirectory() ? 'dir' : lst.isFile() ? 'file' : lst.isSymbolicLink() ? 'link' : 'other',
          size: lst.size,
          mtime: lst.mtimeMs,
          mode: lst.mode,
          permissions: permString(lst.mode)
        }
        if (lst.isSymbolicLink()) {
          try {
            const st = await fs.stat(full)
            entry.isDirLink = st.isDirectory()
            entry.size = st.size
          } catch {
            entry.isDirLink = false
          }
        }
        entries.push(entry)
      } catch {
        /* unreadable entry: skip */
      }
    })
  )
  const root = parse(dir).root
  return { path: dir, parent: dir === root ? null : dirname(dir), entries }
}

export async function localMkdir(path: string): Promise<void> {
  await fs.mkdir(path)
}

export async function localRename(from: string, to: string): Promise<void> {
  try {
    await fs.access(to)
    throw new Error(`Already exists: ${to}`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fs.rename(from, to)
}
