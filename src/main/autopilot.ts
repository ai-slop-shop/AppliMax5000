import { Notification } from 'electron'
import type { AutopilotEntry, AutopilotOutcome, AutopilotSettings, AutopilotStatus } from '../shared/discovery'
import { adapterByName } from './automation/registry'
import { buildPlan, closeSession, fillForm, submitForm } from './automation/runner'
import { getDb } from './db'
import { approveDraft, getDraft, saveNewDraft } from './drafts'
import { assignVariant, controlDraft } from './experiments'
import { listConfirmedFacts } from './facts'
import { appliedCompanyKeys, companyKey, findPrior } from './history'
import { loadResume } from './resumeStore'
import { getSetting, setSetting } from './settings'
import { generateDraft } from './tailor'
import { recheckBlockers } from './discovery/run'
import { seedDraft } from './discovery/store'

const DEFAULTS: AutopilotSettings = { enabled: false, threshold: 80, dailyCap: 10, dryRun: true, requireCleanClaims: true }
const HOLD_MS = 24 * 3_600_000 // a job that needed the person is not retried for a day, so the same draft is not paid for twice
const MAX_LOG = 300

export const getAutopilot = (): AutopilotSettings => {
  const s = { ...DEFAULTS, ...(JSON.parse(getSetting('autopilot') ?? '{}') as Partial<AutopilotSettings>) }
  return { ...s, threshold: Math.max(0, Math.min(100, Math.round(s.threshold))), dailyCap: Math.max(1, Math.min(50, Math.round(s.dailyCap))) }
}
export const setAutopilot = (s: AutopilotSettings): AutopilotSettings => { setSetting('autopilot', JSON.stringify({ ...DEFAULTS, ...s })); return getAutopilot() }

const readLog = (): AutopilotEntry[] => JSON.parse(getSetting('autopilot_log') ?? '[]') as AutopilotEntry[]
const now = (): string => new Date().toISOString()
function record(e: Omit<AutopilotEntry, 'at'>): void {
  setSetting('autopilot_log', JSON.stringify([{ at: now(), ...e }, ...readLog()].slice(0, MAX_LOG)))
}
const sameDay = (iso: string): boolean => new Date(iso).toDateString() === new Date().toDateString()
const submittedToday = (): number => readLog().filter((e) => e.outcome === 'submitted' && sameDay(e.at)).length

let running = false
let phase = ''
export const autopilotStatus = (): AutopilotStatus => ({ settings: getAutopilot(), running, phase, log: readLog().slice(0, 60), today: submittedToday() })

/** Forget the "needs you" holds so every job is considered again on the next pass. */
export function releaseHolds(): void {
  setSetting('autopilot_log', JSON.stringify(readLog().filter((e) => e.outcome !== 'needs_you' && e.outcome !== 'dry_run')))
}

interface Candidate { id: number; company: string; title: string; fit_score: number; ats: 'greenhouse' | 'lever' | 'ashby' | null }

/** Jobs the last pass already dealt with and that should be left alone: needed the person recently, or were rehearsed in a dry run. */
function heldJobs(dryRun: boolean): Set<number> {
  const out = new Set<number>()
  for (const e of readLog()) {
    if (e.outcome === 'needs_you' && Date.now() - new Date(e.at).getTime() < HOLD_MS) out.add(e.jobId)
    if (e.outcome === 'dry_run' && dryRun) out.add(e.jobId)
  }
  return out
}

/** Once an application has gone to a company, its other roles leave the queue. */
function retireCompany(company: string, keepJobId: number, title: string): number {
  const db = getDb()
  const key = companyKey(company)
  const rows = db.prepare("SELECT id, company FROM jobs WHERE status IN ('new','scored','needs_user','queued','drafted') AND id != ?").all(keepJobId) as { id: number; company: string }[]
  let n = 0
  for (const r of rows) {
    if (companyKey(r.company ?? '') !== key) continue
    db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = ? WHERE id = ?").run(`auto: already applied to "${title}" at this company`, r.id)
    n++
  }
  return n
}

