import { useState } from 'react'
import type { JobBlocker } from '../../shared/discovery'
import { clean } from './controls'

/**
 * Answer a blocker right where it is shown, under its job. A consent approval is for that company and that exact wording only;
 * an answer is saved like any other and applies wherever the question is asked. Saving re-checks the queue so autopilot can pick the job up.
 */
export function BlockerInput({ b, company, changed }: { b: JobBlocker; company: string; changed: () => void }) {
  const question = b.question ?? b.label.replace(/^(Consent\/agreement needs your approval|Answer needed): /, '')
  const opts = b.options ?? []
  const [v, setV] = useState(opts.length === 1 ? opts[0] : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async (): Promise<void> => {
    setBusy(true); setErr('')
    try { await window.api.resolveApproval({ kind: b.kind as 'consent' | 'answer', company: b.company ?? company, question, value: v }); changed() } catch (e) { setErr(clean(e)); setBusy(false) }
  }
  return (
    <div className="row" style={{ marginTop: 4 }}>
      {opts.length > 0
        ? <select value={v} onChange={(e) => setV(e.target.value)}><option value="">{b.kind === 'consent' ? 'Choose to approve…' : 'Choose an answer…'}</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : <input value={v} placeholder="your answer" onChange={(e) => setV(e.target.value)} />}
      <button disabled={!v || busy} onClick={save} title={b.kind === 'consent' ? 'You have read this wording and approve it for this company only' : 'Saved as an answer for this and similar questions'}>
        {busy ? 'Saving…' : b.kind === 'consent' ? 'Approve for this company' : 'Save answer'}
      </button>
      {err && <small className="error">{err}</small>}
    </div>
  )
}
