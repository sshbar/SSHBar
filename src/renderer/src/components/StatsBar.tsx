import { Activity, Clock, Cpu, Gauge, HardDrive, MemoryStick } from 'lucide-react'
import type { SessionState } from '../store'
import { bytes, duration, pct, rate } from '../format'
import { StatusDot } from './StatusDot'

function Spark({ values, max, className }: { values: number[]; max?: number; className?: string }) {
  const w = 64
  const h = 18
  if (values.length < 2) return <svg className={`spark ${className ?? ''}`} width={w} height={h} />
  const m = max ?? Math.max(1, ...values)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (Math.min(v, m) / m) * (h - 2)).toFixed(1)}`)
  return (
    <svg className={`spark ${className ?? ''}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={`0,${h} ${pts.join(' ')} ${w},${h}`} className="spark-fill" />
      <polyline points={pts.join(' ')} className="spark-line" />
    </svg>
  )
}

function Meter({ value }: { value: number }) {
  const level = value >= 90 ? 'crit' : value >= 70 ? 'warn' : 'ok'
  return (
    <span className={`meter meter-${level}`}>
      <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </span>
  )
}

/** The bottom panel: live CPU, memory, network and disk usage for the active connection. */
export function StatsBar({ session }: { session: SessionState }) {
  const st = session.stats
  const connected = session.status === 'connected'

  const statusText =
    session.status === 'connected'
      ? 'Connected'
      : session.status === 'error'
        ? 'Error'
        : session.status === 'closed'
          ? 'Disconnected'
          : 'Connecting…'

  if (!connected || !st) {
    return (
      <div className="statsbar">
        <div className="sb-item">
          <StatusDot status={session.status} /> {statusText}
          <span className="muted"> · {session.subtitle}</span>
        </div>
        {connected && <div className="sb-item muted">Collecting stats…</div>}
      </div>
    )
  }

  if (!st.supported) {
    return (
      <div className="statsbar">
        <div className="sb-item">
          <StatusDot status={session.status} /> {st.hostname ?? session.subtitle}
          {st.os && <span className="muted"> · {st.os}</span>}
        </div>
        {st.disks[0] && (
          <div className="sb-item" title={st.disks.map((d) => `${d.mount}: ${bytes(d.usedBytes)} / ${bytes(d.totalBytes)}`).join('\n')}>
            <HardDrive size={13} /> {st.disks[0].mount} {pct(st.disks[0].usedBytes, st.disks[0].totalBytes)}%
          </div>
        )}
        <div className="sb-item muted">Live CPU / RAM / network stats need a Linux server (/proc).</div>
      </div>
    )
  }

  const memPct = st.mem ? pct(st.mem.usedBytes, st.mem.totalBytes) : 0
  const root = st.disks[0]
  const diskPct = root ? pct(root.usedBytes, root.totalBytes) : 0

  return (
    <div className="statsbar">
      <div className="sb-item" title={[st.hostname, st.os, st.kernel].filter(Boolean).join('\n')}>
        <StatusDot status={session.status} />
        <span className="sb-host">{st.hostname ?? session.subtitle}</span>
        {st.os && <span className="muted sb-os">{st.os}</span>}
      </div>

      <div className="sb-item" title={st.cpu ? `${st.cpu.cores} cores` : ''}>
        <Cpu size={13} />
        <span className="sb-label">CPU</span>
        <span className="sb-val">{st.cpu ? `${st.cpu.percent.toFixed(0)}%` : '—'}</span>
        <Spark values={session.cpuHistory} max={100} className="cpu" />
      </div>

      {st.mem && (
        <div
          className="sb-item"
          title={`Used ${bytes(st.mem.usedBytes)} of ${bytes(st.mem.totalBytes)}${
            st.mem.swapTotalBytes ? `\nSwap ${bytes(st.mem.swapUsedBytes)} of ${bytes(st.mem.swapTotalBytes)}` : ''
          }`}
        >
          <MemoryStick size={13} />
          <span className="sb-label">RAM</span>
          <span className="sb-val">
            {bytes(st.mem.usedBytes)} / {bytes(st.mem.totalBytes)}
          </span>
          <Meter value={memPct} />
        </div>
      )}

      {st.net && (
        <div
          className="sb-item"
          title={`Interfaces: ${st.net.interfaces.join(', ') || '—'}\nTotal received ${bytes(st.net.rxTotalBytes)}\nTotal sent ${bytes(st.net.txTotalBytes)}`}
        >
          <Activity size={13} />
          <span className="sb-label">NET</span>
          <span className="sb-val rx">↓ {rate(st.net.rxBytesPerSec)}</span>
          <span className="sb-val tx">↑ {rate(st.net.txBytesPerSec)}</span>
          <Spark values={session.netHistory.map((n) => n.rx + n.tx)} className="net" />
        </div>
      )}

      {root && (
        <div
          className="sb-item"
          title={st.disks.map((d) => `${d.mount} (${d.filesystem}): ${bytes(d.usedBytes)} / ${bytes(d.totalBytes)}`).join('\n')}
        >
          <HardDrive size={13} />
          <span className="sb-label">DISK</span>
          <span className="sb-val">
            {root.mount} {bytes(root.usedBytes)} / {bytes(root.totalBytes)}
          </span>
          <Meter value={diskPct} />
        </div>
      )}

      <div className="grow" />

      {st.load && (
        <div className="sb-item" title="Load average (1, 5, 15 min)">
          <Gauge size={13} />
          <span className="sb-val">{st.load.map((l) => l.toFixed(2)).join(' ')}</span>
        </div>
      )}
      {st.uptimeSec !== undefined && (
        <div className="sb-item" title="Uptime">
          <Clock size={13} />
          <span className="sb-val">{duration(st.uptimeSec)}</span>
        </div>
      )}
    </div>
  )
}
