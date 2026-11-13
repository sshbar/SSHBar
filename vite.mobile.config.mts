// Web build for the Android app (Capacitor). Reuses the desktop renderer with a native-backed API.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('./src/mobile'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@renderer': r('./src/renderer/src') } },
  build: { outDir: r('./out/mobile'), emptyOutDir: true, target: 'es2022' }
})
