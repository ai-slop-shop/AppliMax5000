import { useEffect, useRef, useState } from 'react'
import type { BriefApplied, BriefProposal, BriefSelection } from '../../shared/discovery'
import { registerFlush } from './flush'

const clean = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const EXAMPLES = [
  'Expand my search to adjacent roles and industries I could move into',
  'Rewrite my facts so recruiters and AI screening tools are more likely to find me',
  'Improve my resume wording so applicant tracking systems and AI screeners match it better',
  "I'd relocate to Seattle or Austin for the right role",
  'I need at least $140,000 and prefer small teams'
]

export function Brief({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [ask, setAsk] = useState('')
  const [prop, setProp] = useState<BriefProposal | null>(null)
  const [pick, setPick] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [done, setDone] = useState<BriefApplied | null>(null)
  const latest = useRef({ text: '', saved: '' })
  latest.current = { text, saved }

  useEffect(() => { window.api.getBrief().then((b) => { setText(b.text); setSaved(b.text) }) }, [])
  const save = async (): Promise<void> => { if (latest.current.text !== latest.current.saved) { await window.api.setBrief(latest.current.text); setSaved(latest.current.text) } }
  useEffect(() => { const t = setTimeout(save, 800); return () => clearTimeout(t) }, [text])
  useEffect(() => { const off = registerFlush(save); return () => { off(); void save() } }, [])

  const run = async (request: string | null): Promise<void> => {
    setBusy(true); setMsg('Reading your request, checking employers…'); setProp(null); setDone(null)
    try {
      await save()
      const p = await window.api.proposeFromBrief(request)
      const on: Record<string, boolean> = {}
      p.targetTitles.forEach((x) => { on['t:' + x] = true }); p.excludeTitles.forEach((x) => { on['x:' + x] = true })
      p.nearby.forEach((x) => { on['n:' + x] = true }); p.excludeCompanies.forEach((x) => { on['c:' + x] = true })
      if (p.workModes) on.modes = true
      if (p.payFloor) on.pay = true
      p.boards.forEach((b) => { on['b:' + b.ats + '/' + b.token] = true })
      p.factEdits.forEach((f) => { on['f:' + f.id] = !f.flagged }) // flagged rewrites start unticked
      p.resumeEdits.forEach((r) => { on['r:' + r.key] = !r.flagged })
      setPick(on); setProp(p); setMsg('')
    } catch (e) { setMsg(clean(e)) }
    setBusy(false)
  }

  const apply = async (): Promise<void> => {
    if (!prop) return
    const sel: BriefSelection = {
      targetTitles: prop.targetTitles.filter((x) => pick['t:' + x]), excludeTitles: prop.excludeTitles.filter((x) => pick['x:' + x]),
      nearby: prop.nearby.filter((x) => pick['n:' + x]), excludeCompanies: prop.excludeCompanies.filter((x) => pick['c:' + x]),
      workModes: pick.modes ? prop.workModes : null, payFloor: pick.pay && prop.payFloor ? prop.payFloor.value : null,
      boards: prop.boards.filter((b) => pick['b:' + b.ats + '/' + b.token]).map((b) => ({ ats: b.ats, token: b.token })),
      factEdits: prop.factEdits.filter((f) => pick['f:' + f.id]).map((f) => ({ id: f.id, after: f.after })),
      resumeEdits: prop.resumeEdits.filter((r) => pick['r:' + r.key]).map((r) => ({ key: r.key, before: r.before, after: r.after }))
    }
    setBusy(true)
    try { setDone(await window.api.applyBrief(sel)); setProp(null); onChanged() } catch (e) { setMsg(clean(e)) }
    setBusy(false)
  }

  const box = (k: string, label: React.ReactNode): React.ReactNode => (
    <label key={k} className="pick"><input type="checkbox" checked={!!pick[k]} onChange={(e) => setPick({ ...pick, [k]: e.target.checked })} /> {label}</label>)
  const any = prop && (prop.targetTitles.length || prop.excludeTitles.length || prop.nearby.length || prop.excludeCompanies.length || prop.workModes || prop.payFloor || prop.boards.length || prop.factEdits.length || prop.resumeEdits.length)

  return (
    <>
      <h3>What I'm looking for</h3>
      <p><small>Describe it in your own words: the kind of work, what you would move into, where you would go, pay, what you want to avoid. This is saved, and it also guides how every job is scored, so deal-breakers count.</small></p>
      <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={'e.g. I want a technical producer or tools lead role at a games or creative-software studio. Remote is best. I could move into developer-experience or pipeline roles at other tech companies. I would relocate to Seattle. I need at least $140,000. No crunch culture, and never apply to Zynga.'} />
      <div className="bar">
        <button disabled={busy || !text.trim()} onClick={() => run(null)}>Update my search from this</button>
        <span className="status">{text === saved ? (saved ? 'Saved' : '') : 'Saving…'}</span>
      </div>

      <h3>Ask Claude</h3>
      <p><small>A one-off request. Claude proposes changes; nothing is applied until you tick it and press Apply.</small></p>
      <textarea rows={2} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Rewrite my facts so recruiters and AI screening tools are more likely to find me" />
      <div className="bar">
        <button disabled={busy || !ask.trim()} onClick={() => run(ask)}>Ask</button>
        {EXAMPLES.map((x) => <a key={x} href="#" className="chip" onClick={(e) => { e.preventDefault(); setAsk(x) }}>{x}</a>)}
      </div>
      {msg && <p className={busy ? 'status' : 'error'}>{msg}</p>}

      {done && (
        <div className="issues"><b>Applied.</b>
          <ul className="tight">
            {done.criteria.length > 0 && <li>Search updated: {done.criteria.join(', ')}</li>}
            {done.boardsAdded > 0 && <li>{done.boardsAdded} employer board(s) added. Run discovery to pull their jobs.</li>}
            {done.resumeEdited > 0 && <li>{done.resumeEdited} master-resume edit(s) applied. Not what you wanted? Use "Undo last AI rewrite" on the Resume tab.</li>}
            {done.resumeStale > 0 && <li>{done.resumeStale} resume edit(s) skipped because that text had changed since the proposal.</li>}
            {done.factsEdited > 0 && <li>{done.factsEdited} fact(s) rewritten. The old wording is kept on the Facts tab with a Revert button.</li>}
            {done.queueSkipped > 0 && <li>{done.queueSkipped} queued job(s) removed (already applied, or a company you excluded).</li>}
            {!done.criteria.length && !done.boardsAdded && !done.factsEdited && !done.resumeEdited && <li>Nothing was selected.</li>}
          </ul></div>
      )}

      {prop && (
        <div className="issues">
          <b>Claude's proposal</b>
          {prop.notes.map((n, i) => <p key={i}><small>{n}</small></p>)}
          {prop.questions.length > 0 && <p><b>Questions:</b> <small>{prop.questions.join(' · ')} (answer in the description above and run again)</small></p>}
          {!any && <p>Nothing new to change.</p>}

          {prop.resumeEdits.length > 0 && <><h4>Master resume rewrites</h4>
            <p><small>Wording only. Employers, titles and dates are never changed. Each edit is checked against your resume; anything that adds a claim or number, pads, or repeats terms is flagged and left unticked. You can undo the whole batch afterwards.</small></p>
            {prop.resumeEdits.map((r) => (
              <div key={r.key} className={`fact ${r.flagged ? 'unconfirmed' : ''}`}>
                <input type="checkbox" checked={!!pick['r:' + r.key]} onChange={(e) => setPick({ ...pick, ['r:' + r.key]: e.target.checked })} />
                <div className="fbody">
                  <small><b>{r.label}</b></small>
                  {r.before && <div className="dropped">{r.before}</div>}<div><b>{r.after}</b></div>
                  <small>{r.flagged ? <span className="error">Flagged: {r.note} </span> : ''}{r.why}</small>
                </div>
              </div>))}</>}

          {prop.factEdits.length > 0 && <><h4>Fact rewrites</h4>
            <p><small>Rewrites reword only. Each is checked against your original and resume; anything that adds a claim or number is flagged and left unticked.</small></p>
            {prop.factEdits.map((f) => (
              <div key={f.id} className={`fact ${f.flagged ? 'unconfirmed' : ''}`}>
                <input type="checkbox" checked={!!pick['f:' + f.id]} onChange={(e) => setPick({ ...pick, ['f:' + f.id]: e.target.checked })} />
                <div className="fbody">
                  <div className="dropped">{f.before}</div><div><b>{f.after}</b></div>
                  <small>{f.flagged ? <span className="error">Flagged: {f.note} </span> : f.note ? `${f.note} ` : ''}{f.why}</small>
                </div>
              </div>))}</>}

          {(prop.targetTitles.length > 0) && <><h4>Add target titles</h4><div>{prop.targetTitles.map((x) => box('t:' + x, x))}</div></>}
          {(prop.excludeTitles.length > 0) && <><h4>Skip titles containing</h4><div>{prop.excludeTitles.map((x) => box('x:' + x, x))}</div></>}
          {(prop.nearby.length > 0) && <><h4>Count as local</h4><div>{prop.nearby.map((x) => box('n:' + x, x))}</div></>}
          {(prop.excludeCompanies.length > 0) && <><h4>Never apply to</h4><div>{prop.excludeCompanies.map((x) => box('c:' + x, x))}</div></>}
          {prop.workModes && <><h4>Work modes</h4>{box('modes', `Only: ${prop.workModes.join(', ')}`)}</>}
          {prop.payFloor && <><h4>Pay floor</h4>{box('pay', <>${prop.payFloor.value.toLocaleString()} <small>(you said: “{prop.payFloor.quote}”)</small></>)}</>}
          {prop.boards.length > 0 && <><h4>Employers to add <small>(each has a real public job board)</small></h4>
            {prop.boards.map((b) => box('b:' + b.ats + '/' + b.token, <>{b.name} <small>({b.ats}, {b.jobs} open, {b.matches} look relevant) · {b.why}</small></>))}</>}
          {prop.unresolved.length > 0 && <p><small>No public board found for: {prop.unresolved.join(', ')}.</small></p>}
          {any && <p><button disabled={busy} onClick={apply}>Apply selected</button> <button onClick={() => setProp(null)}>Dismiss</button></p>}
        </div>
      )}
    </>
  )
}
