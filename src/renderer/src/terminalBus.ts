// Terminal output bypasses React state: chunks go straight to the xterm instance,
// buffered until the terminal for a session has mounted.

type Sink = (data: Uint8Array) => void

const sinks = new Map<string, Sink>()
const pending = new Map<string, Uint8Array[]>()

export function pushTerminalData(sessionId: string, data: Uint8Array): void {
  const sink = sinks.get(sessionId)
  if (sink) return sink(data)
  const buf = pending.get(sessionId) ?? []
  buf.push(data)
  pending.set(sessionId, buf)
}

export function attachTerminal(sessionId: string, sink: Sink): () => void {
  sinks.set(sessionId, sink)
  for (const chunk of pending.get(sessionId) ?? []) sink(chunk)
  pending.delete(sessionId)
  return () => {
    if (sinks.get(sessionId) === sink) sinks.delete(sessionId)
  }
}

export function disposeTerminal(sessionId: string): void {
  sinks.delete(sessionId)
  pending.delete(sessionId)
}
