import { Braces } from 'lucide-react'
import type { Snippet } from '../../../shared/types'
import type { Suggestion } from '../../../shared/snippetSuggest'

export interface SuggestState {
  items: Suggestion<Snippet>[]
  /** highlighted row, -1 = none (Enter then goes to the shell as usual) */
  sel: number
  left: number
  top?: number
  bottom?: number
}

/**
 * Snippets matching the command being typed, shown next to the cursor. Picking one only fills it in.
 * Hovering only highlights: the keyboard selection (what Enter fills in) moves with the arrow keys
 * alone, so a list that pops up under the mouse pointer can never change what Enter does.
 */
export function SnippetSuggestions({
  state,
  touch,
  onPick
}: {
  state: SuggestState
  touch: boolean
  onPick: (s: Suggestion<Snippet>) => void
}) {
  // never take focus from the terminal: keeps typing going there and the soft keyboard open
  const keep = (e: React.PointerEvent | React.MouseEvent): void => e.preventDefault()
  return (
    <div
      className={`suggest ${touch ? 'touch' : ''}`}
      style={{ left: state.left, top: state.top, bottom: state.bottom }}
      onPointerDown={keep}
      onMouseDown={keep}
      role="listbox"
      aria-label="Matching snippets"
    >
      {state.items.map((it, i) => {
        const cmd = it.snippet.command.replace(/\r?\n$/, '')
        return (
          <div
            key={it.snippet.id}
            role="option"
            aria-selected={i === state.sel}
            className={`suggest-item ${i === state.sel ? 'on' : ''}`}
            onClick={() => onPick(it)}
            title={touch ? undefined : 'Fill in (you run it with Enter)'}
          >
            <Braces size={13} />
            <span className="suggest-cmd mono">{cmd}</span>
            {it.snippet.name !== cmd && <span className="suggest-name">{it.snippet.name}</span>}
          </div>
        )
      })}
      <div className="suggest-foot">
        {touch ? (
          'Tap to fill in · you run it'
        ) : (
          <>
            <kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>Enter</kbd> fill in · <kbd>Esc</kbd> close
          </>
        )}
      </div>
    </div>
  )
}
