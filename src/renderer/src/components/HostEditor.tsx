import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { FolderOpen, KeyRound, Lock, Plug, Plus, Trash } from 'lucide-react'
import type { CredentialRef, HostInput, KeyRef, SecretBackendInfo, SecretKind } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { errorText } from '../format'
import { Modal } from './Modal'
import { ForwardForm, ForwardPill } from './Forwards'
import { describeForward } from '../../../shared/forwards'
import { ProtonPassPicker } from './ProtonPassPicker'

type CredSource = CredentialRef['source']
type KeySource = KeyRef['source']

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string; icon?: ReactElement; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={value === o.value ? 'on' : ''}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function HostEditor({ initial }: { initial: HostInput }) {
  const close = (): void => useStore.getState().openEditor(null)
  const toast = useStore((s) => s.toast)
  const hosts = useStore((s) => s.hosts)
  const [h, setH] = useState<HostInput>(() => structuredClone(initial))
  const [password, setPassword] = useState('')
  const [keyText, setKeyText] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [has, setHas] = useState<Record<SecretKind, boolean>>({ password: false, key: false, passphrase: false })
  const [backend, setBackend] = useState<SecretBackendInfo | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [tagText, setTagText] = useState(initial.tags.join(', '))
  const [addingForward, setAddingForward] = useState(false)

  useEffect(() => {
    void api.secrets.backend().then(setBackend)
    if (initial.id) void api.secrets.has(initial.id).then(setHas)
  }, [initial.id])

  const groups = useMemo(() => [...new Set(hosts.map((x) => x.group).filter(Boolean))].sort(), [hosts])
  // Hosts usable as a jump host: not this host, and not one that (indirectly) jumps through this host.
  const jumpCandidates = useMemo(() => {
    const byId = new Map(hosts.map((x) => [x.id, x]))
    const reachesSelf = (start: string): boolean => {
      const seen = new Set<string>()
      for (let cur = byId.get(start); cur && !seen.has(cur.id); cur = byId.get(cur.jumpHostId)) {
        if (cur.id === initial.id) return true
        seen.add(cur.id)
      }
      return false
    }
    return hosts.filter((x) => x.id !== initial.id && !(initial.id && reachesSelf(x.id))).sort((a, b) => a.label.localeCompare(b.label))
  }, [hosts, initial.id])
  const localOk = backend?.available ?? false
  const localTitle = localOk ? `Encrypted with ${backend?.backend}` : `Unavailable: ${backend?.reason ?? ''}`

  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setH((p) => ({ ...p, [k]: v }))
  const setAuth = <K extends keyof HostInput['auth']>(k: K, v: HostInput['auth'][K]): void =>
    setH((p) => ({ ...p, auth: { ...p.auth, [k]: v } }))

  const credSource = (ref: CredentialRef, kind: SecretKind, onChange: (r: CredentialRef) => void, promptLabel: string) => (
    <Segmented<CredSource>
      value={ref.source}
      onChange={(v) => {
        if (v === 'protonpass') onChange({ source: 'protonpass', shareId: '', itemId: '' })
        else onChange({ source: v })
      }}
      options={[
        { value: 'prompt', label: promptLabel },
        { value: 'local', label: has[kind] ? 'Saved on device ✓' : 'Save on this device', disabled: !localOk, title: localTitle },
        { value: 'protonpass', label: 'Proton Pass' }
      ]}
    />
  )

  const validate = (): string | null => {
    if (!h.hostname.trim()) return 'Hostname is required'
    const a = h.auth
    if (a.method === 'password') {
      if (a.password.source === 'local' && !password && !has.password) return 'Enter the password to save on this device'
      if (a.password.source === 'protonpass' && !a.password.itemId) return 'Choose a Proton Pass login item'
    }
    if (a.method === 'key') {
      if (a.key.source === 'file' && !a.key.path.trim()) return 'Choose a private key file'
      if (a.key.source === 'local' && !keyText.trim() && !has.key) return 'Paste the private key to save on this device'
      if (a.key.source === 'protonpass' && !a.key.itemId) return 'Choose a Proton Pass SSH key item'
      if (a.passphrase.source === 'protonpass' && !a.passphrase.itemId) return 'Choose the Proton Pass item holding the passphrase'
    }
    if (a.method === 'agent' && a.agent === 'custom' && !a.agentSocket.trim()) return 'Enter the agent socket path'
    return null
  }

  const save = async (connectAfter: boolean): Promise<void> => {
    const err = validate()
    if (err) return setError(err)
    setSaving(true)
    setError('')
    try {
      const tags = tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const saved = await api.hosts.save({ ...h, tags })
      const a = saved.auth
      const want: Record<SecretKind, boolean> = {
        password: a.method === 'password' && a.password.source === 'local',
        key: a.method === 'key' && a.key.source === 'local',
        passphrase: a.method === 'key' && a.passphrase.source === 'local'
      }
      if (want.password && password) await api.secrets.set(saved.id, 'password', password)
      if (want.key && keyText.trim()) await api.secrets.set(saved.id, 'key', keyText.trim() + '\n')
      if (want.passphrase && passphrase) await api.secrets.set(saved.id, 'passphrase', passphrase)
      // drop secrets that are no longer used, so nothing lingers on disk
      for (const k of ['password', 'key', 'passphrase'] as SecretKind[]) {
        if (!want[k] && has[k]) await api.secrets.remove(saved.id, k)
      }
      close()
      toast('success', `Saved ${saved.label}`)
      if (connectAfter) void useStore.getState().connect(saved.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const a = h.auth

  return (
    <Modal
      title={initial.id ? `Edit ${initial.label || initial.hostname}` : 'New host'}
      onClose={close}
      width={640}
      footer={
        <>
          {error && <div className="form-error grow">{error}</div>}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn" onClick={() => void save(false)} disabled={saving}>
            Save
          </button>
          <button className="btn primary" onClick={() => void save(true)} disabled={saving}>
            Save & connect
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          void save(false)
        }}
      >
        <div className="grid-2">
          <label className="field span-2">
            <span>Hostname or IP</span>
            <input autoFocus value={h.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="server.example.com" />
          </label>
          <label className="field">
            <span>Label</span>
            <input value={h.label} onChange={(e) => set('label', e.target.value)} placeholder={h.hostname || 'My server'} />
          </label>
          <label className="field">
            <span>Group</span>
            <input list="groups" value={h.group} onChange={(e) => set('group', e.target.value)} placeholder="e.g. Production" />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Username</span>
            <input value={h.username} onChange={(e) => set('username', e.target.value)} placeholder="root" autoCapitalize="off" />
          </label>
          <label className="field">
            <span>Port</span>
            <input type="number" min={1} max={65535} value={h.port} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
          <label className="field span-2">
            <span>Jump host (ProxyJump)</span>
            <select value={h.jumpHostId} onChange={(e) => set('jumpHostId', e.target.value)}>
              <option value="">None — connect directly</option>
              {jumpCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.username ? c.username + '@' : ''}
                  {c.hostname})
                </option>
              ))}
              {h.jumpHostId && !hosts.some((x) => x.id === h.jumpHostId) && <option value={h.jumpHostId}>(missing host)</option>}
            </select>
          </label>
        </div>

        <div className="field">
          <span>Authentication</span>
          <Segmented
            value={a.method}
            onChange={(v) => setAuth('method', v)}
            options={[
              { value: 'password', label: 'Password', icon: <Lock size={14} /> },
              { value: 'key', label: 'SSH key', icon: <KeyRound size={14} /> },
              { value: 'agent', label: 'SSH agent', icon: <Plug size={14} /> }
            ]}
          />
        </div>

        {a.method === 'password' && (
          <div className="auth-box">
            <div className="field">
              <span>Password</span>
              {credSource(a.password, 'password', (r) => setAuth('password', r), 'Ask every time')}
            </div>
            {a.password.source === 'local' && (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={has.password ? '•••••••• (saved — type to replace)' : 'Password'}
                autoComplete="new-password"
              />
            )}
            {a.password.source === 'protonpass' && (
              <ProtonPassPicker
                type="login"
                value={a.password.itemId ? a.password : null}
                onChange={(r) => setAuth('password', { source: 'protonpass', ...r })}
              />
            )}
            {a.password.source === 'prompt' && <p className="muted small">You will be asked for the password on each connection.</p>}
          </div>
        )}

        {a.method === 'key' && (
          <div className="auth-box">
            <div className="field">
              <span>Private key</span>
              <Segmented<KeySource>
                value={a.key.source}
                onChange={(v) => {
                  if (v === 'file') setAuth('key', { source: 'file', path: '' })
                  else if (v === 'local') setAuth('key', { source: 'local' })
                  else setAuth('key', { source: 'protonpass', shareId: '', itemId: '' })
                }}
                options={[
                  { value: 'file', label: 'Key file' },
                  { value: 'local', label: has.key ? 'Saved on device ✓' : 'Paste & save', disabled: !localOk, title: localTitle },
                  { value: 'protonpass', label: 'Proton Pass' }
                ]}
              />
            </div>
            {a.key.source === 'file' && (
              <div className="row gap">
                <input
                  className="grow mono"
                  value={a.key.path}
                  onChange={(e) => setAuth('key', { source: 'file', path: e.target.value })}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const p = await api.dialog.pickKeyFile()
                    if (p) setAuth('key', { source: 'file', path: p })
                  }}
                >
                  <FolderOpen size={14} /> Browse
                </button>
              </div>
            )}
            {a.key.source === 'local' && (
              <textarea
                className="mono"
                rows={5}
                value={keyText}
                onChange={(e) => setKeyText(e.target.value)}
                placeholder={has.key ? 'A key is saved — paste a new one to replace it' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                spellCheck={false}
              />
            )}
            {a.key.source === 'protonpass' && (
              <>
                <ProtonPassPicker
                  type="ssh-key"
                  value={a.key.itemId ? a.key : null}
                  onChange={(r) => setAuth('key', { source: 'protonpass', ...r })}
                />
                <p className="muted small">
                  The key is fetched from Proton Pass when you connect and kept in memory only. A custom field named “passphrase” on the item is used
                  automatically.
                </p>
              </>
            )}

            <div className="field">
              <span>Passphrase (encrypted keys only)</span>
              {credSource(a.passphrase, 'passphrase', (r) => setAuth('passphrase', r), 'Ask if needed')}
            </div>
            {a.passphrase.source === 'local' && (
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={has.passphrase ? '•••••••• (saved — type to replace)' : 'Passphrase'}
                autoComplete="new-password"
              />
            )}
            {a.passphrase.source === 'protonpass' && (
              <ProtonPassPicker
                type="login"
                value={a.passphrase.itemId ? a.passphrase : null}
                onChange={(r) => setAuth('passphrase', { source: 'protonpass', ...r })}
              />
            )}
          </div>
        )}

        {a.method === 'agent' && (
          <div className="auth-box">
            <Segmented
              value={a.agent}
              onChange={(v) => setAuth('agent', v)}
              options={[
                { value: 'system', label: 'System agent' },
                { value: 'protonpass', label: 'Proton Pass agent' },
                { value: 'custom', label: 'Custom socket' }
              ]}
            />
            {a.agent === 'system' && (
              <p className="muted small">Uses the agent from SSH_AUTH_SOCK (or the Windows OpenSSH agent / Pageant).</p>
            )}
            {a.agent === 'protonpass' && (
              <p className="muted small">
                Uses the SSH keys stored in Proton Pass through <code>pass-cli ssh-agent</code>. SSHBuddy starts the agent daemon if it isn’t
                running.
              </p>
            )}
            {a.agent === 'custom' && (
              <input
                className="mono"
                value={a.agentSocket}
                onChange={(e) => setAuth('agentSocket', e.target.value)}
                placeholder={api.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent or pageant' : '/path/to/agent.sock'}
              />
            )}
          </div>
        )}

        <div className="field">
          <span>Port forwarding</span>
          {h.forwards.length > 0 && (
            <div className="fwd-list compact">
              {h.forwards.map((f) => (
                <div key={f.id} className="fwd-row">
                  <ForwardPill type={f.type} />
                  <div className="fwd-info">
                    <div>
                      {f.label && <b>{f.label} </b>}
                      <span className="mono small">{describeForward(f)}</span>
                    </div>
                  </div>
                  <label className="check inline small">
                    <input
                      type="checkbox"
                      checked={f.autoStart}
                      onChange={(e) => set('forwards', h.forwards.map((x) => (x.id === f.id ? { ...x, autoStart: e.target.checked } : x)))}
                    />
                    auto
                  </label>
                  <button type="button" className="icon-btn danger" title="Remove" onClick={() => set('forwards', h.forwards.filter((x) => x.id !== f.id))}>
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {addingForward ? (
            <ForwardForm
              onAdd={(f) => {
                set('forwards', [...h.forwards, f])
                setAddingForward(false)
              }}
              onCancel={() => setAddingForward(false)}
            />
          ) : (
            <div>
              <button type="button" className="btn sm" onClick={() => setAddingForward(true)}>
                <Plus size={13} /> Add port forward
              </button>
            </div>
          )}
        </div>

        <div className="grid-2">
          <label className="field span-2">
            <span>Tags (comma separated)</span>
            <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="web, eu-west" />
          </label>
          <label className="field span-2">
            <span>Notes</span>
            <textarea rows={2} value={h.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
