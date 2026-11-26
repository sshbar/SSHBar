// Touch-screen input for the terminal (Android): swipe scrolling and soft-keyboard typing.
import type { Terminal } from '@xterm/xterm'

/** Swipe-to-scroll for touch screens, with a little inertia. Returns a cleanup function. */
export function enableTouchScroll(el: HTMLElement, term: Terminal, send: (d: string) => void): () => void {
  let lastY: number | null = null
  let lastT = 0
  let acc = 0
  let velocity = 0 // px per ms, positive = finger moving up
  let raf = 0
  const lineHeight = (): number => {
    const row = el.querySelector('.xterm-rows > div') as HTMLElement | null
    return row?.offsetHeight || 18
  }
  const scrollPx = (px: number): void => {
    acc += px
    const lh = lineHeight()
    const lines = Math.trunc(acc / lh)
    if (!lines) return
    acc -= lines * lh
    if (term.buffer.active.type === 'alternate') send((lines > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.min(Math.abs(lines), 20)))
    else term.scrollLines(lines)
  }
  const onStart = (e: TouchEvent): void => {
    cancelAnimationFrame(raf)
    if (e.touches.length !== 1) return
    lastY = e.touches[0].clientY
    lastT = performance.now()
    acc = 0
    velocity = 0
  }
  const onMove = (e: TouchEvent): void => {
    if (lastY === null || e.touches.length !== 1) return
    const y = e.touches[0].clientY
    const now = performance.now()
    const dy = lastY - y
    if (now > lastT) velocity = 0.8 * (dy / (now - lastT)) + 0.2 * velocity
    lastY = y
    lastT = now
    scrollPx(dy)
    e.preventDefault()
  }
  const onEnd = (): void => {
    if (lastY === null) return
    lastY = null
    if (Math.abs(velocity) < 0.3 || term.buffer.active.type === 'alternate') return
    let v = velocity
    let t = performance.now()
    const step = (): void => {
      const now = performance.now()
      scrollPx(v * (now - t))
      t = now
      v *= 0.95
      if (Math.abs(v) > 0.05) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }
  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEnd, { passive: true })
  el.addEventListener('touchcancel', onEnd, { passive: true })
  return () => {
    cancelAnimationFrame(raf)
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
  }
}

/**
 * Android soft keyboards (Samsung, Gboard…) deliver typing as IME "composition": the word being typed
 * is only committed when it is finished. xterm.js then shows it in an overlay over the cursor and sends
 * nothing until the word ends, so the cursor disappears and Tab / Ctrl+C mid-word arrive too early.
 *
 * Instead, intercept the keyboard events before xterm sees them (capture phase on the container) and
 * send the difference between successive composition states as it happens: new letters, or DEL when
 * the keyboard revises the word. Non-composed text, Backspace and Enter from the IME are handled too;
 * real key presses (hardware keyboards, keyCode != 229) still go through xterm untouched.
 */
const IME_RESET = 'sshbar-ime-reset'

/**
 * After SSHbar typed something itself (a snippet suggestion), make the soft keyboard start a fresh
 * word. Otherwise it keeps composing the word typed before and may "autocorrect" it later, which would
 * send Backspaces into the text just filled in. Blur commits the composition (no new text: it was
 * already sent letter by letter) and the immediate focus keeps the keyboard open.
 */
export function restartSoftKeyboard(container: HTMLElement): void {
  const ta = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  if (!ta) return
  container.dispatchEvent(new Event(IME_RESET))
  ta.blur()
  ta.value = ''
  ta.focus({ preventScroll: true })
}

export function enableSoftKeyboardInput(container: HTMLElement, send: (d: string) => void): () => void {
  let composing = false
  let sent = ''
  // after restartSoftKeyboard: the word being composed was abandoned, ignore its last events
  let stale = false
  // A real key is down (hardware keyboard, `adb shell input`): xterm.js types it itself. Handling the
  // input event it also causes would type it a second time (that is how spaces got doubled).
  let realKey = false
  const textarea = (): HTMLTextAreaElement | null => container.querySelector('.xterm-helper-textarea')

  const sync = (text: string): void => {
    let i = 0
    while (i < sent.length && i < text.length && sent[i] === text[i]) i++
    const remove = [...sent.slice(i)].length
    const add = text.slice(i)
    if (remove) send('\x7f'.repeat(remove))
    if (add) send(add)
    sent = text
  }
  // keep the hidden textarea short so the keyboard has no old text to autocorrect against
  const resetSoon = (): void => {
    setTimeout(() => {
      const ta = textarea()
      if (ta && !composing) ta.value = ''
    }, 0)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    realKey = e.keyCode !== 229
    if (!realKey) e.stopPropagation() // IME placeholder key: the real text arrives as input events
  }
  // also on focus loss: a key released elsewhere never sends its keyup here, and the soft keyboard
  // must not be ignored until the next key press
  const onKeyUp = (): void => {
    realKey = false
  }
  const onCompositionStart = (e: CompositionEvent): void => {
    e.stopPropagation()
    composing = true
    stale = false
    sent = ''
  }
  const onCompositionUpdate = (e: CompositionEvent): void => {
    e.stopPropagation()
    if (!stale) sync(e.data ?? '')
  }
  const onCompositionEnd = (e: CompositionEvent): void => {
    e.stopPropagation()
    if (stale) {
      stale = false
      return
    }
    sync(e.data ?? '')
    composing = false
    sent = ''
    resetSoon()
  }
  const onBeforeInput = (e: Event): void => {
    if (!realKey) e.stopPropagation()
  }
  const onInput = (e: Event): void => {
    const ev = e as InputEvent
    if (realKey && !composing) return // xterm.js already typed this key
    e.stopPropagation()
    if (composing || stale || ev.inputType === 'insertCompositionText') return
    if (ev.inputType === 'insertText' && ev.data) send(ev.data)
    else if (ev.inputType === 'deleteContentBackward') send('\x7f')
    else if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') send('\r')
    resetSoon()
  }

  const onReset = (): void => {
    stale = composing
    composing = false
    sent = ''
    // blur ends the composition synchronously; never let a missing event swallow later typing
    if (stale) setTimeout(() => (stale = false), 300)
  }

  const listeners: [string, EventListener][] = [
    [IME_RESET, onReset],
    ['keydown', onKeyDown as EventListener],
    ['keyup', onKeyUp],
    ['focusout', onKeyUp],
    ['compositionstart', onCompositionStart as EventListener],
    ['compositionupdate', onCompositionUpdate as EventListener],
    ['compositionend', onCompositionEnd as EventListener],
    ['beforeinput', onBeforeInput],
    ['input', onInput]
  ]
  for (const [type, fn] of listeners) container.addEventListener(type, fn, true)
  return () => {
    for (const [type, fn] of listeners) container.removeEventListener(type, fn, true)
  }
}
