// Renders build/icon.svg to build/icon.png (1024x1024, transparent corners) and the Linux icon set in
// build/icons/ (16x16.png ... 512x512.png).
//   npm run icon
//
// Linux desktops look the icon up in the hicolor theme, whose sizes stop at 512x512: a package that
// only ships a 1024x1024 icon shows the generic one in the menu, dock and taskbar.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512]

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

  const dir = path.join(__dirname, '../build/icons')
  fs.mkdirSync(dir, { recursive: true })
  for (const size of LINUX_SIZES) {
    fs.writeFileSync(path.join(dir, `${size}x${size}.png`), out.resize({ width: size, height: size, quality: 'best' }).toPNG())
  }
  console.log('wrote build/icons/', LINUX_SIZES.map((s) => `${s}x${s}`).join(' '))
  app.quit()
})
