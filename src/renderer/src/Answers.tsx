import { useEffect, useState } from 'react'
import type { Answer, QuestionRow } from '../../shared/apply'

const clean = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const SENSITIVE: Record<string, string> = {
  legal: 'Legal question: answer only if you are certain', consent: 'Consent/agreement: always needs your approval per company',
  demographic: 'Demographic: defaults to "decline" if left blank', pay: 'Pay: always pauses for your approval', essay: 'Essay: write it yourself; nothing is invented'
}

function QuestionCard({ q, onChange }: { q: QuestionRow; onChange: (rows: QuestionRow[]) => void }) {
  const [val, setVal] = useState(q.answer ?? '')
  const [err, setErr] = useState('')
  useEffect(() => setVal(q.answer ?? ''), [q.answer])
  const save = async (v: string): Promise<void> => {
    setErr('')
    try { onChange(await window.api.answerQuestion(q.id, v)) } catch (e) { setErr(clean(e)) }
  }
  const editable = q.kind !== 'textarea' || q.sensitivity !== 'essay'
  return (
    <div className={`qcard ${q.answer || q.years ? 'answered' : q.suggestion ? 'suggested' : ''}`}>
      <div><b>{q.label}</b>{q.required && ' *'} <small>seen in {q.seen} posting(s){q.companies.length ? `: ${q.companies.slice(0, 4).join(', ')}` : ''}</small></div>
      {q.variants.length > 0 && <small>Also asked as: {q.variants.slice(0, 4).map((v) => `"${v}"`).join(', ')}{q.variants.length > 4 ? ` and ${q.variants.length - 4} more` : ''}. One answer covers all of them.</small>}
      {q.years && !q.answer && <div className="suggest auto">Answered automatically from your resume: <b>{q.years.whole} year(s)</b> <small>({q.years.basis}). Whole years, rounded down. Type an answer below to override.</small></div>}
      {SENSITIVE[q.sensitivity] && <small className="warn">{SENSITIVE[q.sensitivity]}</small>}
      {editable ? (
        <div className="row">
          {q.options.length ? (
            <select value={val} onChange={(e) => { setVal(e.target.value); save(e.target.value) }}>
              <option value="">(no answer yet)</option>{q.options.map((o) => <option key={o}>{o}</option>)}</select>
          ) : (
            <input value={val} onChange={(e) => setVal(e.target.value)} onBlur={() => { if (val.trim() !== (q.answer ?? '')) save(val) }} placeholder="Your confirmed answer" />
          )}
          <button onClick={() => window.api.dismissQuestion(q.id, true).then(onChange)} title="Hide this question">Hide</button>
        </div>
      ) : <small>Not suggested or stored here. The apply screen will ask you each time.</small>}
      {!q.answer && q.suggestion && (
        <div className="suggest">
          Suggested: <b>{q.suggestion}</b> <small>based on: {q.basis}</small>
          <button onClick={() => save(q.suggestion)}>Confirm</button>
          <button onClick={() => setVal(q.suggestion)}>Edit</button>
        </div>
      )}
      {err && <small className="error">{err}</small>}
    </div>
  )
}

