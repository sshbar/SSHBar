import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, Download, LoaderCircle, Play, RefreshCw, Square, Trash, Upload } from 'lucide-react'
import type { KnownHostEntry, PPAgentStatus, PPStatus, PPVault, SecretBackendInfo, Settings } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { dateTime, errorText } from '../format'
import { FileSyncSection } from './FileSyncSection'
import appIcon from '../../../../build/icon.png'

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <div className="ss-head">
        <h2>{title}</h2>
        {desc && <p className="muted">{desc}</p>}
      </div>
      <div className="ss-body">{children}</div>
    </section>
  )
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const toast = useStore((s) => s.toast)
  const [pp, setPp] = useState<PPStatus | null>(null)
  const [ppLoading, setPpLoading] = useState(false)
  const [vaults, setVaults] = useState<PPVault[] | null>(null)
  const [agent, setAgent] = useState<PPAgentStatus | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [backend, setBackend] = useState<SecretBackendInfo | null>(null)
  const [info, setInfo] = useState<{ version: string; electron: string } | null>(null)
  const [known, setKnown] = useState<KnownHostEntry[]>([])
  const [cliPath, setCliPath] = useState(settings?.protonPassCli ?? 'pass-cli')

  const checkPP = async (): Promise<void> => {
    setPpLoading(true)
    try {
      const st = await api.protonPass.status()
      setPp(st)
      if (st.loggedIn) {
        setVaults(await api.protonPass.vaults().catch(() => null))
        setAgent(await api.protonPass.agentStatus())
      }
    } finally {
      setPpLoading(false)
    }
  }

  useEffect(() => {
    void checkPP()
    void api.secrets.backend().then(setBackend)
    void api.knownHosts.list().then(setKnown)
    void api.appInfo().then(setInfo)
  }, [])

  if (!settings) return null
  const s: Settings = settings

  const agentAction = async (fn: () => Promise<PPAgentStatus>): Promise<void> => {
    setAgentBusy(true)
    try {
      setAgent(await fn())
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setAgentBusy(false)
    }
  }

  const syncNow = async (): Promise<void> => {
    setSyncBusy(true)
    try {
      const r = await api.protonPass.sync()
      toast(r.ok ? 'success' : 'error', r.ok ? `${r.message} (↓${r.pulled} ↑${r.pushed})` : r.message)
    } finally {
      setSyncBusy(false)
    }
  }

  return (
    <div className="page settings">
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <Section title="Proton Pass" desc="SSHbar talks to the Proton Pass CLI to fetch passwords and SSH keys on demand. Nothing fetched is written to disk.">
        <div className="row gap wrap">
          <label className="field grow">
            <span>CLI command or path</span>
            <input className="mono" value={cliPath} onChange={(e) => setCliPath(e.target.value)} onBlur={() => cliPath !== s.protonPassCli && update({ protonPassCli: cliPath })} />
          </label>
          <button className="btn self-end" onClick={() => void update({ protonPassCli: cliPath }).then(checkPP)}>
            <RefreshCw size={14} className={ppLoading ? 'spin' : ''} /> Check
          </button>
        </div>
        <div className="status-line">
          {ppLoading && !pp ? (
            <>
              <LoaderCircle className="spin" size={14} /> Checking…
            </>
          ) : pp?.loggedIn ? (
            <>
              <CircleCheck size={15} className="ok-text" /> {pp.version} — signed in{pp.username ? ` as ${pp.username}` : ''}
            </>
          ) : pp?.installed ? (
            <>
              <CircleX size={15} className="warn-text" /> {pp.version} — not signed in. Run <code>pass-cli login</code> in a terminal, then press Check.
            </>
          ) : (
            <>
              <CircleX size={15} className="err-text" /> Proton Pass CLI not found. Install <code>pass-cli</code> (see{' '}
              <a href="#" onClick={() => void api.openExternal('https://proton.me/pass')}>
                proton.me/pass
              </a>
              ) or set its full path above.
            </>
          )}
        </div>

        <h3>SSH agent</h3>
        <p className="muted small">
          Hosts using “Proton Pass agent” authenticate with SSH keys stored in your vaults via <code>pass-cli ssh-agent</code>.
        </p>
        <div className="row gap wrap">
          <label className="field grow">
            <span>Agent socket</span>
            <input
              className="mono"
              placeholder={api.platform === 'win32' ? '\\\\.\\pipe\\proton-pass-agent' : '~/.ssh/proton-pass-agent.sock'}
              defaultValue={s.protonPassAgentSocket}
              onBlur={(e) => e.target.value !== s.protonPassAgentSocket && update({ protonPassAgentSocket: e.target.value })}
            />
          </label>
          <div className="row gap self-end">
            <span className={`pill ${agent?.running ? 'ok' : ''}`}>{agent ? (agent.running ? 'Running' : 'Stopped') : '—'}</span>
            <button className="btn" disabled={agentBusy || !pp?.loggedIn || agent?.running} onClick={() => void agentAction(() => api.protonPass.agentStart())}>
              <Play size={14} /> Start
            </button>
            <button className="btn" disabled={agentBusy || !agent?.running} onClick={() => void agentAction(() => api.protonPass.agentStop())}>
              <Square size={14} /> Stop
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Encrypted sync file"
        desc="The simplest way to share hosts between your computers without a server: one encrypted file in a folder you already sync. Each device works offline and merges changes when the file updates."
      >
        <FileSyncSection />
      </Section>

      <Section
        title="Sync hosts through Proton Pass"
        desc="Keeps your host list in an end-to-end encrypted Proton Pass note (“SSHbar Sync”) so every device sees the same connections. Only host details and references are synced — never passwords or keys saved on this device."
      >
        <label className="check">
          <input
            type="checkbox"
            checked={s.sync.enabled}
            disabled={!s.sync.shareId}
            onChange={(e) => void update({ sync: { ...s.sync, enabled: e.target.checked } })}
          />
          Sync automatically (on start and after changes)
        </label>
        <div className="row gap wrap">
          <label className="field grow">
            <span>Vault</span>
            <select
              value={s.sync.shareId}
              disabled={!vaults}
              onChange={(e) => {
                const v = vaults?.find((x) => x.shareId === e.target.value)
                void update({ sync: { ...s.sync, shareId: e.target.value, vaultName: v?.name ?? '', itemId: '' } })
              }}
            >
              <option value="">{vaults ? 'Choose a vault…' : pp?.loggedIn ? 'Loading…' : 'Sign in to Proton Pass first'}</option>
              {vaults?.map((v) => (
                <option key={v.shareId} value={v.shareId}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn self-end" disabled={!s.sync.shareId || syncBusy} onClick={() => void syncNow()}>
            <RefreshCw size={14} className={syncBusy ? 'spin' : ''} /> Sync now
          </button>
        </div>
        <div className="status-line small">
          {s.sync.lastError ? (
            <span className="err-text">Last sync failed: {s.sync.lastError}</span>
          ) : s.sync.lastSyncAt ? (
            <span className="muted">Last synced {new Date(s.sync.lastSyncAt).toLocaleString()}</span>
          ) : (
            <span className="muted">Not synced yet</span>
          )}
        </div>
      </Section>

      <Section title="Terminal">
        <div className="grid-3">
          <label className="field">
            <span>Font size</span>
            <input type="number" min={8} max={32} value={s.terminalFontSize} onChange={(e) => void update({ terminalFontSize: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Cursor</span>
            <select value={s.terminalCursorStyle} onChange={(e) => void update({ terminalCursorStyle: e.target.value as Settings['terminalCursorStyle'] })}>
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>
          <label className="field">
            <span>Scrollback lines</span>
            <input
              type="number"
              min={500}
              max={200000}
              step={500}
              defaultValue={s.terminalScrollback}
              onBlur={(e) => void update({ terminalScrollback: Number(e.target.value) })}
            />
          </label>
          <label className="field span-3">
            <span>Font family</span>
            <input className="mono" defaultValue={s.terminalFontFamily} onBlur={(e) => void update({ terminalFontFamily: e.target.value })} />
          </label>
        </div>
        <p className="muted small">
          Copy / paste: {api.platform === 'darwin' ? '⌘C / ⌘V' : 'Ctrl+Shift+C / Ctrl+Shift+V'}, or right-click (copies a selection, otherwise pastes).
          Ctrl/⌘-click opens links.
        </p>
      </Section>

      <Section title="Monitoring" desc="The status bar polls CPU, memory, network and disk usage over the existing SSH connection — nothing is installed on the server.">
        <label className="field narrow">
          <span>Refresh every (seconds)</span>
          <input type="number" min={1} max={60} value={s.statsIntervalSec} onChange={(e) => void update({ statsIntervalSec: Number(e.target.value) })} />
        </label>
        <p className="muted small">Applies to new connections.</p>
      </Section>

      <Section title="Security">
        <div className="status-line">
          {backend?.available ? (
            <>
              <CircleCheck size={15} className="ok-text" /> Secrets saved on this device are encrypted with <b>{backend.backend}</b>.
            </>
          ) : (
            <>
              <CircleX size={15} className="warn-text" /> Saving secrets on this device is disabled: {backend?.reason}. Use Proton Pass or “Ask every time”.
            </>
          )}
        </div>
        <h3>Trusted host keys</h3>
        <p className="muted small">Keys you accepted in SSHbar. Keys in ~/.ssh/known_hosts are also honoured (read-only).</p>
        {known.length === 0 ? (
          <p className="muted small">No host keys trusted yet.</p>
        ) : (
          <div className="kh-table">
            {known.map((k) => (
              <div className="kh-row" key={k.hostKey + k.keyType}>
                <span className="mono">{k.hostKey}</span>
                <span className="muted">{k.keyType}</span>
                <code className="fp">{k.fingerprint}</code>
                <span className="muted small">{dateTime(k.addedAt)}</span>
                <button
                  className="icon-btn danger"
                  title="Forget this key"
                  onClick={() => api.knownHosts.remove(k.hostKey).then(() => api.knownHosts.list().then(setKnown))}
                >
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Backup" desc="Export or import your host list as JSON. Exports never include passwords or keys.">
        <div className="row gap">
          <button className="btn" onClick={() => api.hosts.exportJson().then((ok) => ok && toast('success', 'Hosts exported'))}>
            <Download size={14} /> Export hosts
          </button>
          <button
            className="btn"
            onClick={() =>
              api.hosts
                .importJson()
                .then((r) => (r.added || r.skipped) && toast('success', `Imported ${r.added}, skipped ${r.skipped}`))
                .catch((e) => toast('error', errorText(e)))
            }
          >
            <Upload size={14} /> Import hosts
          </button>
        </div>
      </Section>

      <Section title="About">
        <div className="about">
          <img src={appIcon} alt="" width={44} height={44} />
          <div>
            <div>
              <b>SSHbar</b> {info ? `v${info.version}` : ''} <span className="muted small">· MIT license</span>
            </div>
            <div className="muted small">
              Made by Nicolae Orlov ·{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api.openExternal('https://nicuorlov.com'))}>
                nicuorlov.com
              </a>{' '}
              ·{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api.openExternal('mailto:contact@nicuorlov.com'))}>
                contact@nicuorlov.com
              </a>{' '}
              ·{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api.openExternal('https://github.com/sshbar/SSHBar/releases'))}>
                Releases &amp; updates
              </a>
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}
