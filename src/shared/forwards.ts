import type { PortForward } from './types'

/** Is this bind address reachable only from the local machine? */
export function isLoopback(address: string): boolean {
  const a = address.trim().toLowerCase()
  return a === '' || a === 'localhost' || a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a)
}

/** Human description, e.g. "localhost:8080 → db.internal:5432". */
export function describeForward(f: PortForward, boundPort?: number): string {
  const bind = `${f.bindAddress || '127.0.0.1'}:${boundPort ?? (f.bindPort || 'auto')}`
  if (f.type === 'dynamic') return `SOCKS5 proxy on ${bind}`
  if (f.type === 'local') return `${bind} → ${f.destHost}:${f.destPort} (from the server)`
  return `server ${bind} → ${f.destHost}:${f.destPort} (on this computer)`
}
