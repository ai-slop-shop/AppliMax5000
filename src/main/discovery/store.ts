import type { Ats, Board, DraftSeed, JobBlocker, JobRow } from '../../shared/discovery'
import { getDb } from '../db'
import { findPrior } from '../history'
import { adapterByName } from '../automation/registry'
import { pruneExcludedQuestions } from '../questions'
import { getCriteria } from './criteria'
import { prefilter } from './filter'
import { fetchBoard, isLive, parseBoardUrl, type RawJob } from './sources'

const db = () => getDb()

export function listBoards(): Board[] {
  return (db().prepare('SELECT * FROM boards ORDER BY name COLLATE NOCASE').all() as (Omit<Board, 'enabled'> & { enabled: number })[])
    .map((b) => ({ ...b, enabled: !!b.enabled }))
}

/** Accepts any board or posting URL from Greenhouse, Lever or Ashby. Verifies it exists before saving. */
export async function addBoard(url: string, source: 'manual' | 'suggested' | 'search' = 'manual'): Promise<Board[]> {
  const p = parseBoardUrl(url.trim())
  if (!p) throw new Error('Paste a Greenhouse, Lever or Ashby board URL (e.g. https://job-boards.greenhouse.io/<company>).')
  const { company, jobs } = await fetchBoard(p.ats, p.token)
  db().prepare('INSERT INTO boards (ats, token, name, job_count, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ats, token) DO UPDATE SET enabled = 1')
    .run(p.ats, p.token, company, jobs.length, source)
  return listBoards()
}
export function removeBoard(id: number): Board[] {
  db().prepare('DELETE FROM boards WHERE id = ?').run(id)
  return listBoards()
}
export function toggleBoard(id: number, enabled: boolean): Board[] {
  db().prepare('UPDATE boards SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return listBoards()
}

type Row = Record<string, unknown> & { id: number; ats: Ats | null }
const parse = <T>(s: unknown, d: T): T => { try { return s ? JSON.parse(s as string) as T : d } catch { return d } }

export function listJobs(filter: 'active' | 'applied' | 'skipped' | 'all'): JobRow[] {
  const where = filter === 'active' ? "WHERE j.status IN ('new','scored','needs_user','drafted','queued')"
    : filter === 'applied' ? "WHERE j.status = 'submitted'" : filter === 'skipped' ? "WHERE j.status = 'skipped'" : ''
  const rows = db().prepare(`SELECT j.*, b.ats AS b_ats,
    (SELECT MAX(submitted_at) FROM applications WHERE job_id = j.id AND attempt_status = 'submitted') AS app_at,
    (SELECT applied_at FROM past_applications WHERE job_id = j.id ORDER BY id DESC LIMIT 1) AS past_at,
    EXISTS (SELECT 1 FROM past_applications WHERE job_id = j.id) AS is_manual
    FROM jobs j LEFT JOIN boards b ON b.id = j.board_id ${where}
    ORDER BY (j.fit_score IS NULL), j.fit_score DESC, j.first_seen_at DESC LIMIT 500`).all() as (Row & { b_ats: Ats | null; app_at: string | null; past_at: string | null; is_manual: number })[]
  const list = rows.map((r): JobRow => ({
    id: r.id, company: String(r.company ?? ''), title: String(r.title ?? ''), url: String(r.url), ats: r.b_ats,
    location: String(r.location ?? ''), work_mode: (r.work_mode as string) ?? null,
    pay_min: (r.pay_min as number) ?? null, pay_max: (r.pay_max as number) ?? null, pay_note: String(r.pay_note ?? ''),
    status: String(r.status), skip_reason: (r.skip_reason as string) ?? null, fit_score: (r.fit_score as number) ?? null,
    reasons: parse<string[]>(r.reasons, []), stretch_notes: String(r.stretch_notes ?? ''), blockers: parse<JobBlocker[]>(r.blockers, []),
    posted_at: (r.posted_at as string) ?? null, first_seen_at: (r.first_seen_at as string) ?? null, autoApply: !!adapterByName(r.b_ats),
    applied_at: r.status === 'submitted' ? (r.is_manual ? r.past_at : r.app_at)?.slice(0, 10) ?? null : null,
    applied_via: r.status !== 'submitted' ? null : r.is_manual ? 'manual' : 'app'
  }))
  return filter === 'applied' ? list.sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? '')) : list
}

