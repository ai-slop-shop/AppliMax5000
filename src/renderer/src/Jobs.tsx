import { useEffect, useState } from 'react'
import { clean } from './controls'
import { BlockerInput } from './Approvals'
import type { Board, BoardCandidate, DiscoveryStatus, JobRow, Schedule, SearchResult, SearchSettings, SetupResult } from '../../shared/discovery'

const money = (n: number | null): string => (n == null ? '' : `$${Math.round(n / 1000)}k`)

export function Jobs({ onDraft, onNav }: { onDraft: () => void; onNav: (tab: string) => void }) {
  const [view, setView] = useState<'queue' | 'sources'>('queue')
  const [filter, setFilter] = useState<'active' | 'applied' | 'skipped' | 'all'>('active')
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [st, setSt] = useState<DiscoveryStatus | null>(null)
  const [msg, setMsg] = useState('')

  const reload = (f = filter): void => { window.api.listJobs(f).then(setJobs); window.api.discoveryStatus().then(setSt) }
  useEffect(() => { reload() }, [filter])
  useEffect(() => {
    const a = window.api.on('discovery:phase', (p) => setSt((s) => (s ? { ...s, running: !!p, phase: p } : s)))
    const b = window.api.on('discovery:done', () => reload())
    return () => { a(); b() }
  })

  const run = async (): Promise<void> => {
    setMsg('')
    try { await window.api.runDiscovery(); reload() } catch (e) { setMsg(clean(e)) }
  }

  return (
    <>
      <div className="bar">
        <button disabled={st?.running} onClick={run}>{st?.running ? 'Running…' : 'Run discovery now'}</button>
        <span className="status">{st?.running ? st.phase : st?.last ? `Last run ${st.last.at} UTC: ${st.last.summary}` : 'Not run yet'}</span>
        <span style={{ flex: 1 }} />
        <button className={view === 'queue' ? 'on' : ''} onClick={() => setView('queue')}>Queue</button>
        <button onClick={() => onNav('Criteria')} title="Pay floor, what you are looking for, titles, locations">Criteria →</button>
        <button className={view === 'sources' ? 'on' : ''} onClick={() => setView('sources')}>Employer boards</button>
      </div>
      {msg && <p className="error">{msg}</p>}
      {st?.last?.errors.map((e, i) => <p key={i} className="warn">{e}</p>)}
      {view === 'queue' && <Queue since={st?.last?.started ?? null} jobs={jobs} filter={filter} setFilter={setFilter} reload={() => reload()} onDraft={onDraft} />}
      {view === 'sources' && <Sources />}
    </>
  )
}

