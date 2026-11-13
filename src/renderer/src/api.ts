import type { SSHbarApi } from '../../shared/api'

declare global {
  interface Window {
    sshbar: SSHbarApi
  }
}

export const api: SSHbarApi = window.sshbar
