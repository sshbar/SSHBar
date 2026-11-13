// Android entry: install the native-backed API before any renderer module reads window.sshbar.
import type { SSHbarApi } from '../shared/api'
import { createMobileApi } from './api'

declare global {
  interface Window {
    sshbar: SSHbarApi
  }
}

window.sshbar = await createMobileApi()
await import('./app')
