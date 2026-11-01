import { useEffect, useState } from 'react'
import type { Story } from '../../shared/tailor'

export function Stories() {
  const [stories, setStories] = useState<Story[]>([])
  const [draft, setDraft] = useState<Record<number, Story>>({})
  const [n, setN] = useState({ title: '', body: '', tags: '' })
  useEffect(() => { window.api.listStories().then(setStories) }, [])

  const save = async (s: Story): Promise<void> => {
    setStories(await window.api.saveStory(s))
    setDraft((d) => { const { [s.id]: _, ...rest } = d; return rest })
  }
  return (
    <>
      <p>Short, true stories in your own words: a time you showed courage, the best engineer you worked with, a hard decision, a project you are proud of. Essay questions are drafted <b>only</b> from these (plus your confirmed facts). If none fits a question, the app leaves it blank for you rather than inventing one.</p>
      <div className="qcard">
        <input value={n.title} placeholder="Title, e.g. Shipping the tools pipeline under a deadline" onChange={(e) => setN({ ...n, title: e.target.value })} style={{ width: '100%' }} />
        <textarea rows={5} value={n.body} placeholder="What happened, what you did, how it turned out. Specifics and real numbers only." onChange={(e) => setN({ ...n, body: e.target.value })} />
        <div className="row">
          <input value={n.tags} placeholder="tags (optional): leadership, conflict, failure, mentoring…" onChange={(e) => setN({ ...n, tags: e.target.value })} />
          <button disabled={!n.body.trim()} onClick={async () => { setStories(await window.api.saveStory({ id: 0, ...n })); setN({ title: '', body: '', tags: '' }) }}>Add story</button>
        </div>
      </div>
      {stories.length === 0 && <p>No stories yet.</p>}
      {stories.map((s) => {
        const v = draft[s.id] ?? s
        const set = (patch: Partial<Story>): void => setDraft({ ...draft, [s.id]: { ...v, ...patch } })
        const dirty = draft[s.id] !== undefined
        return (
          <div key={s.id} className="qcard answered">
            <input value={v.title} style={{ width: '100%', fontWeight: 600 }} onChange={(e) => set({ title: e.target.value })} />
            <textarea rows={Math.max(3, Math.ceil(v.body.length / 90))} value={v.body} onChange={(e) => set({ body: e.target.value })} />
            <div className="row">
              <input value={v.tags} placeholder="tags" onChange={(e) => set({ tags: e.target.value })} />
              <button disabled={!dirty} onClick={() => save(v)}>Save</button>
              <button onClick={async () => setStories(await window.api.removeStory(s.id))}>Delete</button>
            </div>
          </div>
        )
      })}
    </>
  )
}
