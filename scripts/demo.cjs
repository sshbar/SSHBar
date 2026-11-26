// README screenshots and animations, made by driving the real app against the demo servers.
//   scripts/demo-servers.sh          (Docker: "bastion" on 127.0.0.1:22 and "app-1" behind it)
//   npm run demo                     (writes docs/media/*.png and *.gif; the GIFs need ffmpeg)
//   scripts/demo-servers.sh stop
//
// Only demo data is shown: a fresh data folder with made-up hosts and snippets, and "this computer"
// is a demo home folder. Your own hosts, keys, ~/.ssh and files never appear. bastion.example.com is
// resolved to the local demo container inside this process only.
const { app } = require('electron')
const { execFileSync, spawn } = require('node:child_process')
const dns = require('node:dns')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = process.env.DEMO_OUT || path.join(ROOT, 'docs', 'media')
const KEY = process.env.DEMO_KEY || path.join(ROOT, 'test', '.data', 'demo', 'id_demo')
const WORK = path.join(ROOT, 'test', '.data', 'demo', 'run')
const HOME = path.join(WORK, 'home') // shown as "This computer" in the file manager
const DATA = path.join(WORK, 'data')
const W = 1280
const H = 800

if (!fs.existsSync(KEY)) {
  console.error(`[demo] no demo key at ${KEY}: run scripts/demo-servers.sh first`)
  process.exit(1)
}

// ----- demo world ----------------------------------------------------------------------------------
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(HOME, 'shop-release', 'img'), { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
// a release to upload: big enough that the transfer queue shows progress
fs.writeFileSync(path.join(HOME, 'shop-release', 'bundle.js'), Buffer.alloc(48 * 1024 * 1024, 'x'))
fs.writeFileSync(path.join(HOME, 'shop-release', 'promo.mp4'), Buffer.alloc(96 * 1024 * 1024, 1))
for (const f of ['hero.jpg', 'logo.png', 'banner.webp']) fs.writeFileSync(path.join(HOME, 'shop-release', 'img', f), Buffer.alloc(900 * 1024, 2))
fs.writeFileSync(path.join(HOME, 'shop-release', 'index.html'), '<!doctype html><title>Shop</title>\n')
fs.writeFileSync(path.join(HOME, 'release-notes.md'), '# Shop 2.4\n\n- faster checkout\n')
fs.mkdirSync(path.join(HOME, 'Documents'))
fs.mkdirSync(path.join(HOME, 'Downloads'))
fs.mkdirSync(path.join(HOME, '.ssh'))

const now = Date.now()
const auth = (o) => ({
  method: 'key',
  password: { source: 'prompt' },
  key: { source: 'file', path: KEY },
  passphrase: { source: 'prompt' },
  agent: 'system',
  agentSocket: '',
  ...o
})
const host = (id, label, group, o) => ({
  id, label, group, hostname: '', port: 22, username: 'deploy', auth: auth(), jumpHostId: '', forwards: [],
  tags: [], notes: '', createdAt: now, updatedAt: now, ...o
})
const pass = (title) => ({ method: 'password', password: { source: 'protonpass', shareId: 'demo', itemId: title, title } })
const fwd = (id, type, label, bindPort, destHost = '', destPort = 0) => ({ id, type, label, bindAddress: '127.0.0.1', bindPort, destHost, destPort, autoStart: true })
fs.writeFileSync(path.join(DATA, 'hosts.json'), JSON.stringify({
  version: 1, deleted: {},
  hosts: [
    host('h-bastion', 'bastion', 'Staging', { hostname: 'bastion.example.com', tags: ['jump'] }),
    host('h-app', 'app-1', 'Staging', {
      hostname: 'app-1', port: 2222, jumpHostId: 'h-bastion', tags: ['docker'],
      forwards: [
        fwd('f1', 'local', 'Shop (nginx)', 18080, 'localhost', 8080),
        fwd('f2', 'local', 'Postgres', 15432, 'db.internal', 5432),
        fwd('f3', 'dynamic', 'SOCKS proxy', 1080)
      ]
    }),
    host('h-web1', 'web-1', 'Production', { hostname: 'web-1.example.com', auth: auth(pass('web-1 deploy')), tags: ['nginx'] }),
    host('h-web2', 'web-2', 'Production', { hostname: 'web-2.example.com', auth: auth(pass('web-2 deploy')), tags: ['nginx'] }),
    host('h-db', 'db-primary', 'Production', { hostname: '10.0.4.12', username: 'postgres', auth: auth({ method: 'agent', agent: 'protonpass' }), tags: ['postgres'] }),
    host('h-pi', 'raspberry-pi', 'Home lab', { hostname: 'pi.local', username: 'pi', auth: auth({ key: { source: 'file', path: '~/.ssh/id_ed25519' } }) }),
    host('h-nas', 'nas', 'Home lab', { hostname: 'nas.local', username: 'admin', port: 2222, auth: auth({ method: 'password' }), tags: ['backups'] })
  ]
}))
const snip = (id, name, command) => ({ id, name, command, createdAt: now, updatedAt: now })
fs.writeFileSync(path.join(DATA, 'snippets.json'), JSON.stringify({
  version: 1, deleted: {},
  snippets: [
    snip('s1', 'Update package lists', 'sudo apt update'),
    snip('s2', 'Upgrade packages', 'sudo apt upgrade -y'),
    snip('s3', 'Restart nginx', 'sudo systemctl restart nginx'),
    snip('s4', 'Start the stack', 'docker compose up -d'),
    snip('s5', 'Follow app logs', 'docker compose logs -f --tail=100'),
    snip('s6', 'Disk usage by folder', 'du -h --max-depth=1 . | sort -h'),
    snip('s7', 'Listening ports', 'sudo ss -tlnp')
  ]
}))
// stats every second (livelier graphs); a Proton Pass CLI that can't exist, so no account ever shows
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ statsIntervalSec: 1, protonPassCli: 'pass-cli-demo-unavailable', checkForUpdates: false }))

