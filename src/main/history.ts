import { getDb } from './db'
import { getCriteria } from './discovery/criteria'
import { matchEmployer } from './employers'
import { loadResume } from './resumeStore'
import { parseGreenhouseUrl } from './automation/greenhouse'
import { parseLeverUrl } from './automation/lever'
import { parseAshbyUrl } from './automation/ashby'

export interface Prior {
  kind: 'same_job' | 'same_role' | 'previous_employer' | 'excluded_company'
  when: string; source: 'this app' | 'your past list' | 'your resume'
  message: string
  reason: string // short form used as the queue's skip reason
}

/** One canonical form per posting, whichever URL variant it was reached by. */
export function normalizeUrl(url: string): string {
  const u = url.trim()
  if (!u) return ''
  const gh = parseGreenhouseUrl(u); if (gh) return `greenhouse:${gh.board}/${gh.jobId}`.toLowerCase()
  const lv = parseLeverUrl(u); if (lv) return `lever:${lv.token}/${lv.id}`.toLowerCase()
  const ab = parseAshbyUrl(u); if (ab) return `ashby:${ab.token}/${ab.id}`.toLowerCase()
  try { const x = new URL(u); return `${x.hostname}${x.pathname}`.replace(/\/+$/, '').toLowerCase() } catch { return u.toLowerCase() }
}
const slug = (s: string): string => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
export const companyKey = (s: string): string => slug(s.replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\.?/gi, ''))

const FIX = ' If that is wrong, remove it from your past list in the Tracker.'
interface Rec { url: string; company: string; title: string; when: string; source: Prior['source'] }

// ---- previous employers (spec: do not apply where you have worked) ----
/** The employers on your resume (side projects excluded), including your current one. */
export { matchEmployer }
export function previousEmployers(): string[] {
  return [...new Set(loadResume().experience.filter((x) => !x.isSideProject).map((x) => x.employer.trim()).filter(Boolean))]
}


function records(): Rec[] {
  const db = getDb()
  const mine = db.prepare(`SELECT j.url, j.company, j.title, a.submitted_at AS w FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.attempt_status = 'submitted'`)
    .all() as { url: string; company: string; title: string; w: string | null }[]
  const past = db.prepare('SELECT url, company, title, applied_at AS w FROM past_applications').all() as { url: string; company: string; title: string; w: string | null }[]
  return [
    ...mine.map((r): Rec => ({ ...r, when: (r.w ?? '').slice(0, 10) || 'earlier', source: 'this app' })),
    ...past.map((r): Rec => ({ ...r, when: (r.w ?? '').slice(0, 10) || 'earlier', source: 'your past list' }))
  ]
}

/**
 * Build a matcher once and reuse it in a loop. A job matches if it is the same posting (any URL variant), or the same
 * title at the same company (a repost under a new id).
 */
export function historyMatcher(): (j: { url?: string; company?: string; title?: string }) => Prior | null {
  const recs = records().map((r) => ({ ...r, nu: normalizeUrl(r.url), ck: companyKey(r.company), tk: slug(r.title) }))
  const employers = previousEmployers()
  const crit = getCriteria()
  const allowed = crit.includeCompanies ?? []
  const never = crit.excludeCompanies ?? []
  return (j) => {
    if (j.company && never.length) {
      const n = matchEmployer(j.company, never)
      if (n) return { kind: 'excluded_company', when: '', source: 'your resume', reason: `excluded company (${n})`,
        message: `You asked the app never to apply to ${n}. Remove it from "Never apply to" on the Criteria tab to change that.` }
    }
    if (j.company && employers.length && !(allowed.length && matchEmployer(j.company, allowed))) {
      const e = matchEmployer(j.company, employers)
      if (e) return { kind: 'previous_employer', when: '', source: 'your resume', reason: `you worked there (${e})`,
        message: `You worked at ${e}, so the app will not apply to ${j.company}. To allow it, add the company to "Okay to re-apply" on the Criteria tab.` }
    }
    const nu = j.url ? normalizeUrl(j.url) : ''
    const ck = j.company ? companyKey(j.company) : '', tk = j.title ? slug(j.title) : ''
    for (const r of recs) {
      if (nu && r.nu && nu === r.nu) {
        return { kind: 'same_job', when: r.when, source: r.source, reason: `already applied (${r.source}, ${r.when})`, message: `You already applied to this job (${r.source}, ${r.when}).${r.source === 'your past list' ? FIX : ''}` }
      }
      if (ck && tk && r.ck === ck && r.tk === tk) {
        return { kind: 'same_role', when: r.when, source: r.source, reason: `already applied (${r.source}, ${r.when})`, message: `You already applied to "${r.title}" at ${r.company} (${r.source}, ${r.when}); this looks like the same role reposted.${r.source === 'your past list' ? FIX : ''}` }
      }
    }
    return null
  }
}
export const findPrior = (j: { url?: string; company?: string; title?: string }): Prior | null => historyMatcher()(j)

/** Skip anything in the queue that matches an application already made. Returns how many were skipped. */
export function applyHistoryToQueue(): number {
  const db = getDb()
  const match = historyMatcher()
  const rows = db.prepare("SELECT id, url, company, title FROM jobs WHERE status IN ('new','scored','needs_user','drafted','queued')").all() as { id: number; url: string; company: string; title: string }[]
  let n = 0
  for (const r of rows) {
    const p = match(r)
    if (!p) continue
    db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = ? WHERE id = ?").run(`auto: ${p.reason}`, r.id)
    n++
  }
  return n
}

