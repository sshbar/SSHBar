import type { DiskStat, HostStats } from '../../shared/types'

/**
 * Remote resource monitoring. One long-lived exec channel runs a small POSIX sh loop that
 * prints /proc snapshots separated by markers; we diff consecutive samples for CPU % and
 * network throughput. No agent is installed on the server.
 */

export function statsCommand(intervalSec: number): string {
  const n = Math.max(1, Math.min(60, Math.round(intervalSec)))
  // Must not contain single quotes: it is wrapped in sh -c '...' so it works from bash, zsh and fish.
  const script = [
    'echo @@info',
    'uname -srm 2>/dev/null',
    'hostname 2>/dev/null || uname -n',
    'grep PRETTY_NAME /etc/os-release 2>/dev/null',
    'd=1',
    'while :; do',
    '  if [ -r /proc/stat ]; then',
    '    echo @@stat; grep "^cpu" /proc/stat',
    '    echo @@mem; cat /proc/meminfo',
    '    echo @@net; cat /proc/net/dev',
    '    echo @@load; cat /proc/loadavg',
    '    echo @@uptime; cat /proc/uptime',
    '  fi',
    '  echo @@disk; df -Pk 2>/dev/null',
    '  echo @@end',
    // first interval is short so CPU % and network rates appear quickly
    '  sleep $d || exit 0',
    `  d=${n}`,
    'done'
  ].join('\n')
  return `exec sh -c '${script}'`
}

export interface RawSample {
  info?: { kernel?: string; hostname?: string; os?: string }
  cpuTotal?: number
  cpuIdle?: number
  cores?: number
  mem?: Record<string, number>
  net?: Record<string, { rx: number; tx: number }>
  load?: [number, number, number]
  uptimeSec?: number
  disks: DiskStat[]
  hasProc: boolean
}

/** Split a chunk of loop output into sections keyed by marker name. */
function sections(block: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur = ''
  for (const line of block.split('\n')) {
    const m = /^@@(\w+)\s*$/.exec(line)
    if (m) {
      cur = m[1]
      out.set(cur, [])
    } else if (cur) {
      out.get(cur)!.push(line)
    }
  }
  return out
}

const IGNORED_IFACE = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan|kube|tun|tap|wg)/
const REAL_FS = /^(\/dev\/|[A-Za-z]:|\/\/|[\w.-]+:\/)/

export function parseSample(block: string): RawSample {
  const sec = sections(block)
  const sample: RawSample = { disks: [], hasProc: sec.has('stat') }

  const info = sec.get('info')
  if (info) {
    const pretty = info.find((l) => l.startsWith('PRETTY_NAME='))
    sample.info = {
      kernel: info[0]?.trim() || undefined,
      hostname: info[1]?.trim() || undefined,
      os: pretty ? pretty.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '') : info[0]?.split(' ')[0]
    }
  }

  const stat = sec.get('stat')
  if (stat) {
    const agg = stat.find((l) => /^cpu\s/.test(l))
    if (agg) {
      const nums = agg.trim().split(/\s+/).slice(1).map(Number)
      // user nice system idle iowait irq softirq steal (guest is already counted in user)
      const total = nums.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
      sample.cpuTotal = total
      sample.cpuIdle = (nums[3] ?? 0) + (nums[4] ?? 0)
    }
    sample.cores = stat.filter((l) => /^cpu\d+\s/.test(l)).length || undefined
  }

  const mem = sec.get('mem')
  if (mem) {
    sample.mem = {}
    for (const l of mem) {
      const m = /^(\w+):\s+(\d+)/.exec(l)
      if (m) sample.mem[m[1]] = Number(m[2]) * 1024
    }
  }

  const net = sec.get('net')
  if (net) {
    sample.net = {}
    for (const l of net) {
      const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l)
      if (!m) continue
      const f = m[2].trim().split(/\s+/).map(Number)
      if (f.length >= 9) sample.net[m[1]] = { rx: f[0], tx: f[8] }
    }
  }

  const load = sec.get('load')?.[0]
  if (load) {
    const p = load.trim().split(/\s+/).slice(0, 3).map(Number)
    if (p.length === 3 && p.every(Number.isFinite)) sample.load = p as [number, number, number]
  }

  const up = sec.get('uptime')?.[0]
  if (up) {
    const u = Number(up.trim().split(/\s+/)[0])
    if (Number.isFinite(u)) sample.uptimeSec = u
  }

  const disk = sec.get('disk')
  if (disk) {
    const seen = new Set<string>()
    for (const l of disk.slice(1)) {
      const p = l.trim().split(/\s+/)
      if (p.length < 6) continue
      const [fs, total, used] = p
      const mount = p.slice(5).join(' ')
      if (!REAL_FS.test(fs) && mount !== '/') continue
      if (/^\/(snap|var\/lib\/docker|run|boot\/efi)\b/.test(mount)) continue
      if (seen.has(fs)) continue
      seen.add(fs)
      const t = Number(total) * 1024
      if (!(t > 0)) continue
      sample.disks.push({ filesystem: fs, mount, totalBytes: t, usedBytes: Number(used) * 1024 })
    }
    sample.disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.totalBytes - a.totalBytes))
  }

  return sample
}

