import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { StatsParser, computeStats, parseSample, statsCommand } from '../src/main/ssh/stats'

const sample = (user: number, idle: number, rx: number, tx: number): string => `@@stat
cpu  ${user} 0 100 ${idle} 50 0 10 0 0 0
cpu0 1 0 1 1 0 0 0 0 0 0
cpu1 1 0 1 1 0 0 0 0 0 0
@@mem
MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    6000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
@@net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999    100    0    0    0     0          0         0   999999    100    0    0    0     0       0          0
  eth0: ${rx}    100    0    0    0     0          0         0   ${tx}    100    0    0    0     0       0          0
veth12: 5000    10    0    0    0     0          0         0   5000    10    0    0    0     0       0          0
@@load
0.52 0.40 0.31 2/345 6789
@@uptime
93784.12 180000.00
@@disk
Filesystem     1024-blocks      Used Available Capacity Mounted on
tmpfs              1000000         0   1000000       0% /run
/dev/sda1        41000000  20500000  18000000      54% /
/dev/sdb1       100000000  10000000  90000000      10% /data
overlay          41000000  20500000  18000000      54% /var/lib/docker/overlay2/x/merged
`

describe('stats parsing', () => {
  it('parses a /proc snapshot', () => {
    const s = parseSample('@@info\nLinux 6.8.0 x86_64\nweb-1\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n' + sample(1000, 5000, 1000, 2000))
    expect(s.hasProc).toBe(true)
    expect(s.cores).toBe(2)
    expect(s.info).toEqual({ kernel: 'Linux 6.8.0 x86_64', hostname: 'web-1', os: 'Ubuntu 24.04.1 LTS' })
    expect(s.mem?.MemTotal).toBe(8000000 * 1024)
    expect(s.net?.eth0).toEqual({ rx: 1000, tx: 2000 })
    expect(s.load).toEqual([0.52, 0.4, 0.31])
    expect(s.uptimeSec).toBeCloseTo(93784.12)
    expect(s.disks.map((d) => d.mount)).toEqual(['/', '/data'])
  })

  it('computes CPU %, memory and network rates from two samples', () => {
    const a = parseSample(sample(1000, 5000, 1000, 2000))
    // +300 busy (user), +700 idle  => 30% busy
    const b = parseSample(sample(1300, 5700, 1000 + 4096, 2000 + 2048))
    const st = computeStats(a, b, 2, undefined)
    expect(st.cpu?.percent).toBeCloseTo(30, 5)
    expect(st.cpu?.cores).toBe(2)
    expect(st.mem?.usedBytes).toBe((8000000 - 6000000) * 1024)
    expect(st.mem?.swapUsedBytes).toBe(500000 * 1024)
    expect(st.net?.interfaces).toEqual(['eth0']) // lo and veth* ignored
    expect(st.net?.rxBytesPerSec).toBe(2048)
    expect(st.net?.txBytesPerSec).toBe(1024)
    expect(st.supported).toBe(true)
  })

  it('streams samples split across arbitrary chunks', () => {
    const p = new StatsParser()
    const out: number[] = []
    const text = sample(1000, 5000, 1, 1) + '@@end\n' + sample(1100, 5900, 1, 1) + '@@end\n'
    for (let i = 0; i < text.length; i += 37) p.push(text.slice(i, i + 37), (s) => out.push(s.cpu?.percent ?? -1))
    expect(out).toEqual([-1, 10])
  })

  it('marks non-Linux hosts unsupported but keeps df output', () => {
    const st = computeStats(undefined, parseSample('@@disk\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 500000 250000 250000 50% /\n'), 0, undefined)
    expect(st.supported).toBe(false)
    expect(st.disks[0]).toMatchObject({ mount: '/', totalBytes: 500000 * 1024 })
  })

  it('builds a command with no single quotes inside the script', () => {
    const cmd = statsCommand(5)
    const inner = cmd.slice("exec sh -c '".length, -1)
    expect(inner.includes("'")).toBe(false)
    expect(cmd).toContain('d=5')
  })

  it('is a single line, so htop and ps on the server show it cleanly', () => {
    expect(statsCommand(3)).not.toMatch(/[\r\n]/)
  })

  it('runs in a real sh and prints every section', () => {
    // the script itself, without the "exec" (which would replace the test's shell) and with a
    // fast exit after the first sample
    const inner = statsCommand(1).slice("exec sh -c '".length, -1).replace('sleep $d || exit 0;', 'exit 0;')
    const r = spawnSync('sh', ['-c', inner], { encoding: 'utf8', timeout: 10_000 })
    if (r.error) return // no sh on this machine (plain Windows without Git Bash)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toMatch(/syntax|unexpected/i)
    for (const section of ['@@info', '@@disk', '@@end']) expect(r.stdout).toContain(section)
    // a real Linux /proc (Git Bash on Windows has only part of one)
    if (process.platform === 'linux') {
      expect(r.stderr).toBe('')
      for (const section of ['@@stat', '@@mem', '@@net', '@@load', '@@uptime']) expect(r.stdout).toContain(section)
    }
  })
})
