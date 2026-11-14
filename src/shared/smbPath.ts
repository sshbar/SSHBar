// Sync file locations on an SMB share (NAS / Windows shared folder), used by the Android app, which
// reaches the share itself. Stored as smb://user@host[:port]/share/dir/file — never with the password.

export interface SmbLocation {
  host: string
  port: number
  share: string
  /** "user", "DOMAIN\\user" or "user@domain"; empty for guest access */
  username: string
  /** path inside the share, "/"-separated, no leading slash */
  path: string
}

export const SMB_PORT = 445

export const isSmbPath = (p: string): boolean => /^smb:\/\//i.test(p)

/** "a\\b//c/" → "a/b/c" */
export function cleanSmbDir(p: string): string {
  return p
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.')
    .join('/')
}

export function joinSmb(dir: string, name: string): string {
  return cleanSmbDir(`${dir}/${name}`)
}

export function parentSmb(dir: string): string {
  return cleanSmbDir(dir).split('/').slice(0, -1).join('/')
}

const hostPart = (host: string, port: number): string => (port && port !== SMB_PORT ? `${host}:${port}` : host)

export function formatSmbPath(l: SmbLocation): string {
  const user = l.username ? `${encodeURIComponent(l.username)}@` : ''
  const path = cleanSmbDir(l.path).split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `smb://${user}${hostPart(l.host, l.port)}/${encodeURIComponent(l.share)}/${path}`
}

export function parseSmbPath(p: string): SmbLocation {
  const m = /^smb:\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^/:@]+)(?::(\d+))?\/([^/]+)\/?(.*)$/i.exec(p)
  if (!m) throw new Error(`Not a NAS location: ${p}`)
  return {
    username: decodeURIComponent(m[1] ?? ''),
    host: m[2],
    port: m[3] ? Number(m[3]) : SMB_PORT,
    share: decodeURIComponent(m[4]),
    path: m[5].split('/').filter(Boolean).map(decodeURIComponent).join('/')
  }
}

/** How Windows and most NAS apps show it: \\host\share\dir\file */
export function smbLabel(l: Pick<SmbLocation, 'host' | 'port' | 'share' | 'path'>): string {
  const rest = cleanSmbDir(l.path)
  return `\\\\${hostPart(l.host, l.port)}\\${l.share}${rest ? '\\' + rest.replace(/\//g, '\\') : ''}`
}

/**
 * What people paste or type as the NAS address: "192.168.0.10", "nas.local:4450",
 * "\\\\nas\\share\\folder", "smb://nas/share/folder" or "nas/share". Share and folder are optional.
 */
export function parseServerInput(input: string): { host: string; port: number; share?: string; dir?: string } {
  const s = input.trim().replace(/^smb:\/\//i, '').replace(/^[\\/]+/, '')
  const [authority = '', share, ...rest] = s.split(/[\\/]+/)
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1) // drop "user@"
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostPort)
  const out: { host: string; port: number; share?: string; dir?: string } = { host: m ? m[1] : hostPort, port: m?.[2] ? Number(m[2]) : SMB_PORT }
  if (share) out.share = share
  const dir = cleanSmbDir(rest.join('/'))
  if (dir) out.dir = dir
  return out
}

/** Keystore entry that holds the share password on the phone. */
export const smbSecretKey = (l: Pick<SmbLocation, 'host' | 'port' | 'share' | 'username'>): string =>
  `__smb__:${l.username.toLowerCase()}@${l.host.toLowerCase()}:${l.port}/${l.share.toLowerCase()}`
