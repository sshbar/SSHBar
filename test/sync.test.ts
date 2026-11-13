import { describe, expect, it } from 'vitest'
import { decodePayload, encodePayload, mergeHosts } from '../src/main/sync'
import { sanitizeHost } from '../src/main/store/hosts'
import type { Host } from '../src/shared/types'

const h = (id: string, updatedAt: number, label = id): Host => sanitizeHost({ id, hostname: `${id}.example`, label, updatedAt, createdAt: 1 })

describe('host sync merge', () => {
  it('keeps the newest version of each host', () => {
    const m = mergeHosts({ hosts: [h('a', 10, 'old'), h('b', 5)], deleted: {} }, { hosts: [h('a', 20, 'new'), h('c', 7)], deleted: {} }, 100)
    expect(m.hosts.map((x) => `${x.id}:${x.label}`).sort()).toEqual(['a:new', 'b:b', 'c:c'])
  })

  it('applies deletions unless the host was edited afterwards', () => {
    const m = mergeHosts({ hosts: [h('a', 10), h('b', 50)], deleted: {} }, { hosts: [], deleted: { a: 20, b: 30 } }, 100)
    expect(m.hosts.map((x) => x.id)).toEqual(['b'])
    expect(m.deleted).toEqual({ a: 20 })
  })

  it('expires very old tombstones', () => {
    const now = Date.now()
    const m = mergeHosts({ hosts: [], deleted: { x: now - 365 * 86400_000 } }, { hosts: [], deleted: {} }, now)
    expect(m.deleted).toEqual({})
  })

  it('round-trips the payload, compressing large lists', () => {
    const small = { v: 1 as const, at: 1, hosts: [h('a', 1)], deleted: {}, snippets: [], snippetsDeleted: {} }
    expect(encodePayload(small).startsWith('{')).toBe(true)
    const many = { v: 1 as const, at: 2, hosts: Array.from({ length: 80 }, (_, i) => h(`host-${i}`, i)), deleted: { z: 5 }, snippets: [], snippetsDeleted: {} }
    const enc = encodePayload(many)
    expect(enc.startsWith('gz1:')).toBe(true)
    expect(enc.length).toBeLessThan(JSON.stringify(many).length / 3)
    const dec = decodePayload(enc)
    expect(dec.hosts).toHaveLength(80)
    expect(dec.deleted).toEqual({ z: 5 })
    expect(decodePayload(undefined).hosts).toEqual([])
  })

  it('drops invalid hosts from untrusted payloads', () => {
    const dec = decodePayload(JSON.stringify({ hosts: [{ id: 'x', hostname: 'bad host/name' }, { id: 'y', hostname: 'ok.example', port: 99999 }] }))
    expect(dec.hosts.map((x) => x.id)).toEqual(['y'])
    expect(dec.hosts[0].port).toBe(22)
  })
})
