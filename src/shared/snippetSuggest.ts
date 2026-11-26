// Suggesting saved snippets while typing on the shell's command line (desktop and Android).
//
// SSHbar only sees the keystrokes it sends, not the remote line editor, so InputLine follows what
// was typed since the last Enter. As soon as something happens it can't follow (arrow keys, Tab
// completion, history, Ctrl+A…) it gives up until the next line instead of guessing.

/** Minimum typed characters before anything is suggested. */
export const SUGGEST_MIN_CHARS = 3
export const SUGGEST_LIMIT = 6

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export class InputLine {
  private chars: string[] = []
  private known = true
  private inPaste = false

  /** what was typed on this line, or null when it can't be known */
  get text(): string | null {
    return this.known ? this.chars.join('') : null
  }

  reset(): void {
    this.chars = []
    this.known = true
    this.inPaste = false
  }

  /** Follow data sent to the shell (keystrokes, pastes, accepted suggestions). */
  feed(data: string): void {
    let i = 0
    while (i < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i)
        const chunk = data.slice(i, end < 0 ? data.length : end)
        // a multi-line paste is run line by line by the shell (or edited in ways we can't follow)
        if (/[\r\n]/.test(chunk) || hasControl(chunk)) this.known = false
        else if (this.known) this.chars.push(...chunk)
        if (end < 0) return
        this.inPaste = false
        i = end + PASTE_END.length
        continue
      }
      const c = data[i]
      if (c === '\x1b') {
        if (data.startsWith(PASTE_START, i)) {
          this.inPaste = true
          i += PASTE_START.length
          continue
        }
        // arrows, Home/End, Alt+key, Esc: the cursor or the line changed in ways we can't follow
        this.known = false
        i += escapeLength(data, i)
        continue
      }
      i++
      if (c === '\r' || c === '\n' || c === '\x03') {
        // Enter or Ctrl+C: a fresh line
        this.chars = []
        this.known = true
      } else if (c === '\x15') {
        // Ctrl+U: erase to the start of the line (we only ever track a cursor at the end)
        if (this.known) this.chars = []
      } else if (c === '\x7f' || c === '\b') {
        if (this.known) this.chars.pop()
      } else if (c === '\x17') {
        // Ctrl+W: erase the previous word
        if (this.known) {
          while (this.chars.length && this.chars[this.chars.length - 1] === ' ') this.chars.pop()
          while (this.chars.length && this.chars[this.chars.length - 1] !== ' ') this.chars.pop()
        }
      } else if (c === '\x0c') {
        // Ctrl+L redraws the screen and keeps the line
      } else if (c < ' ') {
        this.known = false // Tab completion, Ctrl+A/E/R/…
      } else if (this.known) {
        // keep surrogate pairs together so Backspace removes whole characters
        if (c >= '\ud800' && c <= '\udbff' && i < data.length) this.chars.push(c + data[i++])
        else this.chars.push(c)
      }
    }
  }
}

/** Length of the escape sequence starting at `i` (CSI, SS3, Alt+key or a lone Esc). */
function escapeLength(s: string, i: number): number {
  const next = s[i + 1]
  if (next === '[') {
    let j = i + 2
    while (j < s.length && !(s[j] >= '@' && s[j] <= '~')) j++
    return Math.min(s.length, j + 1) - i
  }
  if (next === 'O') return Math.min(3, s.length - i)
  return next === undefined ? 1 : 2
}

function hasControl(s: string): boolean {
  return /[\x00-\x1f\x7f]/.test(s)
}

export interface SnippetLike {
  id: string
  name: string
  command: string
}

export interface Suggestion<S extends SnippetLike = SnippetLike> {
  snippet: S
  /** what to send so the line becomes the snippet's command (never includes Enter) */
  insert: string
}

/**
 * Snippets matching what's typed: commands starting with it first (`sudo apt up` → `sudo apt update`,
 * `sudo apt upgrade`), then the same ignoring case, then snippet names starting with it, then commands
 * with a word starting with it. Shorter commands come first within each group.
 * Multi-line snippets are left out: typing their line breaks would run them.
 */
export function suggestSnippets<S extends SnippetLike>(snippets: readonly S[], typed: string, limit = SUGGEST_LIMIT): Suggestion<S>[] {
  const query = typed.trimStart()
  if ([...query.trim()].length < SUGGEST_MIN_CHARS) return []
  const q = query.toLowerCase()
  // erase what was typed (leading spaces stay) and type the whole command instead
  const replace = (cmd: string): string => '\x7f'.repeat([...query].length) + cmd

  const ranked: { s: S; rank: number; insert: string; cmd: string }[] = []
  for (const s of snippets) {
    const cmd = s.command.replace(/\r?\n$/, '')
    if (!cmd.trim() || hasControl(cmd) || cmd === query) continue
    const c = cmd.toLowerCase()
    let rank: number
    let insert: string
    if (cmd.startsWith(query)) {
      rank = 0
      insert = cmd.slice(query.length) // only the missing part
    } else if (c.startsWith(q)) {
      rank = 1
      insert = replace(cmd) // same letters, different case
    } else if (s.name.toLowerCase().startsWith(q)) {
      rank = 2
      insert = replace(cmd)
    } else if (wordStartsWith(c, q)) {
      rank = 3
      insert = replace(cmd)
    } else continue
    ranked.push({ s, rank, insert, cmd })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.cmd.length - b.cmd.length || a.cmd.localeCompare(b.cmd))
  return ranked.slice(0, limit).map((r) => ({ snippet: r.s, insert: r.insert }))
}

function wordStartsWith(text: string, q: string): boolean {
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
    if (i === 0 || /[\s|;&(]/.test(text[i - 1])) return true
  }
  return false
}
