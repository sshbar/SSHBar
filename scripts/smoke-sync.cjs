// Two-"device" smoke test of the encrypted sync file through the real app.
//   DEVICE=a SYNC_FILE=/tmp/x/sshbuddy-sync.json electron --ozone-platform=headless scripts/smoke-sync.cjs   (seeded, creates the file)
//   DEVICE=b SYNC_FILE=/tmp/x/sshbuddy-sync.json electron --ozone-platform=headless scripts/smoke-sync.cjs   (empty, opens it)
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const device = process.env.DEVICE || 'a'
const file = process.env.SYNC_FILE
const out = process.env.SMOKE_OUT || os.tmpdir()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sshbuddy-sync-${device}-`))
const now = Date.now()
if (device === 'a') {
  const auth = { method: 'password', password: { source: 'prompt' }, key: { source: 'file', path: '' }, passphrase: { source: 'prompt' }, agent: 'system', agentSocket: '' }
  const h = (id, label, hostname, group) => ({ id, label, group, hostname, port: 22, username: 'ops', auth, jumpHostId: '', tags: [], notes: '', createdAt: now, updatedAt: now })
  fs.writeFileSync(path.join(dataDir, 'hosts.json'), JSON.stringify({ version: 1, deleted: {}, hosts: [h('a1', 'nas', 'nas.example.net', 'Home'), h('a2', 'plex', '192.0.2.10', 'Home'), h('a3', 'vps', 'vps.example.net', 'Cloud')] }))
}
process.env.SSHBUDDY_DATA_DIR = dataDir
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const shot = async (name) => fs.writeFileSync(path.join(out, `${device}-${name}.png`), (await win.webContents.capturePage()).toPNG())
    try {
      win.setSize(1400, 860)
      await sleep(800)
      const res = await js(`window.sshbuddy.fileSync.enable(${JSON.stringify({ path: file, password: 'smoke test passphrase', includeSecrets: true, rememberPassword: true, create: device === 'a' })})`)
      if (!res.ok) throw new Error('enable failed: ' + res.message)
      console.log(`[sync-${device}]`, res.message, `pulled=${res.pulled} pushed=${res.pushed}`)
      await sleep(600)
      const labels = await js(`[...document.querySelectorAll('.host-label')].map(e => e.textContent).sort().join(',')`)
      console.log(`[sync-${device}] hosts in UI: ${labels}`)
      if (labels !== 'nas,plex,vps') throw new Error('unexpected hosts: ' + labels)
      await shot('hosts')
      await js(`document.querySelectorAll('.rail-btn')[1].click()`)
      await sleep(800)
      await js(`[...document.querySelectorAll('.settings-section h2')].find(h => /Encrypted sync file/.test(h.textContent)).scrollIntoView()`)
      await sleep(200)
      await shot('settings')
      console.log(`[sync-${device}] OK`)
    } catch (e) {
      console.log(`[sync-${device}] FAILED`, e.message)
      await shot('error').catch(() => {})
      process.exitCode = 1
    } finally {
      setTimeout(() => app.exit(process.exitCode || 0), 200)
    }
  })
})
require('../out/main/index.js')
