/**
 * Renderer store regression tests. React StrictMode (dev) runs effects twice, so init()
 * must be idempotent — otherwise every terminal chunk and every prompt arrives twice.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PromptRequest, SessionEvent } from '../src/shared/types'

type Listener<T> = (v: T) => void
const listeners = { ssh: [] as Listener<SessionEvent>[], prompt: [] as Listener<PromptRequest>[] }
const noop = () => () => undefined

;(globalThis as unknown as { window: unknown }).window = {
  sshbuddy: {
    platform: 'linux',
    hosts: { list: async () => [], onChanged: noop },
    settings: { get: async () => ({}), onChanged: noop },
    ssh: {
      onEvent: (cb: Listener<SessionEvent>) => {
        listeners.ssh.push(cb)
        return () => undefined
      }
    },
    prompts: {
      onRequest: (cb: Listener<PromptRequest>) => {
        listeners.prompt.push(cb)
        return () => undefined
      },
      onCancel: noop
    },
    sftp: { onTransfer: noop },
    fileSync: { status: async () => null, onStatus: noop }
  }
}

describe('renderer store', () => {
  it('subscribes to main-process events only once even if init() runs twice', async () => {
    const { useStore } = await import('../src/renderer/src/store')
    const { attachTerminal } = await import('../src/renderer/src/terminalBus')
    await Promise.all([useStore.getState().init(), useStore.getState().init()])
    await useStore.getState().init()

    expect(listeners.ssh).toHaveLength(1)
    expect(listeners.prompt).toHaveLength(1)

    const sink = vi.fn()
    attachTerminal('s1', sink)
    for (const l of listeners.ssh) l({ type: 'data', sessionId: 's1', data: new Uint8Array([104, 105]) })
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('ignores a prompt it is already showing', async () => {
    const { useStore } = await import('../src/renderer/src/store')
    const req: PromptRequest = { id: 'p1', kind: 'credentials', title: 't', message: '', fields: [], allowRemember: false }
    for (const l of listeners.prompt) l(req)
    for (const l of listeners.prompt) l(req)
    expect(useStore.getState().prompts.map((p) => p.id)).toEqual(['p1'])
  })
})
