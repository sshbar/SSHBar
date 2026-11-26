// Checking GitHub for a newer release. Shared by the desktop app (main process) and Android (web view).

export const RELEASES_REPO = 'sshbar/SSHBar'
/** Download page for the newest stable release. */
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`
/** GitHub's "latest release" skips drafts and pre-releases, so beta tags never prompt anyone. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

export interface UpdateInfo {
  /** version of the running app */
  current: string
  /** newest published release */
  latest: string
  /** release page to download it from */
  url: string
  /** `latest` is newer than `current` (always false for development builds) */
  available: boolean
  /** not a release build (run from source, or a CI test build): never prompts to update */
  dev: boolean
}

interface Version {
  core: [number, number, number]
  pre: string[]
}

/** Parse "1.2.3", "v1.2.3" or "1.2.3-beta.1" (build metadata after "+" is ignored). */
export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semantic-version order: negative when a < b, 0 when equal (or either is unparsable), positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  // a release is newer than its own pre-releases (1.0.0 > 1.0.0-beta.1)
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1 // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/** Versions CI gives builds that aren't releases ("Run workflow" test builds default to 0.0.0-dev). */
export function isDevVersion(v: string): boolean {
  return /^0\.0\.0(?:[-+]|$)/.test(v.trim())
}

/** Read GitHub's release JSON. Anything unexpected yields null rather than a bogus version or link. */
export function releaseFromJson(json: unknown): { version: string; url: string } | null {
  if (!json || typeof json !== 'object') return null
  const r = json as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : ''
  if (!parseVersion(tag)) return null
  // only ever send people to this project's own release pages
  const html = typeof r.html_url === 'string' ? r.html_url : ''
  const url = html.startsWith(`https://github.com/${RELEASES_REPO}/releases/`) ? html : RELEASES_PAGE
  return { version: tag.replace(/^v/, ''), url }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/** Ask GitHub for the newest release and compare it with `current`. Throws when offline or rate-limited. */
export async function checkForUpdate(current: string, fetchFn: FetchFn, opts: { dev?: boolean } = {}): Promise<UpdateInfo> {
  const res = await fetchFn(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
    // older Android WebViews lack AbortSignal.timeout
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`.trim())
  const rel = releaseFromJson(await res.json())
  if (!rel) throw new Error('GitHub did not return a release')
  const dev = Boolean(opts.dev) || isDevVersion(current) || !parseVersion(current)
  return { current, latest: rel.version, url: rel.url, available: !dev && compareVersions(rel.version, current) > 0, dev }
}