async function makeDraft(c: Candidate): Promise<number> {
  const seed = await seedDraft(c.id) // checks the posting is still live and not a repeat
  const posting = { url: seed.url, title: seed.title, company: seed.company, text: seed.text }
  const prior = findPrior(posting)
  if (prior) throw new Error(prior.message)
  const variant = assignVariant()
  const gen = variant === 'control' ? controlDraft(loadResume(), posting) : await generateDraft(loadResume(), listConfirmedFacts(), posting)
  const d = saveNewDraft({ ...gen, variant, excludedFromExperiment: false })
  return d.id
}

const settleStatus = (id: number): void => { getDb().prepare("UPDATE jobs SET status = CASE WHEN fit_score IS NULL THEN 'new' ELSE 'scored' END WHERE id = ? AND status IN ('drafted','queued')").run(id) }

/**
 * One autopilot pass. Per company, the best-scoring open job over the threshold is drafted, filled, verified and submitted;
 * if it cannot go through unattended, the next best at that company is tried. After a submission the company's other
 * roles leave the queue. It stops at the daily cap, and the moment an outcome is uncertain. It never creates accounts, solves
 * CAPTCHAs, ticks consent boxes, approves guessed answers, or submits over a verification mismatch.
 */
export async function runAutopilot(trigger: string): Promise<{ submitted: number; needsYou: number; dryRuns: number; summary: string }> {
  if (running) throw new Error('Autopilot is already running.')
  running = true
  const out = { submitted: 0, needsYou: 0, dryRuns: 0, summary: '' }
  const say = (p: string): void => { phase = p }
  const s = getAutopilot()
  try {
    say('Re-checking which jobs are blocked')
    await recheckBlockers().catch(() => 0)
    const db = getDb()
    const held = heldJobs(s.dryRun)
    const done = appliedCompanyKeys()
    const rows = db.prepare(`SELECT j.id, j.company, j.title, j.fit_score, b.ats FROM jobs j LEFT JOIN boards b ON b.id = j.board_id
      WHERE j.status = 'scored' AND j.fit_score >= ? ORDER BY j.fit_score DESC, j.id`).all(s.threshold) as Candidate[]
    const byCompany = new Map<string, Candidate[]>()
    for (const r of rows) {
      if (!adapterByName(r.ats) || held.has(r.id)) continue
      const k = companyKey(r.company ?? '')
      if (!k) continue
      if (done.has(k)) { db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = 'auto: already applied to this company' WHERE id = ?").run(r.id); continue }
      byCompany.set(k, [...(byCompany.get(k) ?? []), r])
    }
    // Say why nothing was tried, instead of finishing silently.
    const scoredAll = db.prepare("SELECT COUNT(*) AS n, MAX(fit_score) AS top FROM jobs WHERE status = 'scored'").get() as { n: number; top: number | null }
    const blockedRows = db.prepare(`SELECT j.id, j.company, j.title, j.fit_score, j.blockers, b.ats FROM jobs j LEFT JOIN boards b ON b.id = j.board_id
      WHERE j.status = 'needs_user' AND j.fit_score >= ? ORDER BY j.fit_score DESC`).all(s.threshold) as (Candidate & { blockers: string })[]
    let blockedNew = 0
    for (const r of blockedRows) {
      if (held.has(r.id) || done.has(companyKey(r.company ?? ''))) continue
      const why = (JSON.parse(r.blockers || '[]') as { label: string }[]).map((b) => b.label).slice(0, 3).join(' | ')
      record({ jobId: r.id, company: r.company, title: r.title, score: r.fit_score, outcome: 'needs_you', note: `Blocked before drafting: ${why || 'needs your input'}` })
      blockedNew++; out.needsYou++
    }
    out.summary = `${scoredAll.n} open job(s) are ready to apply to (best fit ${scoredAll.top ?? 'none'}); ${rows.length} at or above ${s.threshold}; ${blockedRows.length} more at or above ${s.threshold} are blocked${blockedNew ? ' (listed below)' : ''}.`
    const companies = [...byCompany.values()].sort((a, b) => b[0].fit_score - a[0].fit_score)
    const log = (c: Candidate, outcome: AutopilotOutcome, note: string): void => record({ jobId: c.id, company: c.company, title: c.title, score: c.fit_score, outcome, note })

    for (const jobs of companies) {
      for (const c of jobs) {
        if (!s.dryRun && submittedToday() >= s.dailyCap) { say(''); return out }
        say(`${s.dryRun ? 'Rehearsing' : 'Applying'}: ${c.title} at ${c.company}`)
        let draftId = 0
        try {
          draftId = await makeDraft(c)
          const d = getDraft(draftId)
          const flagged = d.claims.filter((x) => x.status === 'unsourced' || x.status === 'unsupported')
          if (s.requireCleanClaims && flagged.length) throw new Error(`${flagged.length} claim(s) in the tailored documents are not backed by your confirmed facts. Open it in Review.`)
          approveDraft(draftId)
          const plan = await buildPlan(draftId)
          if (plan.blocked) throw new Error(plan.blocked)
          if (plan.cooldown) throw new Error(plan.cooldown)
          const open = plan.items.filter((i) => i.status === 'needs_user')
          if (open.length) throw new Error(`Needs your answer: ${open.map((i) => i.label).slice(0, 4).join('; ')}`)
          const sensitive = plan.items.filter((i) => i.status === 'ready' && i.needsApproval)
          if (sensitive.length) throw new Error(`Needs your approval: ${sensitive.map((i) => i.label).slice(0, 4).join('; ')}`)

          const fill = await fillForm(draftId, {}, {})
          if (fill.challenge) throw new Error('A CAPTCHA or bot check appeared. The app never solves those.')
          if (fill.mismatches.length && !fill.mismatches.every((m) => /could not be checked automatically/.test(m))) throw new Error(`Verification found problems: ${fill.mismatches.slice(0, 3).join(' | ')}`)
          if (s.dryRun) {
            await closeSession()
            settleStatus(c.id)
            log(c, 'dry_run', 'Filled and verified cleanly. Would have submitted.')
            out.dryRuns++
            break // one rehearsal per company, as in a live pass
          }
          const r = await submitForm(true)
          if (r.status === 'submitted') {
            const gone = retireCompany(c.company, c.id, c.title)
            log(c, 'submitted', `Submitted.${gone ? ` ${gone} other role(s) at ${c.company} removed from the queue.` : ''}`)
            out.submitted++
            break
          }
          if (r.status === 'aborted') { await closeSession(); throw new Error(r.note) }
          // Unconfirmed, or the site wants something only the person can give: it may have gone through, so stop everything and leave the window open.
          log(c, 'needs_you', `${r.note} The browser window was left open. Check whether it was submitted before doing anything else.`)
          out.needsYou++
          say('')
          notify('Autopilot stopped', `${c.title} at ${c.company} needs a look. It may or may not have been submitted.`)
          return out
        } catch (e) {
          await closeSession().catch(() => {})
          if (draftId) settleStatus(c.id)
          log(c, 'needs_you', (e as Error).message.split('\n')[0].slice(0, 300))
          out.needsYou++
          // try the next best job at this company
        }
      }
    }
    return out
  } finally {
    running = false
    phase = ''
    if (out.submitted || out.dryRuns) notify(s.dryRun ? 'Autopilot rehearsal finished' : `Autopilot submitted ${out.submitted} application${out.submitted === 1 ? '' : 's'}`, `${trigger}: ${out.submitted} sent, ${out.dryRuns} rehearsed, ${out.needsYou} need you.`)
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}
