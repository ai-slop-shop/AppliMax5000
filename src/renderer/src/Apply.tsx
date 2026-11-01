import { useState } from 'react'
import type { ApplyPlan, FillResult, SubmitResult } from '../../shared/apply'
import type { EssayDraft } from '../../shared/tailor'

export function Apply({ draftId, company }: { draftId: number; company: string }) {
  const [plan, setPlan] = useState<ApplyPlan | null>(null)
  const [over, setOver] = useState<Record<string, string>>({})
  const [remember, setRemember] = useState<Record<string, boolean>>({})
  const [appr, setAppr] = useState<Record<string, boolean>>({})
  const [fill, setFill] = useState<FillResult | null>(null)
  const [sub, setSub] = useState<SubmitResult | null>(null)
  const [status, setStatus] = useState('')
  const [override14, setOverride14] = useState(false)
  const [note, setNote] = useState('')
  const [saveSel, setSaveSel] = useState<Record<string, boolean>>({}) // which of the browser edits to also save as answers
  const [ack, setAck] = useState(false) // "I checked these in the browser window"
  const [essay, setEssay] = useState<Record<string, EssayDraft>>({})

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setStatus(label + '…')
    try { await fn(); setStatus('') } catch (e) { setStatus(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }
  const have = (n: string): boolean => !!(over[n] ?? '').trim()
  // What is actually standing between the user and the Fill button, from the screen's current state.
  const stops = plan ? [
    ...(plan.blocked ? [{ kind: 'blocked', text: plan.blocked }] : []),
    ...plan.items.filter((i) => i.status === 'needs_user' && !have(i.name)).map((i) => ({ kind: 'answer', text: `Answer needed: ${i.label}` })),
    ...plan.items.filter((i) => i.status === 'ready' && i.source === 'suggested').map((i) => ({ kind: 'confirm', text: `Confirm the suggested answer: ${i.label}` })),
    ...plan.items.filter((i) => i.status === 'ready' && i.needsApproval && i.source !== 'suggested' && !appr[i.name]).map((i) => ({ kind: 'approve', text: `Approve: ${i.label}` }))
  ] : []
  const canFill = !!plan && stops.length === 0
  const rememberOn = (i: { name: string; sensitivity: string }): boolean => remember[i.name] ?? i.sensitivity !== 'essay' // typed answers are kept by default, except essays
  const load = (): Promise<void> => run('Reading the form', async () => {
    setPlan(await window.api.applyPlan(draftId, over, (plan?.items ?? []).filter((i) => have(i.name) && rememberOn(i)).map((i) => i.name)))
    setRemember({}) // saved once; don't re-add on refresh
  })

  return (
    <div className="issues">
      <h3>Apply {company && `to ${company}`}</h3>
      <p><small>Nothing is submitted until you press Submit. The app never creates accounts, enters passwords or solves CAPTCHAs.</small></p>
      <button disabled={!!status} onClick={load}>{plan ? 'Refresh plan' : 'Build plan'}</button>
      <span className="status">{status}</span>
      {plan?.blocked && <p className="error"><b>Blocked:</b> {plan.blocked}</p>}
      {plan?.cooldown && <p className="error">{plan.cooldown} <label><input type="checkbox" checked={override14} onChange={(e) => setOverride14(e.target.checked)} /> apply anyway</label></p>}

      {plan && !canFill && (
        <div className="stopbox">
          <b>The form can't be filled yet.</b> {stops.length} thing(s) to do first:
          <ul className="tight">{stops.map((x, k) => <li key={k} className={x.kind === 'blocked' ? 'error' : ''}>{x.text}</li>)}</ul>
          <small>Type or choose an answer in the table below (it's kept for next time unless you untick "remember"). Then press Fill form. There's no separate button to press.</small>
        </div>
      )}
      {plan && canFill && <p className="status">Ready: every required field has an answer. Press Fill form to open the application in a browser window. Nothing is submitted yet.</p>}
      {plan && (() => {
        const shown = plan.items.filter((i) => i.status !== 'skip')
        const by = (f: (i: (typeof shown)[number]) => boolean): number => shown.filter(f).length
        const suggested = shown.filter((i) => i.status === 'ready' && i.source === 'suggested')
        return (
          <div className="issues">
            <b>{shown.length} fields on this form.</b>{' '}
            <small>
              {by((i) => i.status === 'ready' && ['profile', 'draft', 'default'].includes(i.source))} from your profile and draft ·{' '}
              {by((i) => i.status === 'ready' && i.source === 'answer')} from your saved answers ·{' '}
              {by((i) => i.status === 'ready' && i.source === 'resume')} computed from your resume dates ·{' '}
              {by((i) => i.status === 'ready' && i.source === 'user')} typed by you ·{' '}
              <b>{suggested.length} suggested from your resume and facts, waiting for you to confirm</b> ·{' '}
              <b className={by((i) => i.status === 'needs_user') ? 'error' : ''}>{by((i) => i.status === 'needs_user')} still need you</b>
            </small>
            {suggested.length > 0 && <p><button disabled={!!status} onClick={() => run('Confirming', async () => {
              setPlan(await window.api.confirmSuggested(draftId, suggested.map((i) => i.name), over))
            })}>Confirm all {suggested.length} suggested answers</button> <small>Each becomes a saved answer, so you are never asked it again.</small></p>}
          </div>
        )
      })()}
      {plan && (
        <table>
          <thead><tr><th>Field</th><th>Value</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {plan.items.filter((i) => i.status !== 'skip').map((i) => (
              <tr key={i.name} className={i.status === 'needs_user' && !have(i.name) ? 'error' : ''}>
                <td>{i.label}{i.required && ' *'}</td>
                <td>{i.status === 'needs_user' ? (
                  i.options.length ? (
                    <select value={over[i.name] ?? ''} onChange={(e) => setOver({ ...over, [i.name]: e.target.value })}>
                      <option value="">Choose…</option>{i.options.map((o) => <option key={o}>{o}</option>)}</select>
                  ) : i.kind === 'textarea' ? (
                    <div>
                      <textarea rows={7} value={over[i.name] ?? ''} onChange={(e) => setOver({ ...over, [i.name]: e.target.value })} placeholder="Write your answer, or draft one from your stories" />
                      {i.sensitivity === 'essay' && <button disabled={!!status} onClick={() => run('Drafting from your stories', async () => {
                        const d = await window.api.draftEssay(draftId, i.name)
                        setEssay({ ...essay, [i.name]: d })
                        if (d.answer) setOver({ ...over, [i.name]: d.answer })
                      })}>Draft from my stories</button>}
                      {essay[i.name] && (
                        <small style={{ display: 'block' }}>
                          {essay[i.name].answer ? `Built from: ${essay[i.name].storyTitles.join('; ') || 'no story cited'}.` : 'Nothing drafted.'} {essay[i.name].note}
                          {essay[i.name].warnings.map((w, k) => <span key={k} className="error"> {w}</span>)}
                          {essay[i.name].answer && ' Edit it until it is exactly true, then press "Apply my inputs".'}
                        </small>
                      )}
                    </div>
                  ) : <input value={over[i.name] ?? ''} onChange={(e) => setOver({ ...over, [i.name]: e.target.value })} placeholder="Your answer (nothing is invented)" />
                ) : <span>{i.kind === 'file' ? (/cover/i.test(i.label) ? 'cover letter PDF' : 'resume PDF') : i.value.length > 80 ? i.value.slice(0, 80) + '…' : i.value}</span>}</td>
                <td>{({ profile: 'your profile', draft: 'your draft', default: 'default', answer: 'your answer', user: 'you', resume: 'resume dates', suggested: 'suggested', none: '' } as Record<string, string>)[i.source] ?? i.source}{i.status === 'needs_user' && <label> <input type="checkbox" checked={rememberOn(i)} onChange={(e) => setRemember({ ...remember, [i.name]: e.target.checked })} /> remember</label>}</td>
                <td>{i.source === 'suggested'
                  ? <><small>{i.reason}</small> <button disabled={!!status} onClick={() => run('Confirming', async () => setPlan(await window.api.confirmSuggested(draftId, [i.name], over)))}>Confirm</button></>
                  : i.needsApproval ? <label><input type="checkbox" checked={!!appr[i.name]} onChange={(e) => setAppr({ ...appr, [i.name]: e.target.checked })} /> approve</label> : <small>{i.reason}</small>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan && Object.keys(over).length > 0 && <button onClick={load}>Apply my inputs</button>}

      {plan && (
        <p><button disabled={!canFill || !!status} title={canFill ? '' : 'See the list above for what is still needed'} onClick={() => run('Filling the form in a browser window', async () => {
          const keep = plan.items.filter((i) => have(i.name) && rememberOn(i)).map((i) => i.name)
          setSub(null); setFill(await window.api.applyFill(draftId, over, appr, override14, keep))
        })}>Fill form (does not submit)</button></p>
      )}

      {fill && (
        <>
          {fill.changed.length > 0 && (
            <div className="stopbox">
              <b>You changed {fill.changed.length} field(s) in the browser window.</b> Accept them so the application uses your new values, and choose which ones to remember for next time:
              <table><tbody>{fill.changed.map((c) => (
                <tr key={c.name}>
                  <td>{c.label}</td>
                  <td><small className="dropped">{c.before}</small><br /><b>{c.after}</b></td>
                  <td>{c.saveable
                    ? <label><input type="checkbox" checked={saveSel[c.name] ?? true} onChange={(e) => setSaveSel({ ...saveSel, [c.name]: e.target.checked })} /> save to Answers</label>
                    : <small>{c.why}</small>}</td>
                </tr>))}</tbody></table>
              <button disabled={!!status} onClick={() => run('Accepting your changes', async () => {
                const r = await window.api.acceptChanges(fill.changed.map((c) => c.name), fill.changed.filter((c) => c.saveable && (saveSel[c.name] ?? true)).map((c) => c.name))
                setFill(r.result); setSaveSel({})
                setNote(r.saved ? `Accepted. ${r.saved} answer(s) saved to the Answers tab.` : 'Accepted.')
              })}>Accept changes{fill.changed.some((c) => c.saveable) ? ' & save to Answers' : ''}</button>
            </div>
          )}
          {(() => {
            const soft = fill.mismatches.filter((m) => /could not be checked automatically/.test(m))
            const hard = fill.mismatches.filter((m) => !soft.includes(m))
            return (
              <>
                <h4>Verification: {fill.mismatches.length === 0 ? 'every value was read back from the page and matches' : `${hard.length} wrong, ${soft.length} not checkable`}</h4>
                {hard.length > 0 && <div className="stopbox"><b>These are wrong on the page.</b> Fix each one in the open browser window, then press Re-verify:
                  <ul className="tight">{hard.map((m, i) => <li key={i} className="error">{m}</li>)}</ul></div>}
                {soft.length > 0 && <div className="stopbox"><b>The app could not read these back itself</b> (the page changed how it shows them, for example after a file upload). Look at the open browser window and confirm they are right:
                  <ul className="tight">{soft.map((m, i) => <li key={i}>{m}</li>)}</ul>
                  <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I checked these in the browser window and they are correct</label></div>}
              </>
            )
          })()}
          {fill.missingFields.length > 0 && <p className="warn">Not on the live page, skipped: {fill.missingFields.join(', ')}</p>}
          {fill.challenge && <p className="warn">A CAPTCHA is visible. Solve it yourself in the browser window.</p>}
          <img className="shot" src={fill.screenshot} alt="Filled form" />
          {note && <p className="status">{note}</p>}
          <p>Review the open browser window. If you correct anything there, press Re-verify: the app notices your edits and offers to save them to your Answers. Then:</p>
          <button onClick={() => run('Re-verifying', async () => setFill(await window.api.applyReverify()))}>Re-verify</button>{' '}
          <button disabled={fill.changed.length > 0 || fill.mismatches.some((m) => !/could not be checked automatically/.test(m)) || (fill.mismatches.length > 0 && !ack) || !!status} onClick={() => {
            if (!window.confirm(`This will submit your application to ${company || 'this company'}. Continue?`)) return
            run('Submitting', async () => setSub(await window.api.applySubmit(ack)))
          }}>Submit application</button>{' '}
          <button onClick={() => run('Closing', async () => { await window.api.applyClose(); setFill(null) })}>Cancel and close browser</button>
        </>
      )}

      {sub && (
        <p className={sub.status === 'submitted' ? '' : 'warn'}><b>{sub.status}</b>: {sub.note} {sub.confirmationUrl}
          {sub.status !== 'submitted' && <> <button onClick={() => run('Checking', async () => setSub(await window.api.applyCheck()))}>Check confirmation</button></>}
          {sub.status !== 'submitted' && /security code/i.test(sub.note) && <> <button disabled={!!status} onClick={() => run('Looking for the code in your inbox (up to 2 minutes)', async () => setSub(await window.api.applyCode()))}>Look for the code in my email</button></>}
          {sub.screenshot && <img className="shot" src={sub.screenshot} alt="Confirmation" />}</p>
      )}
    </div>
  )
}
