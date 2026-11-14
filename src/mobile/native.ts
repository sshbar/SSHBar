// Typed access to the app's native Android module (android/app/src/main/java/.../SshBridgePlugin.java).
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface HostKeyInfo {
  keyType: string
  /** SHA256:... like OpenSSH */
  fingerprint: string
  /** base64 of the SSH wire-format public key */
  key: string
}

export interface AuthResult {
  ok: boolean
  /** methods the server still accepts after a failure */
  allowed: string[]
  partial: boolean
}

export interface KbdPromptEvent {
  id: string
  requestId: string
  name: string
  instruction: string
  prompt: string
  echo: boolean
}

export interface SmbTarget {
  host: string
  port: number
  share: string
  username: string
  password: string
}

export interface SshBridgePlugin {
  appInfo(): Promise<{ version: string }>
  readText(o: { name: string }): Promise<{ data: string | null }>
  writeText(o: { name: string; data: string }): Promise<void>
  /** Values encrypted with a key held in the Android Keystore */
  secureGet(o: { key: string }): Promise<{ value: string | null }>
  secureSet(o: { key: string; value: string }): Promise<void>
  secureRemove(o: { key: string }): Promise<void>
  clipboardRead(): Promise<{ text: string }>
  clipboardWrite(o: { text: string }): Promise<void>
  openUrl(o: { url: string }): Promise<void>

  /** Android document picker; keeps read/write permission across restarts */
  pickDocument(o: { mode: 'open' | 'create'; name?: string }): Promise<{ uri: string | null; name?: string }>
  readUri(o: { uri: string }): Promise<{ data: string | null }>
  writeUri(o: { uri: string; data: string }): Promise<void>
  scrypt(o: { password: string; salt: string; N: number; r: number; p: number; dkLen: number }): Promise<{ key: string }>

  /** Files on an SMB share (NAS); paths are inside the share. smbRead gives null for a missing file. */
  smbList(o: SmbTarget & { path: string }): Promise<{ entries: { name: string; dir: boolean; size: number; modified: number }[] }>
  smbRead(o: SmbTarget & { path: string }): Promise<{ data: string | null }>
  smbWrite(o: SmbTarget & { path: string; data: string }): Promise<void>

  /** TCP (or tunnel via viaId) + key exchange. Nothing is authenticated yet; the caller verifies the host key. */
  sshOpen(o: { id: string; host: string; port: number; viaId?: string }): Promise<HostKeyInfo>
  sshAuthPassword(o: { id: string; username: string; password: string }): Promise<AuthResult>
  sshAuthKey(o: { id: string; username: string; privateKey: string; passphrase?: string }): Promise<AuthResult>
  sshAuthKeyboard(o: { id: string; username: string }): Promise<AuthResult>
  sshKeyboardRespond(o: { requestId: string; answer: string | null }): Promise<void>
  /** Inspect a private key: is it valid, does it need a passphrase (and does the given one work)? */
  sshKeyInfo(o: { privateKey: string; passphrase?: string }): Promise<{ valid: boolean; needsPassphrase: boolean; error?: string }>
  sshShell(o: { id: string; cols: number; rows: number }): Promise<void>
  sshWrite(o: { id: string; data: string }): Promise<void>
  sshResize(o: { id: string; cols: number; rows: number }): Promise<void>
  sshExec(o: { id: string; execId: string; command: string }): Promise<void>
  sshExecClose(o: { id: string; execId: string }): Promise<void>
  sshClose(o: { id: string }): Promise<void>

  addListener(event: 'data', cb: (e: { id: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'closed', cb: (e: { id: string; reason: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'execData', cb: (e: { id: string; execId: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'execClosed', cb: (e: { id: string; execId: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'kbdPrompt', cb: (e: KbdPromptEvent) => void): Promise<PluginListenerHandle>
}

export const Native = registerPlugin<SshBridgePlugin>('SshBridge')

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function nativeError(e: unknown): Error & { code?: string } {
  const err = e as { message?: string; code?: string }
  const out = new Error(err?.message ?? String(e)) as Error & { code?: string }
  out.code = err?.code
  return out
}
