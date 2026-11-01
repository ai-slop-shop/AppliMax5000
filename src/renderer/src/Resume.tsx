import { useEffect, useRef, useState } from 'react'
import { registerFlush } from './flush'
import type { Experience, ParseIssue, Resume } from '../../shared/resume'

const blankRole = (): Experience => ({ employer: '', title: '', start: '', end: '', location: '', isSideProject: false, peopleManaged: null, bullets: [] })

export function ResumeWorkbench({ initial }: { initial?: Resume }) {
  const [r, setR] = useState<Resume | null>(initial ?? null)
  const [plain, setPlain] = useState('')
  const [issues, setIssues] = useState<{ path: string; list: ParseIssue[] } | null>(null)
  const [status, setStatus] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  useEffect(() => { window.api.hasResumeUndo().then(setCanUndo) }, [])

  const latest = useRef<Resume | null>(initial ?? null)
  const dirty = useRef(false)
  const saveNow = async (): Promise<void> => {
    if (!dirty.current || !latest.current) return
    dirty.current = false
    try { await window.api.saveResume(latest.current) } catch { dirty.current = true }
  }

  useEffect(() => { if (!initial) window.api.loadResume().then((x) => { latest.current = x; setR(x) }) }, [initial])
  // Autosave 800ms after the last edit, on window hide / quit, and when leaving this tab.
  useEffect(() => {
    const t = setTimeout(saveNow, 800)
    return () => clearTimeout(t)
  }, [r])
  useEffect(() => {
    const off = registerFlush(saveNow)
    return () => { off(); void saveNow() }
  }, [])
  useEffect(() => { if (r) window.api.plainText(r).then(setPlain).catch(() => {}) }, [r])
  if (!r) return <p>Loading…</p>

  const set = (fn: (d: Resume) => void): void => { const d = structuredClone(r); fn(d); dirty.current = true; latest.current = d; setR(d) }
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setStatus(label + '…')
    try { await fn(); setStatus('') } catch (e) { setStatus(String((e as Error).message ?? e)) }
  }
  const unverified = r.experience.flatMap((x) => x.bullets).filter((b) => !b.verified).length

  return (
    <div className="cols">
      <div className="col">
        <div className="bar">
          <button onClick={() => run('Saving', async () => { dirty.current = false; await window.api.saveResume(r); setStatus('Saved') })}>Save</button>
          {(['docx', 'pdf'] as const).map((f) => (
            <button key={f} onClick={() => run('Exporting', async () => {
              setR(await window.api.saveResume(r))
              const res = await window.api.exportResume(f)
              if (res) setIssues({ path: res.path, list: res.issues })
            })}>Export .{f}</button>
          ))}
          {canUndo && <button onClick={() => {
            if (!window.confirm('Restore the resume as it was before the last AI rewrite? Edits you made since then will be replaced.')) return
            run('Restoring', async () => { dirty.current = false; const x = await window.api.undoResumeRewrite(); latest.current = x; setR(x); setCanUndo(false); setStatus('Restored') })
          }}>Undo last AI rewrite</button>}
          <span className="status">{status || 'Changes save automatically'}</span>
        </div>
        {unverified > 0 && <p className="warn">{unverified} bullet(s) not yet marked verified. Check each against your real history.</p>}

        <h3>Contact</h3>
        {(['name', 'email', 'phone', 'city', 'state', 'linkedin'] as const).map((k) => (
          <label key={k} className="row"><span>{k}</span>
            <input value={r.contact[k]} onChange={(e) => set((d) => { d.contact[k] = e.target.value })} /></label>
        ))}

        <h3>Summary</h3>
        <textarea rows={4} value={r.summary} onChange={(e) => set((d) => { d.summary = e.target.value })} />

        <h3>Experience</h3>
        {r.experience.map((x, i) => (
          <fieldset key={i}>
            {(['employer', 'title', 'start', 'end'] as const).map((k) => (
              <label key={k} className="row"><span>{k}</span>
                <input value={x[k]} onChange={(e) => set((d) => { d.experience[i][k] = e.target.value })} /></label>
            ))}
            <label className="row"><span>side project</span>
              <input type="checkbox" checked={x.isSideProject} onChange={(e) => set((d) => { d.experience[i].isSideProject = e.target.checked })} /></label>
            <label className="row"><span>people managed</span>
              <input type="number" value={x.peopleManaged ?? ''} onChange={(e) => set((d) => { d.experience[i].peopleManaged = e.target.value === '' ? null : Number(e.target.value) })} /></label>
            {x.bullets.map((b, j) => (
              <div key={j} className="bullet">
                <input type="checkbox" title="Verified true" checked={b.verified} onChange={(e) => set((d) => { d.experience[i].bullets[j].verified = e.target.checked })} />
                <textarea rows={2} value={b.text} onChange={(e) => set((d) => { d.experience[i].bullets[j] = { text: e.target.value, verified: false } })} />
                <button onClick={() => set((d) => { d.experience[i].bullets.splice(j, 1) })}>×</button>
              </div>
            ))}
            <button onClick={() => set((d) => { d.experience[i].bullets.push({ text: '', verified: false }) })}>+ bullet</button>
            <button onClick={() => set((d) => { d.experience.splice(i, 1) })}>Remove role</button>
          </fieldset>
        ))}
        <button onClick={() => set((d) => { d.experience.push(blankRole()) })}>+ role</button>

        <h3>Skills (comma separated)</h3>
        <textarea rows={2} value={r.skills.join(', ')} onChange={(e) => set((d) => { d.skills = e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />

        <h3>Education</h3>
        {r.education.map((e, i) => (
          <div key={i} className="row">
            {(['school', 'degree', 'field', 'end'] as const).map((k) => (
              <input key={k} placeholder={k} value={e[k]} onChange={(ev) => set((d) => { d.education[i][k] = ev.target.value })} />
            ))}
            <button onClick={() => set((d) => { d.education.splice(i, 1) })}>×</button>
          </div>
        ))}
        <button onClick={() => set((d) => { d.education.push({ school: '', degree: '', field: '', end: '' }) })}>+ education</button>
      </div>

      <div className="col">
        {issues && (
          <div className="issues">
            <h3>Parse check: {issues.list.length === 0 ? 'clean' : `${issues.list.length} issue(s)`}</h3>
            <small>{issues.path}</small>
            <ul>{issues.list.map((i, k) => <li key={k} className={i.severity}>{i.severity}: {i.message}</li>)}</ul>
          </div>
        )}
        <h3>What a screening tool sees</h3>
        <pre>{plain}</pre>
      </div>
    </div>
  )
}
