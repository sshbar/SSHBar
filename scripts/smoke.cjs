// Headless smoke test: launches the built app, connects to a test server and screenshots each view.
//   npx electron-vite build
//   SMOKE_KEY=/path/to/id_plain SMOKE_PORT=2222 npx electron --ozone-platform=headless scripts/smoke.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const out = process.env.SMOKE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sshbar-smoke-'))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshbar-data-'))
const now = Date.now()
const host = (id, label, group, extra) => ({
  id, label, group, hostname: '127.0.0.1', port: Number(process.env.SMOKE_PORT || 2222), username: 'tester',
  auth: { method: 'key', password: { source: 'prompt' }, key: { source: 'file', path: process.env.SMOKE_KEY }, passphrase: { source: 'prompt' }, agent: 'system', agentSocket: '' },
  tags: [], notes: '', createdAt: now, updatedAt: now, ...extra
})
fs.writeFileSync(path.join(dataDir, 'hosts.json'), JSON.stringify({
  version: 1, deleted: {},
  hosts: [
    host('h-test', 'docker-test', 'Lab', { tags: ['docker'] }),
    host('h-web', 'web-prod-1', 'Production', { hostname: 'web1.example.com', port: 22, username: 'deploy', auth: { method: 'password', password: { source: 'protonpass', shareId: 's', itemId: 'i', title: 'web1 deploy' }, key: { source: 'file', path: '' }, passphrase: { source: 'prompt' }, agent: 'system', agentSocket: '' } }),
    host('h-db', 'db-primary', 'Production', { hostname: '10.0.4.12', username: 'postgres', auth: { method: 'agent', password: { source: 'prompt' }, key: { source: 'file', path: '' }, passphrase: { source: 'prompt' }, agent: 'protonpass', agentSocket: '' }, tags: ['postgres'] }),
    host('h-pi', 'raspberry-pi', '', { hostname: 'pi.local', username: 'pi', port: 22 }),
    host('h-nouser', 'no-user', 'Lab', { username: '' }),
    host('h-private', 'private-target', 'Lab', { hostname: 'sb-target', port: 2222, jumpHostId: 'h-test' })
  ]
}))
fs.writeFileSync(path.join(dataDir, 'snippets.json'), JSON.stringify({
  version: 1, deleted: {},
  snippets: [
    { id: 's1', name: 'Who am I', command: 'echo SNIPPET-$(whoami)-OK', createdAt: now, updatedAt: now },
    { id: 's2', name: 'Disk usage by folder', command: 'du -h --max-depth=1 ~ | sort -h', createdAt: now, updatedAt: now },
    { id: 's3', name: 'Follow syslog', command: 'sudo journalctl -f', createdAt: now, updatedAt: now }
  ]
}))
process.env.SSHBAR_DATA_DIR = dataDir

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[smoke]', ...a)

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const shot = async (name) => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(out, name + '.png'), img.toPNG())
      log('saved', name)
    }
    const waitFor = async (expr, ms = 10000) => {
      const t = Date.now()
      while (!(await js(`!!(${expr})`))) {
        if (Date.now() - t > ms) throw new Error('timeout waiting for ' + expr)
        await sleep(100)
      }
    }
    try {
      win.setSize(1400, 860)
      await waitFor(`document.querySelector('.host-card')`)
      await sleep(300)
      await shot('1-hosts')

      await js(`document.querySelector('.host-card .btn.primary').click()`)
      await waitFor(`document.querySelector('.modal')`)
      await sleep(200)
      await shot('2-hostkey-prompt')
      await js(`[...document.querySelectorAll('.modal .btn')].find(b => /Trust/.test(b.textContent)).click()`)
      await waitFor(`document.querySelector('.statsbar .sb-label')`, 15000)
      await sleep(400)
      win.webContents.focus()
      for (const ch of 'uname -a && df -h / && ls -la\r') {
        win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      }
      // typed input must reach the remote shell and its output must render
      await waitFor(`/Filesystem/.test(document.querySelector('.xterm-rows')?.textContent || '')`, 10000)
      await sleep(1500)
      await shot('3-terminal')
      const rows = await js(`document.querySelector('.xterm-rows').textContent`)
      const banners = rows.split('Welcome to OpenSSH Server').length - 1
      if (banners !== 1) throw new Error(`login banner rendered ${banners} times (output duplicated)`)
      if (!rows.includes('uname -a && df -h / && ls -la') || rows.includes('uunnaammee')) throw new Error('typed command echoed incorrectly: ' + rows.slice(0, 300))

      await js(`[...document.querySelectorAll('.session-toolbar .segmented button')].find(b => /Files/.test(b.textContent)).click()`)
      await waitFor(`document.querySelectorAll('.file-pane')[1]?.querySelector('.fp-row:not(.fp-header)')`, 10000)
      await sleep(800)
      await shot('4-files')

      await js(`document.querySelectorAll('.rail-btn')[1].click()`)
      await sleep(2500)
      await shot('5-settings')

      // Host without a username: the Username dialog must keep keyboard focus (not the terminal)
      await js(`document.querySelectorAll('.rail-btn')[0].click()`)
      await sleep(200)
      await js(`[...document.querySelectorAll('.host-card')].find(c => c.textContent.includes('no-user')).querySelector('.btn.primary').click()`)
      await waitFor(`[...document.querySelectorAll('.modal .field span')].some(e => e.textContent === 'Username')`)
      await sleep(600) // give any stray focus() a chance to run
      for (const ch of 'tester') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      const val = await js(`document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement.value : 'focus=' + (document.activeElement && document.activeElement.className)`)
      if (val !== 'tester') throw new Error('username keystrokes did not land in the dialog: ' + val)
      await shot('7-username-prompt')
      // a real Enter keypress is keyDown + char + keyUp
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      await waitFor(`document.querySelector('.tab.on .dot-connected')`, 15000)
      await sleep(1500)
      const rows2 = await js(`[...document.querySelectorAll('.session')].find(s => s.style.display !== 'none').querySelector('.xterm-rows').textContent`)
      if (rows2.includes('tester') || (rows2.split('Welcome to OpenSSH Server').length - 1) !== 1) throw new Error('second session output wrong: ' + rows2.slice(0, 200))
      await shot('8-no-user-session')

      if (process.env.SMOKE_JUMP) {
        // private host reachable only through docker-test (bastion): two host-key prompts, then a shell on sb-target
        await js(`document.querySelectorAll('.rail-btn')[0].click()`)
        await sleep(200)
        await js(`[...document.querySelectorAll('.host-card')].find(c => c.textContent.includes('private-target')).querySelector('.btn.primary').click()`)
        // trust whatever host keys are still unknown (the bastion's was accepted earlier) until connected
        const t0 = Date.now()
        let trusted = 0
        while (!(await js(`!!document.querySelector('.tab.on .dot-connected')`))) {
          if (Date.now() - t0 > 20000) throw new Error('jump connection did not complete')
          if (await js(`[...document.querySelectorAll('.modal .btn')].some(b => /Trust/.test(b.textContent))`)) {
            await js(`[...document.querySelectorAll('.modal .btn')].find(b => /Trust/.test(b.textContent)).click()`)
            trusted++
          }
          await sleep(150)
        }
        if (trusted !== 1) throw new Error(`expected exactly one new host key (sb-target), got ${trusted}`)
        await sleep(300)
        for (const ch of 'echo JUMPED-TO-$(hostname)\r') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
        await waitFor(`[...document.querySelectorAll('.session')].find(s => s.style.display !== 'none').querySelector('.xterm-rows').textContent.includes('JUMPED-TO-sb-target')`, 10000)
        await waitFor(`/sb-target/.test(document.querySelector('.statsbar')?.textContent || '')`, 10000)
        await shot('9-jump-session')
      }

      // Port forwarding through the UI: local forward to the server's own sshd, then use it
      await js(`document.querySelector('.tab:not(.tab-home)').click()`)
      await sleep(200)
      const visibleSession = `[...document.querySelectorAll('.session')].find(s => s.style.display !== 'none')`
      await js(`[...${visibleSession}.querySelectorAll('.session-toolbar .segmented button')].find(b => /Ports/.test(b.textContent)).click()`)
      await waitFor(`[...document.querySelectorAll('.ports .btn')].some(b => /New forward/.test(b.textContent))`)
      await js(`[...document.querySelectorAll('.ports .btn')].find(b => /New forward/.test(b.textContent)).click()`)
      await js(`(() => {
        const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
        const [bindAddr, bindPort, destHost, destPort, label] = document.querySelectorAll('.fwd-form input:not([type=checkbox])')
        set(bindPort, '0'); set(destHost, '127.0.0.1'); set(destPort, '2222'); set(label, 'sshd via tunnel')
      })()`)
      await sleep(100)
      await js(`[...document.querySelectorAll('.fwd-form .btn')].find(b => /Add forward/.test(b.textContent)).click()`)
      await waitFor(`/Active/.test(document.querySelector('.fwd-row')?.textContent || '')`, 10000)
      const desc = await js(`document.querySelector('.fwd-row .mono').textContent`)
      const boundPort = Number(/127\.0\.0\.1:(\d+)/.exec(desc)[1])
      const banner = await new Promise((resolve, reject) => {
        const sock = require('node:net').connect(boundPort, '127.0.0.1')
        sock.once('data', (d) => { resolve(d.toString().trim()); sock.destroy() })
        sock.once('error', reject)
        setTimeout(() => reject(new Error('no banner through the forward')), 5000)
      })
      if (!/^SSH-2\.0-/.test(banner)) throw new Error('unexpected data through the forward: ' + banner)
      log('forward', desc, '->', banner)
      await sleep(400)
      await shot('10-ports')

      await js(`[...${visibleSession}.querySelectorAll('.session-toolbar .segmented button')].find(b => /Terminal/.test(b.textContent)).click()`)

      // Snippet palette via the real keyboard shortcut, then run a snippet
      await sleep(400)
      win.webContents.focus()
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control', 'shift'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control', 'shift'] })
      await waitFor(`document.querySelector('.palette')`, 5000)
      for (const ch of 'who') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(300)
      await shot('11-snippet-palette')
      const items = await js(`document.querySelectorAll('.palette-item').length`)
      if (items !== 1) throw new Error('palette filter shows ' + items + ' items')
      await js(`document.querySelector('.palette-item.on .btn.primary').click()`)
      await waitFor(`${visibleSession}.querySelector('.xterm-rows').textContent.includes('SNIPPET-tester-OK')`, 8000)

      // Find in scrollback (Ctrl+Shift+F)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control', 'shift'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control', 'shift'] })
      await waitFor(`document.querySelector('.term-search input')`, 5000)
      await sleep(100)
      for (const ch of 'SNIPPET-tester') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(400)
      const searchOk = await js(`(() => { const i = document.querySelector('.term-search input'); return i.value === 'SNIPPET-tester' && !i.classList.contains('nomatch') })()`)
      if (!searchOk) throw new Error('terminal search did not find the text')
      await shot('12-terminal-search')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      await sleep(200)

      await js(`[...document.querySelectorAll('.rail-btn')].find(b => /Snippets/.test(b.textContent)).click()`)
      await sleep(400)
      await shot('13-snippets')
      await js(`document.querySelectorAll('.rail-btn')[0].click()`)
      await js(`document.querySelector('.btn.primary').click()`) // New host
      await waitFor(`document.querySelector('.modal')`)
      await js(`[...document.querySelectorAll('.modal .segmented button')].find(b => /SSH key/.test(b.textContent)).click()`)
      await sleep(300)
      await shot('6-host-editor')
      log('OK', out)
    } catch (e) {
      log('FAILED', e.message)
      await shot('error').catch(() => {})
      process.exitCode = 1
    } finally {
      setTimeout(() => app.exit(process.exitCode || 0), 200)
    }
  })
})

require('../out/main/index.js')