export function skipJob(id: number, reason: string): void {
  db().prepare("UPDATE jobs SET status = 'skipped', skip_reason = ? WHERE id = ? AND status != 'submitted'").run(`user: ${reason || 'skipped'}`, id)
}
export function restoreJob(id: number): void {
  db().prepare("UPDATE jobs SET status = CASE WHEN fit_score IS NULL THEN 'new' ELSE 'scored' END, skip_reason = NULL WHERE id = ?").run(id)
}

/**
 * After the criteria change: forget automatic skips so they are re-evaluated on the next run (jobs that now pass come back),
 * and right away hide every queued job the new criteria rule out. User skips, applied jobs and drafts are kept.
 * Returns how many queued jobs were hidden.
 */
export function resetAutoSkips(): number {
  db().prepare(`DELETE FROM jobs WHERE status = 'skipped' AND skip_reason LIKE 'auto:%'
    AND id NOT IN (SELECT job_id FROM applications) AND id NOT IN (SELECT job_id FROM drafts)`).run()
  const c = getCriteria()
  const rows = db().prepare("SELECT id, company, title, location, work_mode, pay_min, pay_max, posted_at FROM jobs WHERE status IN ('new','scored','needs_user','queued') AND id NOT IN (SELECT job_id FROM drafts)").all() as
    { id: number; company: string; title: string; location: string | null; work_mode: string | null; pay_min: number | null; pay_max: number | null; posted_at: string | null }[]
  let n = 0
  for (const r of rows) {
    const reason = prefilter({ company: r.company ?? '', title: r.title ?? '', location: r.location ?? '', workMode: r.work_mode as RawJob['workMode'], payMin: r.pay_min, payMax: r.pay_max, postedAt: r.posted_at } as RawJob, c)
    if (reason) { db().prepare("UPDATE jobs SET status = 'skipped', skip_reason = ? WHERE id = ?").run(reason, r.id); n++ }
  }
  pruneExcludedQuestions()
  return n
}

/** Verify the posting is live on the employer's board, then hand back what the Review screen needs. */
export async function seedDraft(id: number): Promise<DraftSeed> {
  const j = db().prepare(`SELECT j.*, b.ats AS b_ats, b.token AS b_token FROM jobs j LEFT JOIN boards b ON b.id = j.board_id WHERE j.id = ?`)
    .get(id) as (Row & { b_ats: Ats | null; b_token: string | null }) | undefined
  if (!j) throw new Error('Job not found')
  if (j.status === 'submitted') throw new Error('You already applied to this job. It is in your Applied folder.')
  const prior = findPrior({ url: String(j.url), company: String(j.company ?? ''), title: String(j.title ?? '') })
  if (prior) {
    db().prepare("UPDATE jobs SET status = 'skipped', skip_reason = ? WHERE id = ? AND status != 'submitted'").run(`auto: ${prior.reason}`, id)
    throw new Error(prior.message)
  }
  if (j.b_ats && j.b_token && j.external_id && !(await isLive(j.b_ats, j.b_token, String(j.external_id)))) {
    db().prepare("UPDATE jobs SET status = 'skipped', skip_reason = 'auto: closed (no longer on the employer board)' WHERE id = ?").run(id)
    throw new Error('This posting is no longer live on the employer\'s board. It has been removed from your queue.')
  }
  return { url: String(j.url), title: String(j.title ?? ''), company: String(j.company ?? ''), text: String(j.posting_text ?? '') }
}
