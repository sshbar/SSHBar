import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { SSHBuddyApi, Unsubscribe } from '../shared/api'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api: SSHBuddyApi = {
  platform: process.platform,

  hosts: {
    list: () => invoke('hosts:list'),
    save: (h) => invoke('hosts:save', h),
    remove: (id) => invoke('hosts:remove', id),
    duplicate: (id) => invoke('hosts:duplicate', id),
    importSshConfig: () => invoke('hosts:importSshConfig'),
    exportJson: () => invoke('hosts:exportJson'),
    importJson: () => invoke('hosts:importJson'),
    onChanged: (cb) => on('hosts:changed', cb)
  },

  secrets: {
    backend: () => invoke('secrets:backend'),
    set: (hostId, kind, value) => invoke('secrets:set', hostId, kind, value),
    has: (hostId) => invoke('secrets:has', hostId),
    remove: (hostId, kind) => invoke('secrets:remove', hostId, kind)
  },

  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    onChanged: (cb) => on('settings:changed', cb)
  },

  knownHosts: {
    list: () => invoke('knownHosts:list'),
    remove: (hostKey) => invoke('knownHosts:remove', hostKey)
  },

  protonPass: {
    status: () => invoke('pp:status'),
    vaults: () => invoke('pp:vaults'),
    items: (shareId, type) => invoke('pp:items', shareId, type),
    agentStatus: () => invoke('pp:agentStatus'),
    agentStart: (shareId) => invoke('pp:agentStart', shareId),
    agentStop: () => invoke('pp:agentStop'),
    sync: () => invoke('pp:sync')
  },

  fileSync: {
    status: () => invoke('fileSync:status'),
    choosePath: (mode) => invoke('fileSync:choosePath', mode),
    enable: (opts) => invoke('fileSync:enable', opts),
    unlock: (password, remember) => invoke('fileSync:unlock', password, remember),
    disable: () => invoke('fileSync:disable'),
    syncNow: () => invoke('fileSync:syncNow'),
    changePassword: (pw) => invoke('fileSync:changePassword', pw),
    setIncludeSecrets: (v) => invoke('fileSync:setIncludeSecrets', v),
    onStatus: (cb) => on('fileSync:status', cb)
  },

  ssh: {
    open: (hostId, cols, rows) => invoke('ssh:open', hostId, cols, rows),
    write: (id, data) => ipcRenderer.send('ssh:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
    close: (id) => invoke('ssh:close', id),
    listForwards: (id) => invoke('fwd:list', id),
    startForward: (id, f) => invoke('fwd:start', id, f),
    stopForward: (id, fid) => invoke('fwd:stop', id, fid),
    onEvent: (cb) => on('ssh:event', cb)
  },

  prompts: {
    onRequest: (cb) => on('prompt:request', cb),
    onCancel: (cb) => on('prompt:cancel', cb),
    respond: (id, res) => ipcRenderer.send('prompt:respond', id, res)
  },

  sftp: {
    home: (id) => invoke('sftp:home', id),
    list: (id, path) => invoke('sftp:list', id, path),
    mkdir: (id, path) => invoke('sftp:mkdir', id, path),
    rename: (id, from, to) => invoke('sftp:rename', id, from, to),
    remove: (id, paths) => invoke('sftp:remove', id, paths),
    download: (id, remotePaths, localDir) => invoke('sftp:download', id, remotePaths, localDir),
    upload: (id, localPaths, remoteDir) => invoke('sftp:upload', id, localPaths, remoteDir),
    cancelTransfer: (tid) => invoke('sftp:cancelTransfer', tid),
    clearTransfers: (id) => invoke('sftp:clearTransfers', id),
    onTransfer: (cb) => on('transfer:update', cb)
  },

  local: {
    roots: () => invoke('local:roots'),
    list: (path) => invoke('local:list', path),
    mkdir: (path) => invoke('local:mkdir', path),
    rename: (from, to) => invoke('local:rename', from, to),
    trash: (paths) => invoke('local:trash', paths),
    open: (path) => invoke('local:open', path),
    join: (dir, name) => invoke('local:join', dir, name)
  },

  dialog: {
    pickKeyFile: () => invoke('dialog:pickKeyFile')
  },

  clipboard: {
    read: () => invoke('clipboard:read'),
    write: (text) => invoke('clipboard:write', text)
  },

  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => invoke('shell:openExternal', url)
}

contextBridge.exposeInMainWorld('sshbuddy', api)