/** Combine the previous and current raw samples into a display-ready stats object. */
export function computeStats(prev: RawSample | undefined, cur: RawSample, dtSec: number, info: RawSample['info']): HostStats {
  const stats: HostStats = {
    at: Date.now(),
    os: info?.os,
    kernel: info?.kernel,
    hostname: info?.hostname,
    disks: cur.disks,
    load: cur.load,
    uptimeSec: cur.uptimeSec,
    supported: cur.hasProc
  }

  if (prev?.cpuTotal !== undefined && cur.cpuTotal !== undefined && prev.cpuIdle !== undefined && cur.cpuIdle !== undefined) {
    const dTotal = cur.cpuTotal - prev.cpuTotal
    const dIdle = cur.cpuIdle - prev.cpuIdle
    const pct = dTotal > 0 ? ((dTotal - dIdle) / dTotal) * 100 : 0
    stats.cpu = { percent: Math.max(0, Math.min(100, pct)), cores: cur.cores ?? 1 }
  }

  if (cur.mem?.MemTotal) {
    const m = cur.mem
    const avail = m.MemAvailable ?? (m.MemFree ?? 0) + (m.Buffers ?? 0) + (m.Cached ?? 0)
    stats.mem = {
      totalBytes: m.MemTotal,
      usedBytes: Math.max(0, m.MemTotal - avail),
      swapTotalBytes: m.SwapTotal ?? 0,
      swapUsedBytes: Math.max(0, (m.SwapTotal ?? 0) - (m.SwapFree ?? 0))
    }
  }

  if (cur.net) {
    const ifaces = Object.keys(cur.net).filter((n) => !IGNORED_IFACE.test(n))
    let rx = 0
    let tx = 0
    let drx = 0
    let dtx = 0
    for (const n of ifaces) {
      rx += cur.net[n].rx
      tx += cur.net[n].tx
      const p = prev?.net?.[n]
      if (p) {
        drx += Math.max(0, cur.net[n].rx - p.rx)
        dtx += Math.max(0, cur.net[n].tx - p.tx)
      }
    }
    const haveRate = prev?.net !== undefined && dtSec > 0
    stats.net = {
      rxTotalBytes: rx,
      txTotalBytes: tx,
      rxBytesPerSec: haveRate ? drx / dtSec : 0,
      txBytesPerSec: haveRate ? dtx / dtSec : 0,
      interfaces: ifaces
    }
  }

  return stats
}

/** Incrementally consume exec channel output and emit stats per completed sample. */
export class StatsParser {
  private buf = ''
  private prev?: RawSample
  private prevAt = 0
  private info?: RawSample['info']

  push(chunk: string, emit: (s: HostStats) => void): void {
    this.buf += chunk
    if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-200_000)
    let idx: number
    while ((idx = this.buf.indexOf('@@end\n')) !== -1) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + '@@end\n'.length)
      const cur = parseSample(block)
      if (cur.info) this.info = cur.info
      const now = Date.now()
      const dt = this.prevAt ? (now - this.prevAt) / 1000 : 0
      emit(computeStats(this.prev, cur, dt, this.info))
      this.prev = cur
      this.prevAt = now
    }
  }
}
