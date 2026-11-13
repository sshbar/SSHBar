import type { SessionStatus } from '../../../shared/types'

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dot dot-${status}`} />
}
