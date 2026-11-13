import { Fragment, useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, ShieldExclamationPoint } from 'lucide-react'
import type { PromptRequest, PromptResponse } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Modal } from './Modal'

/** Shows host-key confirmations and credential prompts requested by the main process. */
export function PromptDialog() {
  const prompt = useStore((s) => s.prompts[0])
  if (!prompt) return null
  return <PromptView key={prompt.id} prompt={prompt} />
}

function PromptView({ prompt }: { prompt: PromptRequest }) {
  const resolve = useStore((s) => s.resolvePrompt)
  const answer = (res: PromptResponse): void => {
    api.prompts.respond(prompt.id, res)
    resolve(prompt.id)
  }
  if (prompt.kind === 'hostkey') return <HostKeyPrompt prompt={prompt} answer={answer} />
  return <CredentialPrompt prompt={prompt} answer={answer} />
}

function HostKeyPrompt({ prompt, answer }: { prompt: Extract<PromptRequest, { kind: 'hostkey' }>; answer: (r: PromptResponse) => void }) {
  const changed = prompt.state === 'changed'
  const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`
  return (
    <Modal
      title={
        <span className="row gap">
          {changed ? <ShieldExclamationPoint size={18} className="err-text" /> : <ShieldCheck size={18} />}
          {changed ? 'Host key has changed!' : 'Verify host'}
        </span>
      }
      danger={changed}
      onClose={() => answer({ ok: false })}
      width={560}
      footer={
        <>
          <button className="btn" onClick={() => answer({ ok: false })} autoFocus={changed}>
            Cancel
          </button>
          {!changed && (
            <button className="btn" onClick={() => answer({ ok: true, remember: false })}>
              Connect once
            </button>
          )}
          <button className={`btn ${changed ? 'danger' : 'primary'}`} onClick={() => answer({ ok: true, remember: true })} autoFocus={!changed}>
            {changed ? 'Replace key & connect' : 'Trust & connect'}
          </button>
        </>
      }
    >
      {changed ? (
        <p>
          The key presented by <b>{where}</b> does not match the one you trusted before. This can mean the server was reinstalled — or that someone
          is intercepting the connection. Only continue if you know why the key changed.
        </p>
      ) : (
        <p>
          This is the first connection to <b>{where}</b>. Check that the fingerprint matches the server (e.g. <code>ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code>{' '}
          on the server) before trusting it.
        </p>
      )}
      <div className="kv">
        <span>Key type</span>
        <code>{prompt.keyType}</code>
        <span>{changed ? 'New fingerprint' : 'Fingerprint'}</span>
        <code className="fp">{prompt.fingerprint}</code>
        {changed &&
          prompt.knownFingerprints.map((f) => (
            <Fragment key={f}>
              <span>Previously trusted</span>
              <code className="fp muted">{f}</code>
            </Fragment>
          ))}
      </div>
    </Modal>
  )
}

function CredentialPrompt({
  prompt,
  answer
}: {
  prompt: Extract<PromptRequest, { kind: 'credentials' }>
  answer: (r: PromptResponse) => void
}) {
  const [values, setValues] = useState<string[]>(() => prompt.fields.map(() => ''))
  const [remember, setRemember] = useState(false)
  useEffect(() => setValues(prompt.fields.map(() => '')), [prompt])
  return (
    <Modal
      title={
        <span className="row gap">
          <KeyRound size={18} /> {prompt.title}
        </span>
      }
      onClose={() => answer({ ok: false })}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          answer({ ok: true, values, remember })
        }}
      >
        {prompt.message && <p className={/fail|wrong|no |not /i.test(prompt.message) ? 'warn-text' : 'muted'}>{prompt.message}</p>}
        {prompt.fields.map((f, i) => (
          <label className="field" key={i}>
            <span>{f.label}</span>
            <input
              type={f.secret ? 'password' : 'text'}
              autoFocus={i === 0}
              value={values[i] ?? ''}
              autoComplete="off"
              onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
        {prompt.allowRemember && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {prompt.rememberLabel ?? 'Save on this device (encrypted with the OS keychain)'}
          </label>
        )}
        <div className="modal-foot inline">
          <button type="button" className="btn" onClick={() => answer({ ok: false })}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Continue
          </button>
        </div>
      </form>
    </Modal>
  )
}
