import { useEffect, useState } from 'react'
import type { Criteria } from '../../shared/discovery'
import { Brief } from './Brief'
import { ListInput, MODES } from './controls'

/** The structured criteria: pay floor, work modes, places, titles and exclusions. */
function CriteriaForm() {
  const [c, setC] = useState<Criteria | null>(null)
  const [employers, setEmployers] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  useEffect(() => { window.api.getCriteria().then(setC); window.api.previousEmployers().then(setEmployers) }, [])
  if (!c) return <p>Loading…</p>
  const num = (k: keyof Criteria) => (e: React.ChangeEvent<HTMLInputElement>): void => setC({ ...c, [k]: Number(e.target.value) })

  return (
    <>
      <h3>Criteria</h3>
      <p><small><b>Pay floor</b>: jobs are skipped only if their listed top pay is below it (unlisted pay stays in). <b>Target titles</b>: what to look for; related roles are included. <b>Also local</b>: other towns that count as nearby for hybrid or on-site jobs. <b>Exclude titles</b>: words that auto-skip a job, like "intern". The rest limit how much is scored per run.</small></p>
      <label className="row"><span>Pay floor (annual $)</span><input type="number" value={c.payFloor} onChange={num('payFloor')} /></label>
      <div className="row"><span>Work modes</span>{MODES.map((m) => (
        <label key={m}><input type="checkbox" checked={c.workModes.includes(m)}
          onChange={(e) => setC({ ...c, workModes: e.target.checked ? [...c.workModes, m] : c.workModes.filter((x) => x !== m) })} /> {m}</label>))}</div>
      <label className="row"><span>City</span><input value={c.city} onChange={(e) => setC({ ...c, city: e.target.value })} /></label>
      <label className="row"><span>State (2 letters)</span><input maxLength={2} value={c.state} onChange={(e) => setC({ ...c, state: e.target.value.toUpperCase() })} /></label>
      <label className="row"><span>Also local</span><ListInput value={c.nearby} placeholder="Phoenix, Tempe, Mesa" onChange={(v) => setC({ ...c, nearby: v })} /></label>
      <label className="row"><span>Target titles</span><ListInput value={c.targetTitles} placeholder="comma separated; adjacent roles are included" onChange={(v) => setC({ ...c, targetTitles: v })} /></label>
      <label className="row"><span>Exclude titles</span><ListInput value={c.excludeTitles} placeholder="intern, director of sales" onChange={(v) => setC({ ...c, excludeTitles: v })} /></label>
      <label className="row"><span>Never apply to</span><ListInput value={c.excludeCompanies ?? []} placeholder="companies to skip entirely, comma separated" onChange={(v) => setC({ ...c, excludeCompanies: v })} /></label>
      <p><small>Companies on your resume are never applied to ({employers.length ? employers.join(', ') : 'none yet'}). Matching is by whole words, so it can also catch a different company that starts with the same name.</small></p>
      <label className="row"><span>Okay to re-apply</span><ListInput value={c.includeCompanies ?? []} placeholder="previous employers you would go back to, comma separated" onChange={(v) => setC({ ...c, includeCompanies: v })} /></label>
      <label className="row"><span>Max posting age (days, 0 = any)</span><input type="number" value={c.maxAgeDays} onChange={num('maxAgeDays')} /></label>
      <label className="row"><span>Min title relevance (0-100)</span><input type="number" value={c.minTriage} onChange={num('minTriage')} /></label>
      <label className="row"><span>Notify at fit ≥</span><input type="number" value={c.notifyScore} onChange={num('notifyScore')} /></label>
      <label className="row"><span>Max jobs scored per run</span><input type="number" value={c.maxScorePerRun} onChange={num('maxScorePerRun')} /></label>
      <button onClick={async () => { setC(await window.api.setCriteria(c)); setMsg('Saved. Queued jobs that no longer fit are hidden now (see Skipped on the Jobs tab); jobs that newly fit appear on the next run.') }}>Save criteria</button>
      {msg && <p className="status">{msg}</p>}
    </>
  )
}

export function CriteriaTab() {
  const [version, setVersion] = useState(0) // bumped when Claude's proposal changes the criteria, so the form reloads
  return (
    <>
      <Brief onChanged={() => setVersion((v) => v + 1)} />
      <CriteriaForm key={version} />
    </>
  )
}
