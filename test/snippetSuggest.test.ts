import { describe, expect, it } from 'vitest'
import { InputLine, suggestSnippets, type SnippetLike } from '../src/shared/snippetSuggest'

const typed = (...chunks: string[]): string | null => {
  const l = new InputLine()
  for (const c of chunks) l.feed(c)
  return l.text
}

/** What the shell's line ends up as after receiving `insert` on top of `line` (DEL = erase one character). */
const apply = (line: string, insert: string): string =>
  [...insert].reduce((acc, ch) => (ch === '\x7f' ? [...acc].slice(0, -1).join('') : acc + ch), line)

const snip = (command: string, name = command, id = command): SnippetLike => ({ id, name, command })

describe('InputLine', () => {
  it('follows typing, backspace and Enter', () => {
    expect(typed('s', 'u', 'd', 'o')).toBe('sudo')
    expect(typed('sudo apt upx', '\x7f')).toBe('sudo apt up')
    expect(typed('ls -la', '\r', 'sud')).toBe('sud')
    expect(typed('ls -la\r')).toBe('')
  })

  it('handles Ctrl+C, Ctrl+U, Ctrl+W and Ctrl+L', () => {
    expect(typed('rm -rf /tmp/x', '\x03', 'sud')).toBe('sud')
    expect(typed('whatever', '\x15', 'git')).toBe('git')
    expect(typed('git commit  ', '\x17')).toBe('git ')
    expect(typed('docker', '\x0c', ' ps')).toBe('docker ps')
  })

  it('gives up on anything it cannot follow until the next line', () => {
    expect(typed('sudo', '\x1b[A')).toBeNull() // history
    expect(typed('sudo apt', '\x1b[D', 'x')).toBeNull() // cursor moved
    expect(typed('sud', '\t')).toBeNull() // completion
    expect(typed('sudo', '\x01')).toBeNull() // Ctrl+A
    expect(typed('sudo', '\x1bb')).toBeNull() // Alt+B
    expect(typed('sudo', '\x1b[A', '\r', 'apt')).toBe('apt')
    expect(typed('sudo', '\x1b[A', '\x03')).toBe('')
  })

  it('takes single-line pastes, bracketed or not', () => {
    expect(typed('echo ', '\x1b[200~hello world\x1b[201~')).toBe('echo hello world')
    expect(typed('\x1b[200~sudo ', 'apt\x1b[201~', ' up')).toBe('sudo apt up')
    expect(typed('cd /srv')).toBe('cd /srv')
    expect(typed('\x1b[200~line1\nline2\x1b[201~')).toBeNull()
  })

  it('removes whole characters on backspace', () => {
    expect(typed('echo 🚀', '\x7f')).toBe('echo ')
    expect(typed('café', '\x7f')).toBe('caf')
  })
})

describe('suggestSnippets', () => {
  const snippets = [
    snip('sudo apt update', 'Update package lists'),
    snip('sudo apt upgrade -y', 'Upgrade packages'),
    snip('sudo systemctl restart nginx', 'Restart nginx'),
    snip('docker compose up -d', 'Start the stack'),
    snip('docker ps -a'),
    snip('cat <<EOF\nhello\nEOF', 'Heredoc'),
    snip('Sudo apt autoremove', 'odd case')
  ]

  it('offers the commands that start with what was typed (the example from the request)', () => {
    const r = suggestSnippets(snippets, 'sudo apt up')
    expect(r.map((s) => s.snippet.command)).toEqual(['sudo apt update', 'sudo apt upgrade -y'])
    expect(r[0].insert).toBe('date')
    expect(apply('sudo apt up', r[1].insert)).toBe('sudo apt upgrade -y')
  })

  it('starts after three letters', () => {
    expect(suggestSnippets(snippets, 'su')).toEqual([])
    expect(suggestSnippets(snippets, '  do')).toEqual([])
    expect(suggestSnippets(snippets, 'sud').map((s) => s.snippet.command)).toEqual([
      'sudo apt update',
      'sudo apt upgrade -y',
      'sudo systemctl restart nginx',
      'Sudo apt autoremove'
    ])
  })

  it('never inserts Enter, so nothing ever runs by itself', () => {
    for (const q of ['sud', 'doc', 'upd', 'res', 'Hered', 'nginx']) {
      for (const s of suggestSnippets(snippets, q)) expect(s.insert).not.toMatch(/[\r\n]/)
    }
  })

  it('leaves out multi-line snippets and the exact command already typed', () => {
    expect(suggestSnippets(snippets, 'cat')).toEqual([])
    expect(suggestSnippets(snippets, 'Hered')).toEqual([])
    expect(suggestSnippets(snippets, 'docker ps -a')).toEqual([])
  })

  it('also matches snippet names and words inside commands, replacing what was typed', () => {
    const byName = suggestSnippets(snippets, 'restart')
    expect(byName[0].snippet.command).toBe('sudo systemctl restart nginx')
    expect(apply('restart', byName[0].insert)).toBe('sudo systemctl restart nginx')
    const byWord = suggestSnippets(snippets, 'compose')
    expect(byWord.map((s) => s.snippet.command)).toEqual(['docker compose up -d'])
    expect(apply('compose', byWord[0].insert)).toBe('docker compose up -d')
    // only at the start of a word: "pdate" is not a match
    expect(suggestSnippets(snippets, 'pdate')).toEqual([])
  })

  it('fixes the case of what was typed when only the case differs', () => {
    const r = suggestSnippets([snip('Sudo apt autoremove')], 'sudo apt a')
    expect(apply('sudo apt a', r[0].insert)).toBe('Sudo apt autoremove')
  })

  it('keeps leading spaces and the rest of the line intact', () => {
    const r = suggestSnippets(snippets, '  docker comp')
    expect(apply('  docker comp', r[0].insert)).toBe('  docker compose up -d')
    const w = suggestSnippets(snippets, '  compose')
    expect(apply('  compose', w[0].insert)).toBe('  docker compose up -d')
  })

  it('drops a trailing newline and skips commands with control characters', () => {
    expect(suggestSnippets([snip('uptime\n')], 'upt')[0].insert).toBe('ime')
    expect(suggestSnippets([snip('printf "a\tb"')], 'pri')).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => snip(`kubectl get pods -n ns${i}`))
    expect(suggestSnippets(many, 'kub')).toHaveLength(6)
  })
})
