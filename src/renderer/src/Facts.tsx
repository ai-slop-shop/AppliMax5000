import { useEffect, useState } from 'react'
import type { Fact } from '../../shared/tailor'

const clean = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Facts() {
  const [facts, setFacts] = useState<Fact[]>([])
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<Record<number, string>>({}) // unsaved edits per fact
  const [status, setStatus] = useState('')
  useEffect(() => { window.api.listFacts().then(setFacts) }, [])

  const unconfirmed = facts.filter((f) => !f.confirmed).length
  const save = async (f: Fact, nextText: string, confirmed: boolean): Promise<void> => {
    setFacts(await window.api.updateFact(f.id, nextText, confirmed))
    setDraft((d) => { const { [f.id]: _, ...rest } = d; return rest })
  }

  return (
    <>
      <p>Facts the tailoring engine may use beyond your resume bullets (for example "2 years people management at Rainbow Studios"). <b>Only confirmed facts are used.</b> Generated facts start unconfirmed: edit them until they are exactly true, then tick the box.</p>
      <div className="bar">
        <button disabled={!!status} onClick={async () => {
          setStatus('Reading your resume…')
          try {
            const r = await window.api.generateFacts()
            setFacts(r.facts)
            setStatus(`Added ${r.added} fact(s)${r.dropped ? `; ${r.dropped} dropped because their evidence was not found in your resume` : ''}.`)
          } catch (e) { setStatus(clean(e)) }
        }}>Generate from my resume</button>
        <button disabled={unconfirmed === 0} onClick={async () => setFacts(await window.api.confirmAllFacts())}>Confirm all ({unconfirmed})</button>
        <span className="status">{status}</span>
      </div>
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a confirmed fact of your own" />
        <button disabled={!text.trim()} onClick={async () => { setFacts(await window.api.addFact(text)); setText('') }}>Add</button>
      </div>
      {facts.length === 0 && <p>No facts yet. Generate them from your resume, or add your own.</p>}
      {facts.map((f) => {
        const value = draft[f.id] ?? f.text
        return (
          <div key={f.id} className={`fact ${f.confirmed ? '' : 'unconfirmed'}`}>
            <input type="checkbox" title="Confirmed true: allow the engine to use it" checked={f.confirmed}
              onChange={(e) => save(f, value, e.target.checked)} />
            <div className="fbody">
              <textarea rows={Math.max(1, Math.ceil(value.length / 90))} value={value}
                onChange={(e) => setDraft({ ...draft, [f.id]: e.target.value })}
                onBlur={() => { if (draft[f.id] !== undefined && draft[f.id].trim() && draft[f.id] !== f.text) save(f, draft[f.id], f.confirmed) }} />
              {f.evidence && <small>From your resume: “{f.evidence}”</small>}
              {f.previous_text && <small>Rewritten by Claude. Before: “{f.previous_text}” <a href="#" onClick={async (e) => { e.preventDefault(); setFacts(await window.api.revertFact(f.id)) }}>Revert</a></small>}
            </div>
            <button title="Delete" onClick={async () => setFacts(await window.api.removeFact(f.id))}>×</button>
          </div>
        )
      })}
    </>
  )
}
