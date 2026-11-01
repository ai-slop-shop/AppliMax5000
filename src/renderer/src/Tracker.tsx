import { useEffect, useState } from 'react'
import type { ApplicationRow } from '../../shared/apply'
import type { PastApplication } from '../../main/history'
import { OUTCOMES, type Arm, type Digest, type ExperimentStats, type Outcome } from '../../shared/experiment'

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
const cell = (a: Arm): string => (a.n ? `${a.positive}/${a.n} = ${pct(a.rate)} (${pct(a.lo)}–${pct(a.hi)})` : '–')
const LABEL: Record<Outcome, string> = { no_response: 'No response', screen: 'Screen', interview: 'Interview', rejection: 'Rejection', offer: 'Offer' }

function PastList({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<PastApplication[]>([])
  const [f, setF] = useState({ company: '', title: '', url: '', applied_at: '' })
  const [bulk, setBulk] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => { window.api.listPast().then(setList) }, [])
  const done = (skipped: number, extra = ''): void => { setMsg(`${extra}${skipped ? `${skipped} matching job(s) removed from your queue.` : ''}`.trim()); onChange() }
  return (
    <>
      <h3>Applications I made before ({list.length})</h3>
      <p><small>The app never applies to anything on this list or in the table below, and it also catches the same role reposted under a new job ID. Add what you applied to outside the app.</small></p>
      <div className="row">
        <input placeholder="Company" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
        <input placeholder="Job title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input placeholder="Posting URL (optional)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
        <input placeholder="Date YYYY-MM-DD" style={{ maxWidth: 140 }} value={f.applied_at} onChange={(e) => setF({ ...f, applied_at: e.target.value })} />
        <button disabled={!f.company.trim() && !f.url.trim()} onClick={async () => {
          try { const r = await window.api.addPast(f); setList(r.list); setF({ company: '', title: '', url: '', applied_at: '' }); done(r.skipped) } catch (e) { setMsg(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
        }}>Add</button>
      </div>
      <details><summary>Paste a list</summary>
        <textarea rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'One per line. A posting URL, or:\nCompany | Job title | URL | 2026-09-14\nRiot Games - Technical Artist'} />
        <button disabled={!bulk.trim()} onClick={async () => { const r = await window.api.importPast(bulk); setList(r.list); setBulk(''); done(r.skipped, `Added ${r.added}. `) }}>Import</button>
      </details>
      {msg && <p><small>{msg}</small></p>}
      {list.length > 0 && (
        <table><tbody>{list.map((p) => (
          <tr key={p.id}><td>{p.company}</td><td>{p.title}</td><td><small>{p.url}</small></td><td>{p.applied_at ?? ''}</td>
            <td><button onClick={async () => setList(await window.api.removePast(p.id))}>×</button></td></tr>))}</tbody></table>
      )}
    </>
  )
}

export function Tracker() {
  const [rows, setRows] = useState<ApplicationRow[]>([])
  const [stats, setStats] = useState<ExperimentStats | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [by, setBy] = useState<'ats' | 'fit' | 'role'>('role')
  const load = (): void => { window.api.listApplications().then(setRows); window.api.experimentStats().then(setStats); window.api.getDigest().then(setDigest) }
  useEffect(load, [])

  return (
    <>
      {digest && (
        <div className="issues"><b>Last 7 days</b> <small>(since {digest.since})</small>
          <ul className="tight">{digest.lines.map((l, i) => <li key={i}>{l}</li>)}</ul></div>
      )}

      {stats && (
        <>
          <h3>Does tailoring help?</h3>
          <label className="row">
            <input type="checkbox" checked={stats.settings.enabled} onChange={async (e) => { await window.api.setExperiment({ ...stats.settings, enabled: e.target.checked }); load() }} />
            <span style={{ width: 'auto' }}>Randomly send a plain control (master resume, no cover letter, no tailoring) for</span>
            <input type="number" min={5} max={90} style={{ width: 60, flex: 'none' }} value={Math.round(stats.settings.controlShare * 100)}
              onChange={(e) => setStats({ ...stats, settings: { ...stats.settings, controlShare: Number(e.target.value) / 100 } })}
              onBlur={async () => { await window.api.setExperiment(stats.settings); load() }} /> % of new drafts
          </label>
          <p><small>Assignment is random and blind: you see it only after a draft is created. Off by default; the control share costs you some application strength in exchange for an answer.</small></p>
          <table>
            <thead><tr><th>Group</th><th>Submitted</th><th>Positive response (screen / interview / offer)</th><th>Interviews</th><th>Rejections</th></tr></thead>
            <tbody>
              {(['tailored', 'control'] as const).map((v) => (
                <tr key={v}><td>{v}</td><td>{stats.arms[v].n}</td><td>{cell(stats.arms[v])}</td><td>{stats.arms[v].interviews}</td><td>{stats.arms[v].rejected}</td></tr>))}
            </tbody>
          </table>
          <p><b>{stats.verdict}</b> <small>Intervals are 95% Wilson ranges.{stats.excluded ? ` ${stats.excluded} application(s) left the experiment and are not counted.` : ''}</small></p>

          <div className="bar">
            {(['role', 'ats', 'fit'] as const).map((k) => <button key={k} className={by === k ? 'on' : ''} onClick={() => setBy(k)}>{k === 'role' ? 'By role type' : k === 'ats' ? 'By ATS' : 'By fit score'}</button>)}
            <small>Company size is not available from the job boards.</small>
          </div>
          {stats.breakdowns[by].length === 0 ? <p><small>No submitted applications yet.</small></p> : (
            <table>
              <thead><tr><th></th><th>Tailored</th><th>Control</th></tr></thead>
              <tbody>{stats.breakdowns[by].map((b) => <tr key={b.key}><td>{b.key}</td><td>{cell(b.tailored)}</td><td>{cell(b.control)}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}

      <PastList onChange={load} />
      <h3>Applications made with this app</h3>
      {rows.length === 0 ? <p>No applications logged yet.</p> : (
        <table>
          <thead><tr><th>Company</th><th>Role</th><th>Group</th><th>Status</th><th>Submitted</th><th>Outcome</th><th>Notes</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td>{r.company}</td><td>{r.title}</td><td>{r.variant}</td><td>{r.attempt_status}</td><td>{r.submitted_at ?? ''}</td>
              <td>{r.attempt_status === 'submitted' ? (
                <select value={r.response_status ?? 'no_response'} onChange={async (e) => { await window.api.setOutcome(r.id, e.target.value as Outcome); load() }}>
                  {OUTCOMES.map((o) => <option key={o} value={o}>{LABEL[o]}</option>)}</select>) : ''}</td>
              <td>{r.notes ?? ''}</td></tr>))}</tbody>
        </table>
      )}
    </>
  )
}
