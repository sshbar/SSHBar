export function bytes(n: number | undefined, digits = 1): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`
}

export function rate(n: number | undefined): string {
  return n === undefined ? '—' : `${bytes(n)}/s`
}

export function pct(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0
}

export function duration(sec: number | undefined): string {
  if (sec === undefined) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function dateTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

export function errorText(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  // strip Electron's "Error invoking remote method 'x': Error: " prefix
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
