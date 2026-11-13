import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { posix } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { DirListing, FileEntry, FileKind } from '../../shared/types'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export function kindOf(mode: number): FileKind {
  const t = mode & S_IFMT
  if (t === S_IFDIR) return 'dir'
  if (t === S_IFREG) return 'file'
  if (t === S_IFLNK) return 'link'
  return 'other'
}

export function permString(mode: number): string {
  const t = mode & S_IFMT
  const type = t === S_IFDIR ? 'd' : t === S_IFLNK ? 'l' : t === S_IFREG ? '-' : '?'
  const rwx = (bits: number): string => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`
  return type + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
}

function p<T>(fn: (cb: (err: Error | null | undefined, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))
}

function sftpError(e: unknown, path: string): Error {
  const err = e as { code?: number; message?: string }
  const codes: Record<number, string> = { 2: 'No such file or directory', 3: 'Permission denied', 4: 'Operation failed' }
  const msg = (err.code !== undefined && codes[err.code]) || err.message || 'SFTP error'
  return new Error(`${msg}: ${path}`)
}

export async function remoteRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return p<string>((cb) => sftp.realpath(path, cb))
}

export async function remoteStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return p<Stats>((cb) => sftp.stat(path, cb))
}

export async function remoteList(sftp: SFTPWrapper, dir: string): Promise<DirListing> {
  let list: { filename: string; attrs: Stats }[]
  try {
    list = await p((cb) => sftp.readdir(dir, cb))
  } catch (e) {
    throw sftpError(e, dir)
  }
  const entries: FileEntry[] = list
    .filter((f) => f.filename !== '.' && f.filename !== '..')
    .map((f) => ({
      name: f.filename,
      path: posix.join(dir, f.filename),
      kind: kindOf(f.attrs.mode),
      size: f.attrs.size,
      mtime: f.attrs.mtime * 1000,
      mode: f.attrs.mode,
      permissions: permString(f.attrs.mode)
    }))
  // Resolve whether symlinks point at directories (bounded parallelism).
  const links = entries.filter((e) => e.kind === 'link')
  for (let i = 0; i < links.length; i += 16) {
    await Promise.all(
      links.slice(i, i + 16).map(async (l) => {
        try {
          l.isDirLink = kindOf((await remoteStat(sftp, l.path)).mode) === 'dir'
        } catch {
          l.isDirLink = false
        }
      })
    )
  }
  return { path: dir, parent: dir === '/' ? null : posix.dirname(dir), entries }
}

export async function remoteMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  try {
    await p<void>((cb) => sftp.mkdir(path, (err) => cb(err, undefined)))
  } catch (e) {
    throw sftpError(e, path)
  }
}

export async function remoteRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  try {
    await p<void>((cb) => sftp.rename(from, to, (err) => cb(err, undefined)))
  } catch (e) {
    throw sftpError(e, from)
  }
}

/** Delete files and directories (recursively). Symlinks are removed, never followed. */
export async function remoteRemove(sftp: SFTPWrapper, path: string): Promise<void> {
  if (path === '/' || path === '') throw new Error('Refusing to delete /')
  let st: Stats
  try {
    st = await p<Stats>((cb) => sftp.lstat(path, cb))
  } catch (e) {
    throw sftpError(e, path)
  }
  if (kindOf(st.mode) === 'dir') {
    const list = await p<{ filename: string }[]>((cb) => sftp.readdir(path, cb))
    for (const f of list) {
      if (f.filename === '.' || f.filename === '..') continue
      await remoteRemove(sftp, posix.join(path, f.filename))
    }
    await p<void>((cb) => sftp.rmdir(path, (err) => cb(err, undefined))).catch((e) => {
      throw sftpError(e, path)
    })
  } else {
    await p<void>((cb) => sftp.unlink(path, (err) => cb(err, undefined))).catch((e) => {
      throw sftpError(e, path)
    })
  }
}

// ---------- transfer planning ----------

export interface PlannedFile {
  src: string
  dst: string
  size: number
  mode?: number
}

export interface TransferPlan {
  dirs: string[]
  files: PlannedFile[]
  bytes: number
}

/** Walk a remote path and plan a download into localDir. */
export async function planDownload(sftp: SFTPWrapper, remotePath: string, localDir: string): Promise<TransferPlan> {
  const plan: TransferPlan = { dirs: [], files: [], bytes: 0 }
  const walk = async (src: string, dst: string): Promise<void> => {
    const st = await remoteStat(sftp, src).catch((e) => {
      throw sftpError(e, src)
    })
    if (kindOf(st.mode) === 'dir') {
      plan.dirs.push(dst)
      const list = await p<{ filename: string }[]>((cb) => sftp.readdir(src, cb))
      for (const f of list) {
        if (f.filename === '.' || f.filename === '..') continue
        await walk(posix.join(src, f.filename), join(dst, safeLocalName(f.filename)))
      }
    } else if (kindOf(st.mode) === 'file') {
      plan.files.push({ src, dst, size: st.size, mode: st.mode & 0o777 })
      plan.bytes += st.size
    }
  }
  await walk(remotePath, join(localDir, safeLocalName(posix.basename(remotePath))))
  return plan
}

/** Walk a local path and plan an upload into remoteDir. */
export async function planUpload(localPath: string, remoteDir: string): Promise<TransferPlan> {
  const plan: TransferPlan = { dirs: [], files: [], bytes: 0 }
  const walk = async (src: string, dst: string): Promise<void> => {
    const st = await fs.stat(src)
    if (st.isDirectory()) {
      plan.dirs.push(dst)
      for (const name of await fs.readdir(src)) await walk(join(src, name), posix.join(dst, name))
    } else if (st.isFile()) {
      plan.files.push({ src, dst, size: st.size, mode: st.mode & 0o777 })
      plan.bytes += st.size
    }
  }
  await walk(localPath, posix.join(remoteDir, basename(localPath)))
  return plan
}

/** Remote names can contain characters that are illegal on Windows. */
export function safeLocalName(name: string): string {
  let n = name.replace(/[\u0000-\u001f]/g, '_')
  if (process.platform === 'win32') n = n.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '_')
  if (n === '' || n === '.' || n === '..') n = '_'
  return n
}

export function fastGet(sftp: SFTPWrapper, src: string, dst: string, onStep: (done: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(src, dst, { concurrency: 64, chunkSize: 32768, step: (done) => onStep(done) }, (err) =>
      err ? reject(sftpError(err, src)) : resolve()
    )
  })
}

export function fastPut(sftp: SFTPWrapper, src: string, dst: string, mode: number | undefined, onStep: (done: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(src, dst, { concurrency: 64, chunkSize: 32768, mode, step: (done) => onStep(done) }, (err) =>
      err ? reject(sftpError(err, dst)) : resolve()
    )
  })
}

export async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  try {
    const st = await remoteStat(sftp, dir)
    if (kindOf(st.mode) === 'dir') return
    throw new Error(`Not a directory: ${dir}`)
  } catch (e) {
    if ((e as Error).message.startsWith('Not a directory')) throw e
    await remoteMkdir(sftp, dir)
  }
}