export function Answers() {
  const [qs, setQs] = useState<QuestionRow[]>([])
  const [rows, setRows] = useState<Answer[]>([])
  const [p, setP] = useState('')
  const [a, setA] = useState('')
  const [status, setStatus] = useState('')
  const [showAnswered, setShowAnswered] = useState(false)
  const load = (): void => { window.api.listQuestions().then(setQs); window.api.listAnswers().then(setRows) }
  useEffect(load, [])

  const unanswered = qs.filter((q) => !q.answer && !q.years)
  // Essays, consent boxes, demographics, pay and free-text are never answered from this list: the apply screen handles them.
  const handled = unanswered.filter((q) => ['essay', 'consent', 'demographic', 'pay'].includes(q.sensitivity) || q.kind === 'textarea')
  const rest = unanswered.filter((q) => !handled.includes(q))
  const common = rest.filter((q) => q.seen >= 2 || q.variants.length > 0)
  const once = rest.filter((q) => !common.includes(q))
  const open = [...common, ...once]
  const mergedAway = qs.reduce((n, q) => n + q.variants.length, 0)
  const auto = qs.filter((q) => !q.answer && q.years)
  const done = qs.filter((q) => q.answer)
  const manual = rows.filter((r) => r.question_id == null)

  return (
    <>
      <p>Confirmed answers are the only source for application questions. Legal questions such as work authorization and sponsorship are answered <b>only</b> from here, never guessed.</p>
      <div className="bar">
        <button disabled={!!status} onClick={async () => {
          setStatus('Reading application forms…')
          try { const r = await window.api.scanQuestions(); setStatus(`Scanned ${r.scanned} posting(s); ${r.questions} distinct question(s) after merging ${r.merged} duplicate(s); ${r.yearsAnswered} years question(s) answered from your resume${r.errors ? `; ${r.errors} failed to load` : ''}.`); load() } catch (e) { setStatus(clean(e)) }
        }}>Scan postings for questions</button>
        <button disabled={!!status} onClick={async () => {
          setStatus('Merging duplicate questions and computing years…')
          try { const r = await window.api.consolidateQuestions(); setStatus(`Merged ${r.merged} duplicate question(s); ${r.years} years-of-experience question(s) answered from your resume.${r.note ? ` (Claude's extra pass was skipped: ${r.note})` : ''}`); load() } catch (e) { setStatus(clean(e)) }
        }}>Merge duplicates &amp; answer years</button>
        <button disabled={!!status || common.length + once.length === 0} onClick={async () => {
          setStatus('Looking for answers in your resume and facts…')
          try { const r = await window.api.suggestAnswers(); setQs(r.questions); setStatus(`${r.suggested} suggestion(s). Nothing is saved until you confirm.`) } catch (e) { setStatus(clean(e)) }
        }}>Suggest answers from my resume</button>
        <button onClick={async () => { const n = await window.api.recheckBlockers(); setStatus(`Re-checked ${n} job(s) against your answers.`) }}>Recheck job blockers</button>
        <span className="status">{status}</span>
      </div>

      <h3>Questions that come up repeatedly ({common.length} to answer)</h3>
      <p><small>{mergedAway > 0 ? `${mergedAway} near-identical wording(s) are already merged into these, so you answer each thing once. ` : ''}Answer these first: they save the most typing.</small></p>
      {qs.length === 0 && <p>No questions collected yet. Add employer boards and run discovery on the Jobs tab, then press "Scan postings for questions".</p>}
      {common.map((q) => <QuestionCard key={q.id} q={q} onChange={(r) => { setQs(r); window.api.listAnswers().then(setRows) }} />)}
      {once.length > 0 && <details><summary>One-off questions seen in a single posting ({once.length})</summary>
        <p><small>Specific to one role, so they are not worth answering ahead of time. You will be asked when you apply to that job.</small></p>
        {once.map((q) => <QuestionCard key={q.id} q={q} onChange={(r) => { setQs(r); window.api.listAnswers().then(setRows) }} />)}</details>}
      {handled.length > 0 && <details><summary>Handled when you apply: essays, consent, demographic, pay ({handled.length})</summary>
        <p><small>These are never answered from here. Essays are drafted from your Stories, consent boxes need your approval for each company, and demographic questions default to "decline".</small></p>
        <ul className="tight">{handled.slice(0, 80).map((q) => <li key={q.id}><small>{q.label.slice(0, 140)} <i>({q.sensitivity === 'none' ? 'free text' : q.sensitivity})</i></small></li>)}</ul></details>}
      {auto.length > 0 && (<><h3>Answered automatically from your resume ({auto.length})</h3>
        <p><small>Years of experience, computed from your dated roles. Only roles whose own text mentions the subject count, and overlapping roles are not double counted. If a posting asks for more years than your resume shows, the app asks you instead of answering "No".</small></p>
        {auto.map((q) => <QuestionCard key={q.id} q={q} onChange={(r) => { setQs(r); window.api.listAnswers().then(setRows) }} />)}</>)}
      {done.length > 0 && <p><a href="#" onClick={(e) => { e.preventDefault(); setShowAnswered(!showAnswered) }}>{showAnswered ? 'Hide' : 'Show'} {done.length} answered</a></p>}
      {showAnswered && done.map((q) => <QuestionCard key={q.id} q={q} onChange={(r) => { setQs(r); window.api.listAnswers().then(setRows) }} />)}

      <h3>Your own patterns</h3>
      <p><small>For questions not collected above. The pattern is matched (case-insensitive regex or text) against the question.</small></p>
      <div className="row">
        <input value={p} onChange={(e) => setP(e.target.value)} placeholder="question pattern, e.g. visa sponsorship" />
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="answer, e.g. No" />
        <button disabled={!p.trim() || !a.trim()} onClick={async () => { setRows(await window.api.addAnswer(p, a)); setP(''); setA(''); load() }}>Add</button>
      </div>
      <ul>{manual.map((r) => <li key={r.id}><code>{r.question_pattern}</code> → <b>{r.answer}</b> <button onClick={async () => { setRows(await window.api.removeAnswer(r.id)); load() }}>×</button></li>)}</ul>
    </>
  )
}
