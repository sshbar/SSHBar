/**
 * Soft-keyboard handling, replaying events recorded from a Samsung Galaxy S25 keyboard typing
 * "hello world" (test/fixtures/samsung-keyboard-hello-world.json).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enableSoftKeyboardInput } from '../src/renderer/src/touchInput'

interface Recorded {
  type: string
  key?: string
  code?: number
  inputType?: string
  data?: string
}

function harness() {
  const container = new EventTarget() as EventTarget & { querySelector: () => null }
  container.querySelector = () => null
  const sent: string[] = []
  // In the page the listener sits on xterm's container (capture phase): an event whose propagation
  // was not stopped there continues down to xterm.js's own textarea listeners.
  const reachedXterm: string[] = []
  const dispose = enableSoftKeyboardInput(container as unknown as HTMLElement, (d) => sent.push(d))
  const fire = (r: Recorded): void => {
    const ev = new Event(r.type) as Event & Record<string, unknown>
    Object.assign(ev, { data: r.data ?? null, inputType: r.inputType ?? '', keyCode: r.code ?? 0, key: r.key ?? '' })
    container.dispatchEvent(ev)
    if (!ev.cancelBubble) reachedXterm.push(r.type)
  }
  return { fire, sent, reachedXterm, dispose }
}

/** Apply the bytes a shell would receive to a line buffer (DEL = erase one character). */
const shellLine = (chunks: string[]): string =>
  chunks.join('').split('').reduce((line, ch) => (ch === '\x7f' ? line.slice(0, -1) : line + ch), '')

describe('soft keyboard input', () => {
  it('sends a real Samsung keyboard sequence letter by letter, without duplicates', () => {
    const log = JSON.parse(readFileSync(join(__dirname, 'fixtures/samsung-keyboard-hello-world.json'), 'utf8')) as Recorded[]
    const h = harness()
    for (const r of log) h.fire(r)
    // the second word was still being composed when the recording stopped: it must already be sent
    expect(shellLine(h.sent)).toBe('hello world')
    // each letter is sent as soon as it is typed
    expect(h.sent.slice(0, 5)).toEqual(['h', 'e', 'l', 'l', 'o'])
    // none of the text-carrying IME events reach xterm.js (which would show the overlay / double-send);
    // keyup is left alone: xterm only uses it to reset its key state
    expect(h.reachedXterm.filter((t) => t !== 'keyup')).toEqual([])
  })

  it('sends DEL when the keyboard revises the word (autocorrect, backspace)', () => {
    const h = harness()
    h.fire({ type: 'compositionstart' })
    for (const d of ['t', 'te', 'teh', 'te', 'teh']) h.fire({ type: 'compositionupdate', data: d })
    h.fire({ type: 'compositionend', data: 'the' })
    expect(shellLine(h.sent)).toBe('the')
    expect(h.sent).toContain('\x7f')
  })

  it('handles text, backspace and enter that arrive outside a composition', () => {
    const h = harness()
    h.fire({ type: 'keydown', code: 229 })
    h.fire({ type: 'input', inputType: 'insertText', data: 'ls' })
    h.fire({ type: 'input', inputType: 'deleteContentBackward' })
    h.fire({ type: 'input', inputType: 'insertText', data: 's -la' })
    h.fire({ type: 'input', inputType: 'insertLineBreak' })
    expect(h.sent.join('')).toBe('ls\x7fs -la\r')
  })

  it('leaves real key presses (hardware keyboards, keyCode != 229) to xterm.js', () => {
    const h = harness()
    h.fire({ type: 'keydown', code: 13, key: 'Enter' })
    expect(h.reachedXterm).toEqual(['keydown'])
    expect(h.sent).toEqual([])
    h.dispose()
  })
})
