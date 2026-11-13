import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { TransferDirection, TransferInfo } from '../shared/types'
import type { SshSession } from './ssh/session'
import { ensureRemoteDir, fastGet, fastPut, planDownload, planUpload } from './ssh/sftp'

interface Job {
  info: TransferInfo
  sftp?: SFTPWrapper
  cancelled: boolean
  currentDst?: string
  lastEmit: number
  rateBytes: number
  rateAt: number
}

const MAX_PARALLEL = 3

/**
 * Queues uploads/downloads. Each job uses its own SFTP channel, so cancelling a job simply
 * closes that channel without disturbing the file browser or other transfers.
 */
export class TransferManager {
  private jobs = new Map<string, Job>()
  private queue: Job[] = []
  private running = 0

  constructor(
    private getSession: (id: string) => SshSession | undefined,
    private emit: (t: TransferInfo) => void
  ) {}

  enqueue(sessionId: string, direction: TransferDirection, sources: string[], destDir: string): string[] {
    const ids: string[] = []
    for (const source of sources) {
      const name = direction === 'download' ? posix.basename(source) : basename(source)
      const job: Job = {
        info: {
          id: randomUUID(),
          sessionId,
          direction,
          name,
          source,
          destination: destDir,
          state: 'queued',
          bytesTotal: 0,
          bytesDone: 0,
          filesTotal: 0,
          filesDone: 0,
          bytesPerSec: 0,
          startedAt: Date.now()
        },
        cancelled: false,
        lastEmit: 0,
        rateBytes: 0,
        rateAt: 0
      }
      this.jobs.set(job.info.id, job)
      this.queue.push(job)
      ids.push(job.info.id)
      this.emit({ ...job.info })
    }
    this.pump()
    return ids
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || ['done', 'error', 'cancelled'].includes(job.info.state)) return
    job.cancelled = true
    if (job.info.state === 'queued') {
      this.queue = this.queue.filter((j) => j !== job)
      this.finish(job, 'cancelled')
    } else {
      job.sftp?.end()
    }
  }

  cancelSession(sessionId: string): void {
    for (const j of this.jobs.values()) if (j.info.sessionId === sessionId) this.cancel(j.info.id)
  }

  clear(sessionId: string): void {
    for (const [id, j] of this.jobs) {
      if (j.info.sessionId === sessionId && ['done', 'error', 'cancelled'].includes(j.info.state)) this.jobs.delete(id)
    }
  }

  private pump(): void {
    while (this.running < MAX_PARALLEL && this.queue.length) {
      const job = this.queue.shift()!
      this.running++
      this.run(job).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private progress(job: Job, force = false): void {
    const now = Date.now()
    if (!force && now - job.lastEmit < 200) return
    if (job.rateAt && now - job.rateAt >= 500) {
      const inst = ((job.info.bytesDone - job.rateBytes) / (now - job.rateAt)) * 1000
      job.info.bytesPerSec = job.info.bytesPerSec ? job.info.bytesPerSec * 0.6 + inst * 0.4 : inst
      job.rateBytes = job.info.bytesDone
      job.rateAt = now
    } else if (!job.rateAt) {
      job.rateAt = now
      job.rateBytes = job.info.bytesDone
    }
    job.lastEmit = now
    this.emit({ ...job.info })
  }

  private finish(job: Job, state: TransferInfo['state'], error?: string): void {
    job.info.state = state
    job.info.error = error
    job.info.finishedAt = Date.now()
    job.info.bytesPerSec = 0
    this.emit({ ...job.info })
  }

  private async run(job: Job): Promise<void> {
    const session = this.getSession(job.info.sessionId)
    if (!session) return this.finish(job, 'error', 'Session closed')
    job.info.state = 'running'
    job.info.startedAt = Date.now()
    this.progress(job, true)
    try {
      const sftp = await session.openSftp()
      job.sftp = sftp
      sftp.on('close', () => {
        job.sftp = undefined
      })
      if (job.cancelled) throw new Error('cancelled')
      const plan =
        job.info.direction === 'download'
          ? await planDownload(sftp, job.info.source, job.info.destination)
          : await planUpload(job.info.source, job.info.destination)
      job.info.bytesTotal = plan.bytes
      job.info.filesTotal = plan.files.length
      this.progress(job, true)

      for (const d of plan.dirs) {
        if (job.cancelled) throw new Error('cancelled')
        if (job.info.direction === 'download') await fs.mkdir(d, { recursive: true })
        else await ensureRemoteDir(sftp, d)
      }
      for (const f of plan.files) {
        if (job.cancelled) throw new Error('cancelled')
        const base = job.info.bytesDone
        job.currentDst = f.dst
        const step = (done: number): void => {
          job.info.bytesDone = base + done
          this.progress(job)
        }
        if (job.info.direction === 'download') await fastGet(sftp, f.src, f.dst, step)
        else await fastPut(sftp, f.src, f.dst, f.mode, step)
        job.currentDst = undefined
        job.info.bytesDone = base + f.size
        job.info.filesDone++
        this.progress(job, true)
      }
      sftp.end()
      this.finish(job, 'done')
    } catch (e) {
      job.sftp?.end()
      if (job.cancelled) {
        // remove the partially written file
        const partial = job.currentDst
        if (partial && job.info.direction === 'download') await fs.rm(partial, { force: true }).catch(() => undefined)
        if (partial && job.info.direction === 'upload') {
          await session
            .sftp()
            .then((s) => new Promise<void>((r) => s.unlink(partial, () => r())))
            .catch(() => undefined)
        }
        this.finish(job, 'cancelled')
      } else {
        this.finish(job, 'error', (e as Error).message)
      }
    }
  }
}
