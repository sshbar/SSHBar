// Tiny Chrome DevTools Protocol client for the app's WebView on an emulator/device (debug builds).
//   import { connectWebView } from './android-cdp.mjs'
//   const page = await connectWebView('com.nicuorlov.sshbar.dev') // debug builds use the .dev app id
//   await page.eval('document.title')
import { execFileSync } from 'node:child_process'

const ADB = process.env.ADB || `${process.env.ANDROID_HOME || `${process.env.HOME}/Android/Sdk`}/platform-tools/adb`
export const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' })

export async function connectWebView(pkg, port = 9333) {
  const pid = adb('shell', 'pidof', pkg).trim()
  if (!pid) throw new Error(`${pkg} is not running`)
  adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
  let targets = []
  for (let i = 0; i < 50 && !targets.some((t) => t.type === 'page'); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    } catch {
      /* not ready */
    }
    if (!targets.some((t) => t.type === 'page')) await new Promise((r) => setTimeout(r, 200))
  }
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('No WebView page found')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let seq = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg)
      waiting.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      waiting.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const page = {
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
      return r.result?.result?.value
    },
    async waitFor(expression, ms = 15000) {
      const t = Date.now()
      while (!(await page.eval(`!!(${expression})`))) {
        if (Date.now() - t > ms) throw new Error(`timeout waiting for ${expression}`)
        await new Promise((r) => setTimeout(r, 200))
      }
    },
    insertText: (text) => send('Input.insertText', { text }),
    _send: send,
    close: () => ws.close()
  }
  return page
}

export function screenshot(file) {
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  return import('node:fs').then((fs) => fs.writeFileSync(file, png))
}
