import type { SSHBuddyApi } from '../../shared/api'

declare global {
  interface Window {
    sshbuddy: SSHBuddyApi
  }
}

export const api: SSHBuddyApi = window.sshbuddy