function Queue({ since, jobs, filter, setFilter, reload, onDraft }: {
  since: string | null; jobs: JobRow[]; filter: 'active' | 'applied' | 'skipped' | 'all'; setFilter: (f: 'active' | 'applied' | 'skipped' | 'all') => void; reload: () => void; onDraft: () => void
}) {
  const [err, setErr] = useState('')
  const stale = jobs.some((j) => j.blockers.some((b) => (b.kind === 'consent' || b.kind === 'answer') && !b.question)) // saved before answers could be given here
  useEffect(() => { if (stale) window.api.recheckBlockers().then(() => reload()) }, [stale])
  const isNew = (j: JobRow): boolean => !!since && j.status !== 'skipped' && j.status !== 'submitted' && (j.first_seen_at ?? '') >= since // added by the latest discovery run
  const [marking, setMarking] = useState<number | null>(null) // job whose "I applied" date picker is open
  const [when, setWhen] = useState(new Date().toISOString().slice(0, 10))
  const draft = async (id: number): Promise<void> => {
    setErr('')
    try {
      const seed = await window.api.draftSeed(id) // also verifies the posting is still live on the employer's board
      localStorage.setItem('reviewForm', JSON.stringify(seed))
      onDraft()
    } catch (e) { setErr(clean(e)); reload() }
  }
  return (
    <>
      <p className="blurb">Ranked by fit score. Red lines are blockers: an essay, a consent box, or a question you have not answered yet. "Draft application" first checks the posting is still live on the employer's board, then opens it in Review. "I applied" moves a job you applied to elsewhere into the Applied folder and locks it: it can no longer be drafted, and the same role reposted is caught too. Skipped jobs show why they were skipped.</p>
      <div className="row">
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="active">Active</option><option value="applied">Applied</option><option value="skipped">Skipped</option><option value="all">All</option>
        </select>
        <button onClick={async () => { await window.api.recheckBlockers(); reload() }} title="After adding answers or facts, re-check which jobs are still blocked">Recheck blockers</button>
        <span className="status">{jobs.length} job(s)</span>
      </div>
      {err && <p className="error">{err}</p>}
      {jobs.length === 0 && <p>{filter === 'applied' ? 'Nothing in the Applied folder yet. Jobs you submit through the app, or mark with "I applied", appear here.' : 'Nothing here yet. Add employer boards under "Employer boards", set your pay and preferences on the Criteria tab, then run discovery.'}</p>}
      {jobs.map((j) => (
        <div key={j.id} className={`job ${j.status}${isNew(j) ? ' fresh' : ''}`}>
          <div className="fit">{j.fit_score ?? '–'}</div>
          <div className="body">
            <div>{isNew(j) && <span className="new-tag">NEW</span>}<b>{j.title}</b> · {j.company} <small>({j.ats})</small></div>
            <small>{j.location || 'no location'} · {j.work_mode ?? 'mode unknown'} · {j.pay_min ? `${money(j.pay_min)}–${money(j.pay_max)}` : <span className="warn">pay not listed</span>} · {j.status}{j.skip_reason ? ` (${j.skip_reason})` : ''}</small>
            {j.reasons.length > 0 && <ul className="tight">{j.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            {j.stretch_notes && <div className="stretch"><b>Stretch:</b> {j.stretch_notes}</div>}
            {j.blockers.length > 0 && <ul className="tight blockers">{j.blockers.map((b, i) => <li key={i} className={b.kind}>{b.label}{(b.kind === 'consent' || b.kind === 'answer') && <BlockerInput b={b} company={j.company} changed={reload} />}</li>)}</ul>}
          </div>
          <div className="acts">
            {j.status === 'submitted' ? (
              <>
                <span className="applied-tag">APPLIED{j.applied_at ? ` ${j.applied_at}` : ''}</span>
                <small>{j.applied_via === 'app' ? 'sent through this app' : 'marked by you'}</small>
              </>
            ) : j.status !== 'skipped' && (
              marking === j.id ? (
                <div className="markbox">
                  <small>Date applied</small>
                  <input type="date" value={when} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setWhen(e.target.value)} />
                  <button onClick={async () => { await window.api.markJobApplied(j.id, when); setMarking(null); reload() }}>Confirm</button>
                  <button onClick={() => setMarking(null)}>Cancel</button>
                </div>
              ) : (
                <>
                  <button onClick={() => draft(j.id)}>Draft application</button>
                  <button onClick={() => { setWhen(new Date().toISOString().slice(0, 10)); setMarking(j.id) }}>I applied</button>
                </>
              )
            )}
            <button onClick={() => window.api.openExternal(j.url)}>Open posting</button>
            {j.status === 'submitted' && j.applied_via === 'manual' && <button onClick={async () => { try { await window.api.unmarkJobApplied(j.id); reload() } catch (e) { setErr(clean(e)) } }}>Not applied after all</button>}
            {j.status === 'skipped'
              ? <button onClick={async () => { await window.api.restoreJob(j.id); reload() }}>Restore</button>
              : j.status !== 'submitted' && <button onClick={async () => { await window.api.skipJob(j.id, ''); reload() }}>Skip</button>}
          </div>
        </div>
      ))}
    </>
  )
}

function Sources() {
  const [boards, setBoards] = useState<Board[]>([])
  const [sch, setSch] = useState<Schedule | null>(null)
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState('')
  const [setup, setSetup] = useState<SetupResult | null>(null)
  const [phase, setPhase] = useState('')
  const [busy, setBusy] = useState(false)
  const [srch, setSrch] = useState<SearchSettings | null>(null)
  const [found, setFound] = useState<SearchResult | null>(null)
  const [az, setAz] = useState({ id: '', key: '' })
  useEffect(() => window.api.on('setup:phase', setPhase), [])
  const boardUrl = (b: BoardCandidate): string => b.ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${b.token}` : b.ats === 'lever' ? `https://jobs.lever.co/${b.token}` : `https://jobs.ashbyhq.com/${b.token}`
  const runSetup = async (): Promise<void> => {
    setBusy(true); setMsg(''); setSetup(null)
    try {
      setSetup(await window.api.setupFromResume())
      setBoards(await window.api.listBoards())
    } catch (e) { setMsg(clean(e)) }
    setBusy(false); setPhase('')
  }
  useEffect(() => { window.api.listBoards().then(setBoards); window.api.getSchedule().then(setSch); window.api.getSearch().then(setSrch) }, [])
  const runSearch = async (): Promise<void> => {
    setBusy(true); setMsg(''); setFound(null)
    try { setFound(await window.api.searchSites()); setBoards(await window.api.listBoards()) } catch (e) { setMsg(clean(e)) }
    setBusy(false); setPhase('')
  }
  if (!sch) return <p>Loading…</p>

  return (
    <div>
      <div>
        <div className="issues">
          <b>Set up from my resume</b>
          <p><small>Fills any criteria you have left empty (target titles, nearby cities, excluded words: see the Criteria tab) and finds employers in your field. Each employer is checked against its real public job board, so nothing made up gets added. Boards with relevant open roles are added automatically; you can remove any of them, and add your own below.</small></p>
          <button disabled={busy} onClick={runSetup}>{busy ? 'Working…' : 'Set up for me'}</button> <span className="status">{phase}</span>
          {setup && (
            <div>
              <p>{setup.criteria.set.length ? `Filled in: ${setup.criteria.set.join(', ')}.` : 'Your criteria were already filled in, so I left them alone.'}</p>
              {setup.criteria.notes.map((n, i) => <p key={i}><small>{n}</small></p>)}
              <p><b>Added {setup.added.length} employer board(s)</b></p>
              <ul className="tight">{setup.added.map((b) => <li key={b.token}>{b.name} <small>({b.ats}, {b.jobs} open, {b.matches} look relevant) · {b.why}</small></li>)}</ul>
              {setup.suggestions.length > 0 && (<><p><b>Also possible</b> <small>(could not fully confirm these are the right company)</small></p>
                <ul className="tight">{setup.suggestions.map((b) => (
                  <li key={b.ats + b.token}>{b.name} <small>({b.ats}/{b.token}, {b.jobs} open, {b.matches} relevant)</small>{' '}
                    <button onClick={async () => { setBoards(await window.api.addBoard(boardUrl(b), 'suggested')); setSetup({ ...setup, suggestions: setup.suggestions.filter((x) => x !== b) }) }}>Add</button></li>))}</ul></>)}
              {setup.unresolved.length > 0 && <p><small>No public board found for: {setup.unresolved.join(', ')}. If you know their careers page is on Greenhouse, Lever or Ashby, paste it below.</small></p>}
            </div>
          )}
        </div>
        {srch && (<>
          <h3>Job search sites</h3>
          <p><small>Searches these sites for your target titles, then follows each job back to the employer's own Greenhouse, Lever or Ashby board and adds that board, so every job is read live from the employer and can be applied to. Companies on your Never apply list and your past employers are skipped. This runs at the start of every discovery run.</small></p>
          <div className="row">
            <label><input type="checkbox" checked={srch.remotive} onChange={async (e) => setSrch(await window.api.setSearch({ remotive: e.target.checked }))} /> Remotive</label>
            <label><input type="checkbox" checked={srch.remoteok} onChange={async (e) => setSrch(await window.api.setSearch({ remoteok: e.target.checked }))} /> RemoteOK</label>
            <label><input type="checkbox" checked={srch.adzuna} onChange={async (e) => setSrch(await window.api.setSearch({ adzuna: e.target.checked }))} /> Adzuna (needs a free key)</label>
          </div>
          {srch.adzuna && (<div className="row">
            <input value={az.id} onChange={(e) => setAz({ ...az, id: e.target.value })} placeholder={srch.adzunaKeySet ? 'App id (saved)' : 'Adzuna app id'} />
            <input type="password" value={az.key} onChange={(e) => setAz({ ...az, key: e.target.value })} placeholder={srch.adzunaKeySet ? 'App key (saved)' : 'Adzuna app key'} />
            <button disabled={!az.id.trim() || !az.key.trim()} onClick={async () => { setSrch(await window.api.setAdzunaKey(az.id, az.key)); setAz({ id: '', key: '' }) }}>Save key</button>
          </div>)}
          <div className="bar">
            <button disabled={busy} onClick={runSearch}>{busy && phase ? phase : 'Search sites now'}</button>
            <span className="status">Finds employers only; run discovery afterwards to read their jobs.</span>
          </div>
          {found && (<>
            <p>{found.leads} matching listing(s) from {found.companies} new compan{found.companies === 1 ? 'y' : 'ies'}; added {found.added.length} employer board(s){found.noBoard ? `; ${found.noBoard} had no public Greenhouse, Lever or Ashby board` : ''}.</p>
            {found.added.length > 0 && <p><small>{found.added.join(', ')}</small></p>}
            {found.errors.map((e, i) => <p key={i} className="error"><small>{e}</small></p>)}
          </>)}
        </>)}
        <h3>Employer boards</h3>
        <p><small>Postings are read from each employer's own job board (Greenhouse, Lever, Ashby), so they are live and show real pay. Paste any board or posting URL.</small></p>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://job-boards.greenhouse.io/<company>" />
          <button disabled={!url.trim()} onClick={async () => {
            setMsg('Checking…')
            try { setBoards(await window.api.addBoard(url)); setUrl(''); setMsg('') } catch (e) { setMsg(clean(e)) }
          }}>Add</button>
        </div>
        {msg && <p className="error">{msg}</p>}
        <table><tbody>{boards.map((b) => (
          <tr key={b.id}>
            <td><input type="checkbox" checked={b.enabled} onChange={async (e) => setBoards(await window.api.toggleBoard(b.id, e.target.checked))} /></td>
            <td>{b.name} <small>({b.ats}/{b.token}){b.source === 'suggested' ? ' · suggested' : b.source === 'search' ? ' · from job search' : ''}</small></td>
            <td><small>{b.job_count} jobs{b.last_error ? <span className="error"> · {b.last_error}</span> : ''}</small></td>
            <td><button onClick={async () => setBoards(await window.api.removeBoard(b.id))}>×</button></td>
          </tr>))}</tbody></table>

        <h3>Schedule</h3>
        <label className="row"><input type="checkbox" checked={sch.enabled} onChange={async (e) => setSch(await window.api.setSchedule({ ...sch, enabled: e.target.checked }))} />
          <span style={{ width: 'auto' }}>Run automatically every</span>
          <input type="number" min={1} max={72} style={{ width: 60, flex: 'none' }} value={sch.intervalHours}
            onChange={(e) => setSch({ ...sch, intervalHours: Number(e.target.value) })}
            onBlur={async () => setSch(await window.api.setSchedule(sch))} /> hours</label>
        <p><small>Runs while the app is open in the menu bar. You get a notification when new strong matches appear.</small></p>
      </div>

    </div>
  )
}
