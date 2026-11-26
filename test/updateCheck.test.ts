import { describe, expect, it } from 'vitest'
import { LATEST_RELEASE_API, RELEASES_PAGE, checkForUpdate, compareVersions, isDevVersion, parseVersion, releaseFromJson } from '../src/shared/updateCheck'
import { sanitizeSettings } from '../src/shared/settingsModel'

const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v0.2.2',
  html_url: 'https://github.com/sshbar/SSHBar/releases/tag/v0.2.2',
  draft: false,
  prerelease: false,
  ...over
})

function fakeFetch(body: unknown, status = 200): { fetch: (url: string, init: RequestInit) => Promise<Response>; urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: async (url) => {
      urls.push(url)
      return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Forbidden' })
    }
  }
}

describe('compareVersions', () => {
  it('orders by major, minor, patch numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.2.2', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('v0.2.2', '0.2.2')).toBe(0)
  })

  it('puts a release after its pre-releases', () => {
    expect(compareVersions('0.3.0', '0.3.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('0.3.0-alpha', '0.3.0-beta')).toBeLessThan(0)
    expect(compareVersions('0.3.0-beta', '0.3.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('0.3.0-1', '0.3.0-rc')).toBeLessThan(0)
  })

  it('ignores build metadata and treats garbage as equal', () => {
    expect(compareVersions('1.0.0+abc', '1.0.0')).toBe(0)
    expect(compareVersions('latest', '1.0.0')).toBe(0)
    expect(parseVersion('1.2')).toBeNull()
  })
})

describe('isDevVersion', () => {
  it('recognises CI test-build versions only', () => {
    expect(isDevVersion('0.0.0-dev')).toBe(true)
    expect(isDevVersion('0.0.0')).toBe(true)
    expect(isDevVersion('0.0.1')).toBe(false)
    expect(isDevVersion('0.2.2')).toBe(false)
  })
})

describe('releaseFromJson', () => {
  it('reads the version and the release page', () => {
    expect(releaseFromJson(release())).toEqual({ version: '0.2.2', url: 'https://github.com/sshbar/SSHBar/releases/tag/v0.2.2' })
  })

  it('never links outside the project releases', () => {
    expect(releaseFromJson(release({ html_url: 'https://evil.example/releases/' }))?.url).toBe(RELEASES_PAGE)
    expect(releaseFromJson(release({ html_url: 'https://github.com/someone-else/SSHBar/releases/tag/v9' }))?.url).toBe(RELEASES_PAGE)
    expect(releaseFromJson(release({ html_url: undefined }))?.url).toBe(RELEASES_PAGE)
  })

  it('rejects drafts, pre-releases and odd tags', () => {
    expect(releaseFromJson(release({ draft: true }))).toBeNull()
    expect(releaseFromJson(release({ prerelease: true }))).toBeNull()
    expect(releaseFromJson(release({ tag_name: 'nightly' }))).toBeNull()
    expect(releaseFromJson({ message: 'Not Found' })).toBeNull()
    expect(releaseFromJson(null)).toBeNull()
  })
})

describe('checkForUpdate', () => {
  it('reports a newer release', async () => {
    const f = fakeFetch(release({ tag_name: 'v0.3.0', html_url: 'https://github.com/sshbar/SSHBar/releases/tag/v0.3.0' }))
    const info = await checkForUpdate('0.2.2', f.fetch)
    expect(f.urls).toEqual([LATEST_RELEASE_API])
    expect(info).toEqual({ current: '0.2.2', latest: '0.3.0', url: 'https://github.com/sshbar/SSHBar/releases/tag/v0.3.0', available: true, dev: false })
  })

  it('stays quiet when up to date or ahead', async () => {
    expect((await checkForUpdate('0.2.2', fakeFetch(release()).fetch)).available).toBe(false)
    expect((await checkForUpdate('0.3.0-beta.1', fakeFetch(release()).fetch)).available).toBe(false)
  })

  it('offers the release to someone on its pre-release', async () => {
    expect((await checkForUpdate('0.2.2-beta.1', fakeFetch(release()).fetch)).available).toBe(true)
  })

  it('never prompts development builds', async () => {
    const dev = await checkForUpdate('0.0.0-dev', fakeFetch(release()).fetch)
    expect(dev).toMatchObject({ available: false, dev: true, latest: '0.2.2' })
    expect(await checkForUpdate('0.1.0', fakeFetch(release()).fetch, { dev: true })).toMatchObject({ available: false, dev: true })
  })

  it('fails on HTTP errors and unusable answers', async () => {
    await expect(checkForUpdate('0.2.2', fakeFetch({ message: 'API rate limit exceeded' }, 403).fetch)).rejects.toThrow(/403/)
    await expect(checkForUpdate('0.2.2', fakeFetch({ message: 'Not Found' }).fetch)).rejects.toThrow(/release/)
  })
})

describe('update settings', () => {
  it('checks by default and keeps a skipped version', () => {
    expect(sanitizeSettings({})).toMatchObject({ checkForUpdates: true, skippedUpdate: '' })
    expect(sanitizeSettings({ checkForUpdates: false, skippedUpdate: '0.3.0' })).toMatchObject({ checkForUpdates: false, skippedUpdate: '0.3.0' })
    expect(sanitizeSettings({ skippedUpdate: 42 as unknown as string }).skippedUpdate).toBe('')
  })
})
