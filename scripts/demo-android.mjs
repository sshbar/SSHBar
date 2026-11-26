// Android screenshots for the README, from a debug build on an emulator (or a phone) with USB debugging.
//   scripts/demo-servers.sh && npm run android:apk && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
//   node scripts/demo-android.mjs      (writes docs/media/android.png; ffmpeg joins the two screens)
//
// Wipes the debug app's data first, then adds demo hosts and snippets through the app's own API. The
// emulator reaches this computer as 10.0.2.2 (set DEMO_ANDROID_HOST for a phone on the same network).
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adb, connectWebView, screenshot } from './android-cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.DEMO_OUT || join(ROOT, 'docs', 'media')
const PKG = 'com.nicuorlov.sshbar.dev'
const SERVER = process.env.DEMO_ANDROID_HOST || '10.0.2.2'
const PORT = Number(process.env.SSHBAR_DEMO_PORT || 22)
const KEY = readFileSync(process.env.DEMO_KEY || join(ROOT, 'test', '.data', 'demo', 'id_demo'), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[demo-android]', ...a)
mkdirSync(OUT, { recursive: true })

adb('shell', 'pm', 'clear', PKG)
adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
await sleep(2500)
const page = await connectWebView(PKG)
await page.waitFor(`window.sshbar && document.querySelector('.rail, .app')`, 30000)

const auth = (o = {}) => ({
  method: 'key', password: { source: 'prompt' }, key: { source: 'local' }, passphrase: { source: 'prompt' },
  agent: 'system', agentSocket: '', ...o
})
const host = (label, group, o) => ({
  label, group, hostname: '', port: 22, username: 'deploy', auth: auth(), jumpHostId: '', forwards: [], tags: [], notes: '', ...o
})
const ids = await page.eval(`(async () => {
  const api = window.sshbar
  await api.settings.update({ statsIntervalSec: 1, checkForUpdates: false })
  const save = (h) => api.hosts.save(h)
  const bastion = await save(${JSON.stringify(host('bastion', 'Staging', { hostname: SERVER, port: PORT, tags: ['jump'] }))})
  const app1 = await save({ ...${JSON.stringify(host('app-1', 'Staging', { hostname: 'app-1', port: 2222, tags: ['docker'] }))}, jumpHostId: bastion.id })
  await save(${JSON.stringify(host('web-1', 'Production', { hostname: 'web-1.example.com', auth: auth({ method: 'password', password: { source: 'local' } }), tags: ['nginx'] }))})
  await save(${JSON.stringify(host('db-primary', 'Production', { hostname: '10.0.4.12', username: 'postgres', auth: auth({ method: 'password' }), tags: ['postgres'] }))})
  await save(${JSON.stringify(host('raspberry-pi', 'Home lab', { hostname: 'pi.local', username: 'pi' }))})
  for (const id of [bastion.id, app1.id]) await api.secrets.set(id, 'key', ${JSON.stringify(KEY)})
  for (const [name, command] of [
    ['Update package lists', 'sudo apt update'],
    ['Upgrade packages', 'sudo apt upgrade -y'],
    ['Restart nginx', 'sudo systemctl restart nginx'],
    ['Follow app logs', 'docker compose logs -f --tail=100']
  ]) await api.snippets.save({ name, command })
  return { bastion: bastion.id, app1: app1.id }
})()`)
log('hosts added', ids)
await page.waitFor(`[...document.querySelectorAll('.host-card')].length >= 5`)
await sleep(1200)
const hostsShot = join(OUT, 'android-hosts.png')
await screenshot(hostsShot)
log('saved android-hosts.png')

// connect to app-1 through the bastion, trusting both host keys
await page.eval(`[...document.querySelectorAll('.host-card')].find(c => c.querySelector('.host-label')?.textContent === 'app-1').querySelector('.btn.primary').click()`)
const t0 = Date.now()
while (!(await page.eval(`!!document.querySelector('.statsbar .sb-label, .tab.on .dot-connected')`))) {
  if (Date.now() - t0 > 40000) throw new Error('app-1 did not connect')
  if (await page.eval(`[...document.querySelectorAll('.modal .btn')].some(b => /Trust/.test(b.textContent))`)) {
    await page.eval(`[...document.querySelectorAll('.modal .btn')].find(b => /Trust/.test(b.textContent)).click()`)
  }
  await sleep(250)
}
await page.waitFor(`/deploy@app-1/.test(document.querySelector('.xterm-rows')?.textContent || '')`, 20000)
await sleep(800)

// type like a person would: through Android's input (soft or hardware keyboard), not into the page
// (adb runs this through the phone's shell: keep the text free of shell operators)
const type = (text) => adb('shell', 'input', 'text', text.replace(/ /g, '%s'))
const enter = () => adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER')
await page.eval(`document.querySelector('.xterm-helper-textarea').focus()`)
await sleep(600)
type('cd apps/shop')
enter()
await sleep(700)
type('ls')
enter()
await sleep(1500)
type('sudo apt up')
await page.waitFor(`document.querySelectorAll('.suggest-item').length >= 2`, 10000)
await sleep(1200)
const termShot = join(OUT, 'android-terminal.png')
await screenshot(termShot)
log('saved android-terminal.png')
page.close()

// both screens side by side, phone-sized for the README
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', hostsShot, '-i', termShot, '-filter_complex',
  '[0]scale=540:-1[a];[1]scale=540:-1[b];[a]pad=iw+24:ih:0:0:color=0x0f1218[a2];[a2][b]hstack', join(OUT, 'android.png')])
log('saved android.png')
for (const f of [hostsShot, termShot]) rmSync(f)