// ---- the past list (applications made before this app, or elsewhere) ----

export interface PastApplication { id: number; company: string; title: string; url: string; applied_at: string | null; note: string }
export const listPast = (): PastApplication[] => getDb().prepare('SELECT * FROM past_applications ORDER BY id DESC').all() as PastApplication[]

export function addPast(p: { company: string; title: string; url: string; applied_at?: string; note?: string }): { list: PastApplication[]; skipped: number } {
  if (!p.company.trim() && !p.url.trim()) throw new Error('Enter a company or a posting URL.')
  getDb().prepare('INSERT INTO past_applications (company, title, url, applied_at, note) VALUES (?, ?, ?, ?, ?)')
    .run(p.company.trim(), p.title.trim(), p.url.trim(), p.applied_at?.trim() || null, p.note?.trim() ?? '')
  return { list: listPast(), skipped: applyHistoryToQueue() }
}
export function removePast(id: number): PastApplication[] {
  const db = getDb()
  db.prepare('DELETE FROM past_applications WHERE id = ?').run(id)
  // Jobs that were hidden only because of this record come back on the next discovery run.
  db.prepare(`DELETE FROM jobs WHERE status = 'skipped' AND skip_reason LIKE 'auto: already applied%'
    AND id NOT IN (SELECT job_id FROM applications) AND id NOT IN (SELECT job_id FROM drafts)`).run()
  return listPast()
}

/** One per line: a URL, or "Company | Title | URL | YYYY-MM-DD" (also tab-separated, or "Company - Title"). */
export function importPast(text: string): { list: PastApplication[]; added: number; skipped: number } {
  const db = getDb()
  const have = new Set(listPast().map((r) => `${normalizeUrl(r.url)}|${companyKey(r.company)}|${slug(r.title)}`))
  let added = 0
  db.transaction(() => {
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let parts = line.split(/\t|\s\|\s|\|/).map((x) => x.trim()).filter(Boolean)
      if (parts.length === 1 && !/^https?:\/\//i.test(parts[0])) parts = line.split(/\s[-–—]\s|,\s/).map((x) => x.trim()).filter(Boolean)
      const url = parts.find((x) => /^https?:\/\//i.test(x)) ?? ''
      const date = parts.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) ?? ''
      const rest = parts.filter((x) => x !== url && x !== date)
      let [company, title] = [rest[0] ?? '', rest[1] ?? '']
      if (!company && url) company = parseGreenhouseUrl(url)?.board ?? parseLeverUrl(url)?.token ?? parseAshbyUrl(url)?.token ?? ''
      if (!company && !url) continue
      const key = `${normalizeUrl(url)}|${companyKey(company)}|${slug(title)}`
      if (have.has(key)) continue
      have.add(key)
      db.prepare('INSERT INTO past_applications (company, title, url, applied_at) VALUES (?, ?, ?, ?)').run(company, title, url, date || null)
      added++
    }
  })()
  return { list: listPast(), added, skipped: applyHistoryToQueue() }
}

// ---- marking a queued job as already applied (outside this app) ----

/**
 * "I applied to this one." Moves it to the Applied folder and records it on the past list, which is what blocks
 * drafting, filling and submitting everywhere, and catches the same role reposted under a new id.
 */
export function markJobApplied(jobId: number, date?: string): { skipped: number } {
  const db = getDb()
  const j = db.prepare('SELECT url, company, title FROM jobs WHERE id = ?').get(jobId) as { url: string; company: string; title: string } | undefined
  if (!j) throw new Error('Job not found')
  const when = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date! : new Date().toISOString().slice(0, 10)
  db.transaction(() => {
    db.prepare('DELETE FROM past_applications WHERE job_id = ?').run(jobId) // re-marking just changes the date
    db.prepare('INSERT INTO past_applications (company, title, url, applied_at, note, job_id) VALUES (?, ?, ?, ?, ?, ?)').run(j.company, j.title, j.url, when, 'Marked as applied in the job queue', jobId)
    db.prepare("UPDATE jobs SET status = 'submitted', skip_reason = NULL WHERE id = ?").run(jobId)
  })()
  return { skipped: applyHistoryToQueue() } // other postings of the same role leave the queue too
}

/** Reverse a manual mark. Jobs applied to through this app cannot be un-applied here: that record is real. */
export function unmarkJobApplied(jobId: number): void {
  const db = getDb()
  const rec = db.prepare('SELECT id FROM past_applications WHERE job_id = ?').get(jobId) as { id: number } | undefined
  if (!rec) throw new Error('This job was applied to through the app, so it stays in the Applied folder.')
  removePast(rec.id)
  db.prepare("UPDATE jobs SET status = CASE WHEN fit_score IS NULL THEN 'new' ELSE 'scored' END WHERE id = ? AND status = 'submitted'").run(jobId)
}

/** Has an application already gone to this company (through this app, or on the past list)? Used for the one-application-per-company rule. */
export function appliedCompanyKeys(): Set<string> {
  const db = getDb()
  const rows = [
    ...(db.prepare("SELECT company FROM jobs WHERE status = 'submitted'").all() as { company: string }[]),
    ...(db.prepare('SELECT company FROM past_applications').all() as { company: string }[])
  ]
  return new Set(rows.map((r) => companyKey(r.company ?? '')).filter(Boolean))
}
