import type { Resume } from '../shared/resume'
import type { Arm, Breakdown, Digest, ExperimentSettings, ExperimentStats, Outcome } from '../shared/experiment'
import { OUTCOMES } from '../shared/experiment'
import type { PostingInput, TailoredDraft } from '../shared/tailor'
import { getDb } from './db'
import { getSetting, setSetting } from './settings'

export const getExperiment = (): ExperimentSettings => {
  const s = { enabled: false, controlShare: 0.25, ...(JSON.parse(getSetting('experiment') ?? '{}') as Partial<ExperimentSettings>) }
  return { enabled: !!s.enabled, controlShare: Math.min(0.9, Math.max(0.05, Number(s.controlShare) || 0.25)) }
}
export function setExperiment(s: ExperimentSettings): ExperimentSettings {
  setSetting('experiment', JSON.stringify({ enabled: !!s.enabled, controlShare: s.controlShare }))
  return getExperiment()
}

/** Random, blind assignment at draft creation. Disabled by default. */
export function assignVariant(): 'tailored' | 'control' {
  const e = getExperiment()
  return e.enabled && Math.random() < e.controlShare ? 'control' : 'tailored'
}

/** A control draft is the fixed master resume as it stands, with no cover letter and no model call. */
export function controlDraft(master: Resume, posting: PostingInput): Omit<TailoredDraft, 'id' | 'jobId' | 'approved' | 'createdAt' | 'variant' | 'excludedFromExperiment'> {
  return {
    posting, resume: structuredClone(master), coverLetter: [], claims: [], gaps: [], sources: [], excludedUnverified: 0,
    warnings: ['Control group: your master resume goes out unchanged, with no cover letter. This is deliberate, so the effect of tailoring can be measured.']
  }
}

export function setOutcome(applicationId: number, outcome: Outcome): void {
  if (!OUTCOMES.includes(outcome)) throw new Error('Unknown outcome')
  const date = outcome === 'no_response' ? null : new Date().toISOString().slice(0, 10)
  getDb().prepare('UPDATE applications SET response_status = ?, response_date = ? WHERE id = ?').run(outcome, date, applicationId)
}

// ---- statistics ----

/** Wilson 95% interval: honest about small samples, unlike a bare percentage. */
function wilson(k: number, n: number): { p: number; lo: number; hi: number } {
  if (!n) return { p: 0, lo: 0, hi: 0 }
  const z = 1.96, p = k / n, d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) }
}

const POSITIVE = new Set(['screen', 'interview', 'offer'])
const arm = (variant: Arm['variant'], rows: { response_status: string | null }[]): Arm => {
  const positive = rows.filter((r) => POSITIVE.has(r.response_status ?? '')).length
  const w = wilson(positive, rows.length)
  return { variant, n: rows.length, positive,
    interviews: rows.filter((r) => ['interview', 'offer'].includes(r.response_status ?? '')).length,
    rejected: rows.filter((r) => r.response_status === 'rejection').length, rate: w.p, lo: w.lo, hi: w.hi }
}

const roleFamily = (title: string): string => {
  const t = title.toLowerCase()
  if (/design|artist|art director|creative|animator|illustrat|ux|ui\b/.test(t)) return 'Design / creative'
  if (/engineer|developer|programmer|software|devops|sre|data scientist|machine learning/.test(t)) return 'Engineering'
  if (/product|program manager|project manager|producer/.test(t)) return 'Product / program'
  if (/manager|director|head of|lead|vp\b|chief/.test(t)) return 'Management'
  return 'Other'
}
const fitBand = (f: number | null): string => (f == null ? 'Unscored' : f >= 80 ? 'Fit 80+' : f >= 60 ? 'Fit 60-79' : 'Fit under 60')

export function getExperimentStats(): ExperimentStats {
  const rows = getDb().prepare(`SELECT a.response_status, a.variant, j.title, j.fit_score, b.ats, COALESCE(e.excluded, 0) AS excluded
    FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN boards b ON b.id = j.board_id LEFT JOIN experiments e ON e.draft_id = a.draft_id
    WHERE a.attempt_status = 'submitted' AND a.variant IS NOT NULL`).all() as
    { response_status: string | null; variant: 'tailored' | 'control'; title: string; fit_score: number | null; ats: string | null; excluded: number }[]
  const usable = rows.filter((r) => !r.excluded)
  const split = (rs: typeof usable): { tailored: Arm; control: Arm } => ({
    tailored: arm('tailored', rs.filter((r) => r.variant === 'tailored')), control: arm('control', rs.filter((r) => r.variant === 'control'))
  })
  const group = (key: (r: (typeof usable)[number]) => string): Breakdown[] => {
    const keys = [...new Set(usable.map(key))].sort()
    return keys.map((k) => ({ key: k, ...split(usable.filter((r) => key(r) === k)) }))
  }
  const arms = split(usable)
  let verdict: string
  if (arms.tailored.n < 30 || arms.control.n < 30) {
    verdict = `Too early to tell. A fair comparison needs roughly 30+ submitted applications per group; you have ${arms.tailored.n} tailored and ${arms.control.n} control.`
  } else if (arms.tailored.lo > arms.control.hi) verdict = 'Tailored responses are higher, and the 95% intervals do not overlap.'
  else if (arms.control.lo > arms.tailored.hi) verdict = 'Control responses are higher, and the 95% intervals do not overlap: tailoring is not helping so far.'
  else verdict = 'No clear difference yet: the 95% intervals overlap.'
  return {
    settings: getExperiment(), arms, verdict, excluded: rows.length - usable.length,
    breakdowns: { ats: group((r) => r.ats ?? 'unknown'), fit: group((r) => fitBand(r.fit_score)), role: group((r) => roleFamily(r.title)) }
  }
}

// ---- weekly digest ----

export function buildDigest(days = 7): Digest {
  const db = getDb()
  const since = `-${days} days`
  const one = (sql: string): number => (db.prepare(sql).get(since) as { n: number }).n
  const discovered = one("SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at > datetime('now', ?) AND status != 'skipped'")
  const strong = one("SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at > datetime('now', ?) AND fit_score >= 70")
  const submitted = one("SELECT COUNT(*) AS n FROM applications WHERE attempt_status = 'submitted' AND submitted_at > datetime('now', ?)")
  const responses = one("SELECT COUNT(*) AS n FROM applications WHERE response_status IN ('screen','interview','offer') AND response_date > date('now', ?)")
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('scored','needs_user') AND fit_score >= 70").get() as { n: number }).n
  return {
    since: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), discovered, strong, submitted, responses, pending,
    lines: [
      `${discovered} new role(s) found, ${strong} strong match(es).`,
      `${submitted} application(s) submitted, ${responses} positive response(s).`,
      `${pending} strong match(es) waiting for you.`
    ]
  }
}

/** True at most once a week, and only if there is something to say. */
export function digestDue(): Digest | null {
  const last = getSetting('digest_last')
  if (last && Date.now() - Number(last) < 7 * 86_400_000) return null
  const d = buildDigest()
  if (d.discovered + d.submitted + d.responses === 0) return null
  setSetting('digest_last', String(Date.now()))
  return d
}
