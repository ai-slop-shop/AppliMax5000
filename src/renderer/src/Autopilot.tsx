import { useEffect, useState } from 'react'
import type { AutopilotSettings, AutopilotStatus } from '../../shared/discovery'
import { clean } from './controls'

const TAG: Record<string, string> = { submitted: 'SENT', dry_run: 'REHEARSED', needs_you: 'NEEDS YOU', skipped: 'SKIPPED' }

/** Unattended applying: pick the best job per company over a score threshold and send it, within safety limits. */
export function Autopilot() {
  const [st, setSt] = useState<AutopilotStatus | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const load = (): void => { window.api.autopilotStatus().then(setSt) }
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [])
  if (!st) return <p>Loading…</p>
  const s = st.settings
  const save = async (next: AutopilotSettings): Promise<void> => setSt(await window.api.setAutopilot(next))
  const run = async (): Promise<void> => {
    setBusy(true); setMsg('')
    try { const r = await window.api.runAutopilot(); setSt(r.status); setMsg(`${r.submitted} submitted, ${r.dryRuns} rehearsed, ${r.needsYou} need you. ${r.summary}`) } catch (e) { setMsg(clean(e)) }
    setBusy(false)
  }
  const running = busy || st.running

  return (
    <>
      <div className="row">
        <label><input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} /> <b>Autopilot on</b> (runs after every scheduled discovery run, while the app is open)</label>
      </div>
      <label className="row"><span>Apply when fit score is at least</span><input type="number" min={0} max={100} value={s.threshold} onChange={(e) => save({ ...s, threshold: Number(e.target.value) })} /></label>
      <label className="row"><span>Most applications per day</span><input type="number" min={1} max={50} value={s.dailyCap} onChange={(e) => save({ ...s, dailyCap: Number(e.target.value) })} /></label>
      <div className="row">
        <label><input type="checkbox" checked={s.dryRun} onChange={(e) => save({ ...s, dryRun: e.target.checked })} /> <b>Rehearse only</b>: fill and verify every form but never press Submit. Turn this off when the rehearsals look right.</label>
      </div>
      <div className="row">
        <label><input type="checkbox" checked={s.requireCleanClaims} onChange={(e) => save({ ...s, requireCleanClaims: e.target.checked })} /> Only send when every claim in the tailored resume and cover letter is backed by a confirmed fact</label>
      </div>
      <p><small>
        How a pass works: it re-checks which jobs are blocked, then for each company takes the highest-scoring open job at or above the threshold, drafts and fills it, verifies every field, and submits it. Only one application goes to any company; once it is sent, that company's other roles leave the queue.
        If the best job cannot go through unattended (an essay, a consent box, an unanswered or guessed answer, a failed check, a CAPTCHA), it is listed below and the next best job at that company is tried.
        It never creates accounts, solves CAPTCHAs, ticks consent boxes or submits over a verification problem. If an outcome is uncertain it stops and leaves the browser window open.
      </small></p>
      <div className="bar">
        <button disabled={running} onClick={run}>{running ? 'Running…' : s.dryRun ? 'Rehearse now' : 'Run autopilot now'}</button>
        <button disabled={running} onClick={async () => setSt(await window.api.releaseHolds())} title="Jobs that needed you are not retried for a day. This lets autopilot try them again.">Try held jobs again</button>
        <span className="status">{running ? st.phase || 'Working…' : `${st.today} of ${s.dailyCap} sent today`}</span>
      </div>
      {msg && <p className="status">{msg}</p>}
      <h3>Activity</h3>
      {st.log.length === 0 && <p>Nothing yet. Run discovery, then a pass.</p>}
      {st.log.map((e, i) => (
        <div key={i} className={`job ${e.outcome === 'needs_you' ? 'needs_user' : e.outcome === 'submitted' ? 'submitted' : ''}`}>
          <div className="fit">{e.score ?? '–'}</div>
          <div className="body">
            <div><b>{e.title}</b> · {e.company} <span className="applied-tag">{TAG[e.outcome]}</span></div>
            <small>{new Date(e.at).toLocaleString()} · {e.note}</small>
          </div>
        </div>
      ))}
    </>
  )
}
