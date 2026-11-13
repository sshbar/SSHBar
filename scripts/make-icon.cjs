// Renders build/icon.svg to build/icon.png (1024x1024, transparent corners).
//   npx electron --ozone-platform=headless scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../build/icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', useContentSize: true })
  win.setContentSize(1024, 1024)
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const out = img.getSize().width === 1024 ? img : img.resize({ width: 1024, height: 1024, quality: 'best' })
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), out.toPNG())
  console.log('wrote build/icon.png', JSON.stringify(img.getSize()))
  app.quit()
})