process.env.SSHBAR_DATA_DIR = DATA
process.env.HOME = HOME
process.env.USERPROFILE = HOME // os.homedir() on Windows

const realLookup = dns.lookup
dns.lookup = function (hostname, options, cb) {
  if (typeof options === 'function') [cb, options] = [options, {}]
  if (hostname === 'bastion.example.com') {
    const all = typeof options === 'object' && options?.all
    return process.nextTick(() => (all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)))
  }
  return realLookup.call(this, hostname, options, cb)
}

// ----- helpers -------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[demo]', ...a)

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', () => void run(win))
})

async function run(win) {
  const wc = win.webContents
  const js = (code) => wc.executeJavaScript(code)
  const waitFor = async (expr, ms = 15000) => {
    const t = Date.now()
    while (!(await js(`!!(${expr})`))) {
      if (Date.now() - t > ms) throw new Error('timeout waiting for ' + expr)
      await sleep(80)
    }
  }
  let scale = 1
  const shot = async (name, rect) => {
    const img = await wc.capturePage(rect)
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG())
    log('saved', name + '.png', img.getSize())
  }
  const typeText = async (text, cps = 14) => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(1000 / cps)
    }
  }
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(60)
  }
  const enter = async () => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(80)
  }
  const visibleSession = `[...document.querySelectorAll('.session')].find(s => s.style.display !== 'none')`
  const termText = () => js(`${visibleSession}?.querySelector('.xterm-rows')?.textContent || ''`)
  const card = (label) => `[...document.querySelectorAll('.host-card')].find(c => c.querySelector('.host-label')?.textContent === ${JSON.stringify(label)})`
  const goHosts = () => js(`[...document.querySelectorAll('.rail-btn')].find(b => /Hosts/.test(b.textContent)).click()`)
  const sessionTab = (name) => js(`[...${visibleSession}.querySelectorAll('.session-toolbar .segmented button')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`)
  const trustUntilConnected = async (label) => {
    const t0 = Date.now()
    while (!(await js(`!!document.querySelector('.tab.on .dot-connected')`))) {
      if (Date.now() - t0 > 30000) throw new Error(`${label} did not connect`)
      if (await js(`[...document.querySelectorAll('.modal .btn')].some(b => /Trust/.test(b.textContent))`)) {
        await sleep(900) // let the host-key dialog be seen in recordings
        await js(`[...document.querySelectorAll('.modal .btn')].find(b => /Trust/.test(b.textContent)).click()`)
      }
      await sleep(120)
    }
  }

  // Records frames while `fn` runs, then encodes a GIF with ffmpeg. crop = CSS pixels {x, y, width, height}.
  const record = async (name, fn, { crop, width = 960, hold = 1800 } = {}) => {
    const frames = []
    let on = true
    const loop = (async () => {
      while (on) {
        const t = Date.now()
        frames.push({ t, png: (await wc.capturePage(crop)).toPNG() })
        await sleep(Math.max(0, 70 - (Date.now() - t)))
      }
    })()
    await fn()
    await sleep(hold)
    on = false
    await loop
    if (!ffmpegAvailable()) return log(`skipped ${name}.gif: ffmpeg not found`)
    const dir = path.join(WORK, 'frames-' + name)
    fs.mkdirSync(dir, { recursive: true })
    const list = []
    frames.forEach((f, i) => {
      const file = `f${String(i).padStart(4, '0')}.png`
      fs.writeFileSync(path.join(dir, file), f.png)
      const next = frames[i + 1]
      list.push(`file '${file}'`, `duration ${((next ? next.t - f.t : 1000) / 1000).toFixed(3)}`)
    })
    list.push(`file 'f${String(frames.length - 1).padStart(4, '0')}.png'`)
    fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'))
    const vf = `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', vf, '-loop', '0', path.join(OUT, name + '.gif')], { cwd: dir })
    log('saved', name + '.gif', `${frames.length} frames`, `${(fs.statSync(path.join(OUT, name + '.gif')).size / 1e6).toFixed(1)} MB`)
  }

  try {
    win.setContentSize(W, H)
    win.center()
    await waitFor(`document.querySelector('.host-card')`)
    await sleep(500)
    scale = (await wc.capturePage()).getSize().width / W
    log('device scale', scale)

    // 1. host list
    await shot('hosts')

    // 2. the bastion first (its key gets trusted), then app-1 through it, recorded
    await js(`${card('bastion')}.querySelector('.btn.primary').click()`)
    await trustUntilConnected('bastion')
    await sleep(800)
    await goHosts()
    await sleep(600)
    await record('jump-host', async () => {
      await sleep(900)
      await js(`${card('app-1')}.querySelector('.btn.primary').click()`)
      await trustUntilConnected('app-1')
      await waitFor(`/deploy@app-1/.test(${visibleSession}?.querySelector('.xterm-rows')?.textContent || '')`)
      await sleep(700)
      wc.focus()
      await typeText('cd apps/shop && ls\r')
      await sleep(1800)
    })

    // 3. hero: htop in a live session, the stats bar graphing real work on the server (compressing
    // the database backup over and over, with pauses, so the CPU graph has some shape)
    let loadOn = true
    const gzip = () => {
      if (!loadOn) return
      spawn('docker', ['exec', '-u', 'deploy', 'sshbar-demo-app', 'gzip', '-9c', '/config/backups/db-2026-11-25.sql.gz'], { stdio: 'ignore' })
        .on('exit', () => setTimeout(gzip, 600 + Math.random() * 1200))
    }
    gzip()
    let hasHtop = true
    try {
      execFileSync('docker', ['exec', 'sshbar-demo-app', 'which', 'htop'], { stdio: 'ignore' })
    } catch {
      hasHtop = false
    }
    await key('L', ['control'])
    await typeText(hasHtop ? 'htop\r' : 'ls -lh && tail -n 6 logs/access.log\r', 40)
    await sleep(20000) // a minute's worth of graph would be nicer, 20 s gives it some shape
    // take it while the compression is on screen, not in one of its pauses
    if (hasHtop) {
      await waitFor(`/gzip -9c/.test(${visibleSession}?.querySelector('.xterm-rows')?.textContent || '')`, 20000).catch(() => {})
      await sleep(1300) // htop refreshes every 1.5 s: let the CPU bars catch up
    }
    await shot('hero')
    loadOn = false
    if (hasHtop) {
      await typeText('q', 40)
      await sleep(400)
    }

    // 4. snippet suggestions while typing
    await key('L', ['control'])
    await sleep(400)
    await record(
      'snippet-suggestions',
      async () => {
        await sleep(600)
        await typeText('sudo apt up', 7)
        await sleep(1400)
        await key('Down')
        await sleep(700)
        await key('Down')
        await sleep(700)
        await key('Up')
        await sleep(700)
        await enter() // fills in, does not run
        await sleep(600)
      },
      { crop: { x: 68, y: 88, width: 760, height: 260 }, width: 760, hold: 2200 }
    )
    await key('C', ['control'])
    await sleep(300)

    // 5. file manager: upload a folder, recorded (the servers outlive a run: remove the last upload)
    execFileSync('docker', ['exec', 'sshbar-demo-app', 'rm', '-rf', '/config/shop-release'])
    await sessionTab('Files')
    await waitFor(`document.querySelectorAll('.file-pane')[1]?.querySelector('.fp-row:not(.fp-header)')`)
    await sleep(900)
    const localRow = `[...document.querySelectorAll('.file-pane')[0].querySelectorAll('.fp-row')].find(r => r.textContent.includes('shop-release'))`
    await record('file-transfer', async () => {
      await sleep(800)
      await js(`${localRow}.click()`)
      await sleep(700)
      await js(`[...document.querySelectorAll('.file-pane')[0].querySelectorAll('.btn.primary')].find(b => /Upload/.test(b.textContent)).click()`)
      await waitFor(`[...document.querySelectorAll('.file-pane')[1].querySelectorAll('.fp-row')].some(r => r.textContent.includes('shop-release'))`, 60000)
      await sleep(600)
    }, { hold: 2000 })
    await shot('files')

    // 6. port forwards (saved on the host, started on connect)
    await sessionTab('Ports')
    await waitFor(`(document.querySelectorAll('.fwd-row') || []).length >= 3`)
    await sleep(800)
    await shot('ports')

    // 7. snippet palette
    await sessionTab('Terminal')
    await sleep(400)
    wc.focus()
    await key('L', ['control'])
    await sleep(300)
    await key('S', ['control', 'shift'])
    await waitFor(`document.querySelector('.palette')`)
    await typeText('docker', 20)
    await sleep(500)
    await shot('snippet-palette')
    await key('Escape')
    await sleep(300)

    // 8. host editor with Proton Pass
    await goHosts()
    await sleep(400)
    await js(`${card('web-1')}.querySelector('[title="Edit"]').click()`)
    await waitFor(`document.querySelector('.modal')`)
    await sleep(800)
    await shot('host-editor')

    log('done', OUT)
  } catch (e) {
    log('FAILED', e.stack || e.message)
    await shot('demo-error').catch(() => {})
    process.exitCode = 1
  } finally {
    setTimeout(() => app.exit(process.exitCode || 0), 300)
  }
}

require('../out/main/index.js')
