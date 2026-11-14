// The sync file on a NAS (SMB share): the share password lives in Keystore-backed storage, the file is
// reached through the native module (smbj). The sync path itself (smb://user@host/share/…) has no secret.
import type { SmbEntry, SmbLogin, SmbSaved } from '../shared/types'
import { cleanSmbDir, formatSmbPath, parentSmb, parseSmbPath, smbSecretKey, type SmbLocation } from '../shared/smbPath'
import { Native, type SmbTarget } from './native'

const SAVED_FILE = 'smb-login.json'

type Where = Pick<SmbLocation, 'host' | 'port' | 'share' | 'username'>

const target = (l: Where, password: string): SmbTarget => ({ host: l.host, port: l.port, share: l.share, username: l.username, password })

async function savedPassword(l: Where): Promise<string | null> {
  return (await Native.secureGet({ key: smbSecretKey(l) })).value
}

export async function smbSaved(): Promise<SmbSaved | null> {
  const raw = (await Native.readText({ name: SAVED_FILE })).data
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Omit<SmbSaved, 'hasPassword'>
    return { ...s, hasPassword: !!(await savedPassword(s)) }
  } catch {
    return null
  }
}

/** An empty password in the login means "the one saved on this phone". */
export async function smbList(login: SmbLogin, dir: string): Promise<SmbEntry[]> {
  const password = login.password || (await savedPassword(login)) || ''
  const { entries } = await Native.smbList({ ...target(login, password), path: cleanSmbDir(dir) })
  return entries
}

export async function smbChoose(login: SmbLogin, filePath: string): Promise<string> {
  const path = cleanSmbDir(filePath)
  if (!path) throw new Error('Choose a file')
  if (login.password) await Native.secureSet({ key: smbSecretKey(login), value: login.password })
  const saved = { host: login.host, port: login.port, share: login.share, username: login.username, dir: parentSmb(path) }
  await Native.writeText({ name: SAVED_FILE, data: JSON.stringify(saved) })
  return formatSmbPath({ ...login, path })
}

async function targetFor(syncPath: string): Promise<SmbTarget & { path: string }> {
  const l = parseSmbPath(syncPath)
  const password = await savedPassword(l)
  if (password == null && l.username) {
    throw new Error('The NAS password is no longer saved on this phone. Turn sync off, then choose the file on the NAS again.')
  }
  return { ...target(l, password ?? ''), path: l.path }
}

/** The file's text, or null when it does not exist yet. */
export async function smbReadFile(syncPath: string): Promise<string | null> {
  return (await Native.smbRead(await targetFor(syncPath))).data ?? null
}

export async function smbWriteFile(syncPath: string, data: string): Promise<void> {
  await Native.smbWrite({ ...(await targetFor(syncPath)), data })
}
