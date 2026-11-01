import { useEffect, useState, type ReactElement } from 'react'
import { Apply } from './Apply'
import type { Claim, DraftSummary, TailoredDraft } from '../../shared/tailor'

const blank = { url: '', title: '', company: '', text: '' }

export function Review() {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [d, setD] = useState<TailoredDraft | null>(null)
  const [form, setForm] = useState<typeof blank>(() => {
    try { return { ...blank, ...JSON.parse(localStorage.getItem('reviewForm') ?? '{}') } } catch { return blank }
  })
  useEffect(() => { localStorage.setItem('reviewForm', JSON.stringify(form)) }, [form])
  const [status, setStatus] = useState('')
  const [sel, setSel] = useState<string | null>(null)

  const refresh = (): void => { window.api.listDrafts().then(setDrafts) }
  useEffect(refresh, [])
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setStatus(label + '…')
    try { await fn(); setStatus('') } catch (e) { setStatus(String((e as Error).message ?? e)) }
  }

  const claim = (id: string | null): Claim | undefined => d?.claims.find((c) => c.id === id)
  const src = (id: string): string => d?.sources.find((s) => s.id === id)?.text ?? `(unknown ${id})`
  const flagged = d ? d.claims.filter((c) => c.status === 'unsourced' || c.status === 'unsupported').length : 0
  const selected = claim(sel)

  const edit = (fn: (x: TailoredDraft) => void): void => { if (!d) return; const n = structuredClone(d); fn(n); setD(n) }
  const markEdited = (x: TailoredDraft, id: string | null): void => {
    const c = x.claims.find((k) => k.id === id)
    if (c) { c.status = 'edited'; c.note = 'Edited by you after validation.' }
  }

  const isFlag = (c?: Claim): boolean => c?.status === 'unsourced' || c?.status === 'unsupported'
  const firstFlag = (): void => {
    const c = d?.claims.find(isFlag)
    if (c) document.getElementById(`claim-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  /** "I checked this and it is true": the claim stays, marked as reviewed by you. */
  const keep = (id: string): void => edit((x) => { const c = x.claims.find((k) => k.id === id); if (c) { c.status = 'edited'; c.note = 'You reviewed this and kept it.' } })
  const setBullet = (i: number, n: number, text: string): void => edit((x) => { x.resume.experience[i].bullets[n].text = text; markEdited(x, `bullet:${i}.${n}`) })
  /** Delete a bullet and shift the later bullets' claim ids so they still point at the right text. */
  const removeBullet = (i: number, n: number): void => edit((x) => {
    x.resume.experience[i].bullets.splice(n, 1)
    x.claims = x.claims.filter((c) => c.id !== `bullet:${i}.${n}`).map((c) => {
      const m = c.id.match(/^bullet:(\d+)\.(\d+)$/)
      return m && Number(m[1]) === i && Number(m[2]) > n ? { ...c, id: `bullet:${i}.${Number(m[2]) - 1}` } : c
    })
  })
  /** Put back the original, verified bullet this one was written from. */
  const originalOf = (id: string): string | null => {
    const sid = claim(id)?.sourceIds.find((s) => s.startsWith('bullet:'))
    return sid ? d?.sources.find((s) => s.id === sid)?.text ?? null : null
  }
  const useOriginal = (i: number, n: number): void => {
    const id = `bullet:${i}.${n}`, orig = originalOf(id)
    if (!orig) return
    edit((x) => { x.resume.experience[i].bullets[n].text = orig; const c = x.claims.find((k) => k.id === id); if (c) { c.status = 'ok'; c.note = 'Restored to your original wording.' } })
  }
  const clearSummary = (): void => edit((x) => { x.resume.summary = ''; x.claims = x.claims.filter((c) => c.id !== 'summary') })
  const removePara = (idx: number): void => edit((x) => { const id = x.coverLetter[idx].claimId; x.coverLetter.splice(idx, 1); if (id) x.claims = x.claims.filter((c) => c.id !== id) })

  /** The reason a claim is flagged, shown right under it, with what to do about it. */
  const Flag = ({ c }: { c?: Claim }): ReactElement | null => !isFlag(c) ? null : (
    <div className="flagmsg">
      <b>⚑ Flagged:</b> {c!.status === 'unsourced' ? 'this cites nothing from your resume or facts.' : 'your sources do not back this up.'} {c!.note}
      <br /><small>Fix the wording, put back your original, remove it, or keep it if you know it is true.</small>
    </div>
  )
  const Acts = ({ id, onRemove, original }: { id: string | null; onRemove: () => void; original?: () => void }): ReactElement => (
    <div className="claimacts">
      {original && <button onClick={original}>Use my original</button>}
      {id && isFlag(claim(id)) && <button onClick={() => keep(id)}>Keep anyway</button>}
      <button onClick={onRemove}>Remove</button>
    </div>
  )
  const rows = (t: string, w: number): number => Math.max(2, Math.ceil(t.length / w))

  return (
    <>
    {d?.approved && <Apply key={d.id} draftId={d.id} company={d.posting.company} />}
    <div className="cols">
      <div className="col narrow">
        <h3>New draft</h3>
        {(['title', 'company', 'url'] as const).map((k) => (
          <input key={k} placeholder={k === 'url' ? 'posting URL (optional)' : k} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        ))}
        <textarea rows={10} placeholder="Paste the full job posting text" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
        <button disabled={!form.text.trim() || !form.title.trim() || !!status} onClick={() => run('Drafting and validating (can take a minute)', async () => {
          const nd = await window.api.generateDraft(form); setD(nd); setSel(null); refresh()
        })}>Generate draft</button>
        <div className="status">{status}</div>
        <h3>Drafts</h3>
        <ul className="plain">
          {drafts.map((x) => (
            <li key={x.id}><a href="#" onClick={async (e) => { e.preventDefault(); setD(await window.api.getDraft(x.id)); setSel(null) }}>
              {x.company || '?'}: {x.title}</a> {x.variant === 'control' ? <small>[control]</small> : null} {x.approved ? '✓' : x.flagged ? `⚠ ${x.flagged}` : ''} <a href="#" title="Delete this draft" onClick={async (e) => {
              e.preventDefault()
              if (!window.confirm(`Delete the draft for ${x.company || x.title}?`)) return
              try { setDrafts(await window.api.deleteDraft(x.id)); if (d?.id === x.id) { setD(null); setSel(null) }; setStatus('') } catch (err) { setStatus(String((err as Error).message ?? err)) }
            }}>delete</a></li>
          ))}
        </ul>
      </div>

      {d ? (
        <>
          <div className="col">
            <div className="bar">
              <strong>{d.posting.title}, {d.posting.company}</strong>
              <button onClick={() => run('Saving', async () => setD(await window.api.updateDraft(d)))}>Save edits</button>
              <button disabled={d.approved} onClick={() => {
                if (flagged > 0 && !window.confirm(`${flagged} flagged claim(s) are still unresolved. Approve anyway?`)) return
                run('Approving', async () => { setD(await window.api.approveDraft((await window.api.updateDraft(d)).id)); refresh() })
              }}>
                {d.approved ? 'Approved' : 'Approve'}</button>
              <button onClick={() => run('Exporting', async () => { await window.api.updateDraft(d); await window.api.exportResume('docx', d.id) })}>Resume .docx</button>
              <button onClick={() => run('Exporting', async () => { await window.api.updateDraft(d); await window.api.exportResume('pdf', d.id) })}>Resume .pdf</button>
            </div>
            {!d.approved && (
              <p className="issues"><b>Next step:</b> check the draft below, then press <b>Approve</b>. Approving unlocks the application form: it fills in your profile, saved answers and suggested answers, and shows you exactly where each one came from.</p>
            )}
            {d.variant === 'control' && (
              <p className="warn"><b>CONTROL group.</b> This application uses your master resume as is, with no cover letter, so the experiment can measure tailoring.{' '}
                <button disabled={!!status} onClick={() => run('Tailoring', async () => { const nd = await window.api.generateDraft(d.posting, { forceTailored: true }); setD(nd); refresh() })}>Tailor this one anyway</button>
                <small> (it will not count in the experiment)</small></p>
            )}
            {d.excludedFromExperiment && <p><small>This draft is outside the experiment.</small></p>}
            {d.warnings.map((w, i) => <p key={i} className="warn">{w}</p>)}
            <div className="issues keybox">
              <b>How to read this draft.</b> Every statement below must trace back to your resume or confirmed facts.
              <div><span className="swatch ok" /> backed by your material <span className="swatch bad" /> <b>flagged</b>: not backed up, or it cites nothing <span className="swatch edit" /> you edited or kept it</div>
              {flagged > 0
                ? <div className="error"><b>{flagged} flagged.</b> Each one shows why, with buttons to fix it: edit the text, <i>Use my original</i>, <i>Remove</i>, or <i>Keep anyway</i> if you know it is true. <a href="#" onClick={(e) => { e.preventDefault(); firstFlag() }}>Jump to the first one</a></div>
                : <div className="status">Nothing flagged. Click any text to see which of your facts it came from.</div>}
            </div>

            {d.gaps.length > 0 && (<><h3>Gaps</h3><ul>{d.gaps.map((g, i) => <li key={i}><b>{g.requirement}</b>: {g.statement}</li>)}</ul></>)}

            <h3>Summary</h3>
            {d.resume.summary || claim('summary') ? (
              <div id="claim-summary" className={`claimbox ${claim('summary')?.status ?? ''}`}>
                <textarea rows={rows(d.resume.summary, 70)} value={d.resume.summary} onFocus={() => setSel('summary')}
                  onChange={(e) => edit((x) => { x.resume.summary = e.target.value; markEdited(x, 'summary') })} />
                <Flag c={claim('summary')} />
                <Acts id="summary" onRemove={clearSummary} />
              </div>
            ) : <p><small>No summary in this draft.</small></p>}

            <h3>Experience: tailored vs master</h3>
            {d.resume.experience.map((x, i) => {
              const master = (d.sources.filter((s) => s.kind === 'bullet' && s.id.startsWith(`bullet:${i}.`)))
              const used = new Set<string>()
              return (
                <fieldset key={i}>
                  <legend>{x.employer}, {x.title}</legend>
                  {x.bullets.map((b, n) => {
                    const c = claim(`bullet:${i}.${n}`)
                    const same = master.some((m) => m.text === b.text)
                    c?.sourceIds.forEach((s) => used.add(s))
                    const id = `bullet:${i}.${n}`
                    const orig = originalOf(id)
                    return (
                      <div key={id} id={`claim-${id}`} className={`claimbox ${c?.status ?? ''}`}>
                        <textarea rows={rows(b.text, 70)} value={b.text} onFocus={() => setSel(id)} onChange={(e) => setBullet(i, n, e.target.value)} />
                        <small>{same ? 'your original wording' : 'reworded'}</small>
                        <Flag c={c} />
                        <Acts id={id} onRemove={() => removeBullet(i, n)} original={orig && orig !== b.text ? () => useOriginal(i, n) : undefined} />
                      </div>
                    )
                  })}
                  {master.filter((m) => !used.has(m.id)).map((m) => <p key={m.id} className="dropped">• {m.text} <small>(not used)</small></p>)}
                </fieldset>
              )
            })}
            {d.resume.skills.length > 0 && (<><h3>Skills</h3><p>{d.resume.skills.join(', ')}</p></>)}
          </div>

          <div className="col">
            <h3>Cover letter <button onClick={() => navigator.clipboard.writeText(d.coverLetter.map((p) => p.text).join('\n\n'))}>Copy</button></h3>
            {d.coverLetter.map((p, i) => (
              <div key={p.claimId ?? `p${i}`} id={p.claimId ? `claim-${p.claimId}` : undefined} className={`claimbox ${claim(p.claimId)?.status ?? ''}`}>
                <textarea rows={rows(p.text, 60)} value={p.text} onFocus={() => setSel(p.claimId)}
                  onChange={(e) => edit((x) => { x.coverLetter[i].text = e.target.value; markEdited(x, p.claimId) })} />
                <Flag c={claim(p.claimId)} />
                <Acts id={p.claimId} onRemove={() => removePara(i)} />
              </div>
            ))}
            <h3>Source panel</h3>
            {selected ? (
              <div className="issues">
                <p><b>{selected.status}</b>{selected.note && `: ${selected.note}`}</p>
                <p>"{selected.text}"</p>
                <ul>{selected.sourceIds.map((s) => <li key={s}><code>{s}</code> {src(s)}</li>)}</ul>
              </div>
            ) : <p>Click a claim to see which source rows it cites.</p>}
          </div>
        </>
      ) : <div className="col"><p>Paste a posting and generate a draft, or open a saved one.</p></div>}
    </div>
    </>
  )
}
