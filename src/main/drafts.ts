import { getDb } from './db'
import type { DraftSummary, PostingInput, TailoredDraft } from '../shared/tailor'

type Row = { id: number; job_id: number; json: string; approved: number; created_at: string }
const hydrate = (row: Row): TailoredDraft => {
  const j = JSON.parse(row.json)
  return { ...j, variant: j.variant ?? 'tailored', excludedFromExperiment: !!j.excludedFromExperiment, id: row.id, jobId: row.job_id, approved: !!row.approved, createdAt: row.created_at }
}

export function saveNewDraft(d: Omit<TailoredDraft, 'id' | 'jobId' | 'approved' | 'createdAt'>): TailoredDraft {
  const db = getDb()
  const p: PostingInput = d.posting
  const url = p.url.trim() || `manual:${Date.now()}`
  db.prepare(`INSERT INTO jobs (url, title, company, posting_text, status) VALUES (?, ?, ?, ?, 'drafted')
    ON CONFLICT(url) DO UPDATE SET title=excluded.title, company=excluded.company, posting_text=excluded.posting_text, status='drafted'`)
    .run(url, p.title, p.company, p.text)
  const jobId = (db.prepare('SELECT id FROM jobs WHERE url = ?').get(url) as { id: number }).id
  const info = db.prepare('INSERT INTO drafts (job_id, json) VALUES (?, ?)').run(jobId, JSON.stringify(d))
  const id = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO experiments (draft_id, job_id, variant, excluded) VALUES (?, ?, ?, ?)').run(id, jobId, d.variant, d.excludedFromExperiment ? 1 : 0)
  return getDraft(id)
}

export function getDraft(id: number): TailoredDraft {
  const row = getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined
  if (!row) throw new Error('Draft not found')
  return hydrate(row)
}

export function listDrafts(): DraftSummary[] {
  const rows = getDb().prepare('SELECT * FROM drafts ORDER BY id DESC').all() as Row[]
  return rows.map(hydrate).map((d) => ({
    id: d.id, title: d.posting.title, company: d.posting.company, approved: d.approved, createdAt: d.createdAt, variant: d.variant,
    flagged: d.claims.filter((c) => c.status === 'unsourced' || c.status === 'unsupported').length
  }))
}

/** Persist user edits (cover letter, tailored resume, claim statuses). */
export function updateDraft(d: TailoredDraft): TailoredDraft {
  const { id, jobId, approved, createdAt, ...rest } = d
  void jobId; void approved; void createdAt
  getDb().prepare('UPDATE drafts SET json = ? WHERE id = ?').run(JSON.stringify(rest), id)
  return getDraft(id)
}

export function approveDraft(id: number): TailoredDraft {
  const db = getDb()
  const d = getDraft(id)
  db.prepare('UPDATE drafts SET approved = 1 WHERE id = ?').run(id)
  db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(d.jobId)
  return getDraft(id)
}

/**
 * Delete a draft and what only existed because of it (its experiment slot and any attempt that never went out). A draft that
 * was submitted is the record of what was sent, so it stays. The job goes back to the queue, or is removed if it was pasted in by hand.
 */
export function deleteDraft(id: number): DraftSummary[] {
  const db = getDb()
  const d = getDraft(id)
  const sent = db.prepare("SELECT 1 FROM applications WHERE draft_id = ? AND attempt_status = 'submitted'").get(id)
  if (sent) throw new Error('This draft was submitted, so it is kept as the record of what was sent.')
  db.transaction(() => {
    db.prepare('DELETE FROM applications WHERE draft_id = ?').run(id)
    db.prepare('DELETE FROM experiments WHERE draft_id = ?').run(id)
    db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
    const others = db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE job_id = ?').get(d.jobId) as { n: number }
    if (!others.n) {
      const job = db.prepare('SELECT url, board_id FROM jobs WHERE id = ?').get(d.jobId) as { url: string; board_id: number | null } | undefined
      if (job && job.board_id == null) db.prepare("DELETE FROM jobs WHERE id = ? AND status IN ('drafted','queued')").run(d.jobId)
      else db.prepare("UPDATE jobs SET status = CASE WHEN fit_score IS NULL THEN 'new' ELSE 'scored' END WHERE id = ? AND status IN ('drafted','queued')").run(d.jobId)
    }
  })()
  return listDrafts()
}
