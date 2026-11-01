import type { Criteria, RunSummary } from '../../shared/discovery'
import { getDb } from '../db'
import { hasSecret } from '../secrets'
import { getSetting, setSetting } from '../settings'
import { loadResume } from '../resumeStore'
import { listConfirmedFacts } from '../facts'
import { applyHistoryToQueue, historyMatcher } from '../history'
import { detectBlockers } from './blockers'
import { getCriteria } from './criteria'
import { prefilter } from './filter'
import { scoreFit, triageTitles } from './score'
import { searchSites } from './search'
import { fetchBoard } from './sources'

let running = false
let phase = ''
export const isRunning = (): boolean => running
export const currentPhase = (): string => phase
export const lastRun = (): RunSummary | null => { const v = getSetting('discovery_last'); return v ? JSON.parse(v) as RunSummary : null }

const now = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19)
const MAX_DESC = 20000

interface BoardRow { id: number; ats: 'greenhouse' | 'lever' | 'ashby'; token: string; name: string }

export async function runDiscovery(trigger: string, onPhase: (p: string) => void = () => {}): Promise<RunSummary> {
  if (running) throw new Error('A discovery run is already in progress.')
  running = true
  const say = (p: string): void => { phase = p; onPhase(p) }
  const db = getDb()
  const c: Criteria = getCriteria()
  const errors: string[] = []
  const started = now()
  let fetched = 0, added = 0, scored = 0, strong = 0
  try {
    // 0. Anything already applied to (in this app or on the past list) leaves the queue.
    applyHistoryToQueue()
    const applied = historyMatcher()
    // 0b. Look for more employers on the job sites; their boards are read in the next step.
    const found = await searchSites(say).catch((e) => ({ added: [] as string[], errors: [`Job sites: ${(e as Error).message}`] }))
    errors.push(...found.errors)
    // 1. Fetch every enabled board and apply the free filters.
    const boards = db.prepare('SELECT id, ats, token, name FROM boards WHERE enabled = 1').all() as BoardRow[]
    for (const b of boards) {
      say(`Fetching ${b.name}`)
      try {
        const { company, jobs } = await fetchBoard(b.ats, b.token, b.name)
        fetched += jobs.length
        const known = new Map((db.prepare('SELECT id, url, status FROM jobs WHERE board_id = ?').all(b.id) as { id: number; url: string; status: string }[]).map((r) => [r.url, r]))
        const seen = new Set<string>()
        const ins = db.prepare(`INSERT INTO jobs (url, ats, title, company, pay_min, pay_max, pay_note, work_mode, status, skip_reason, posted_at, board_id, external_id, location, posting_text, first_seen_at)
          VALUES (@url, @ats, @title, @company, @pay_min, @pay_max, @pay_note, @work_mode, @status, @skip_reason, @posted_at, @board_id, @external_id, @location, @posting_text, @first_seen_at)
          ON CONFLICT(url) DO NOTHING`)
        db.transaction(() => {
          for (const j of jobs) {
            seen.add(j.url)
            if (known.has(j.url)) continue
            const prior = applied({ url: j.url, company, title: j.title })
            const reason = prefilter(j, c) ?? (prior ? `auto: ${prior.reason}` : null)
            const r = ins.run({
              url: j.url, ats: j.ats, title: j.title, company, pay_min: j.payMin, pay_max: j.payMax,
              pay_note: j.payMin == null ? 'not listed' : '', work_mode: j.workMode, status: reason ? 'skipped' : 'new', skip_reason: reason,
              posted_at: j.postedAt, board_id: b.id, external_id: j.externalId, location: j.location,
              posting_text: reason ? null : j.description.slice(0, MAX_DESC), first_seen_at: now() // text kept only for jobs that pass
            })
            if (!reason && r.changes) added++
          }
          // Postings that disappeared from the employer's board are closed. Guard against an empty/failed fetch.
          if (jobs.length > 0) {
            for (const [url, r] of known) {
              if (!seen.has(url) && ['new', 'scored', 'needs_user', 'drafted', 'queued'].includes(r.status)) {
                db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = 'auto: closed (removed from employer board)' WHERE id = ?").run(r.id)
              }
            }
          }
          db.prepare('UPDATE boards SET last_polled_at = ?, last_error = NULL, job_count = ?, name = ? WHERE id = ?').run(now(), jobs.length, company, b.id)
        })()
      } catch (e) {
        const msg = (e as Error).message
        errors.push(`${b.name}: ${msg}`)
        db.prepare('UPDATE boards SET last_polled_at = ?, last_error = ? WHERE id = ?').run(now(), msg, b.id)
      }
    }

    // 2. LLM stages need a key and a structured resume; fetching and filtering above already happened without them.
    const resume = loadResume()
    if (!hasSecret('anthropic')) errors.push('No API key: jobs were fetched and filtered but not scored. Add your key in Settings.')
    else if (!resume.experience.length) errors.push('No structured resume yet: jobs were fetched but not scored.')
    else {
      // 2a. Title triage (cheap model) for jobs not yet triaged.
      const untriaged = db.prepare("SELECT id, title FROM jobs WHERE status = 'new' AND triage_score IS NULL").all() as { id: number; title: string }[]
      if (untriaged.length) {
        say(`Triaging ${untriaged.length} titles`)
        const scores = await triageTitles(untriaged.map((u) => ({ id: u.id, title: u.title, department: '' })), resume, c)
        db.transaction(() => {
          for (const u of untriaged) {
            const s = scores.get(u.id)
            if (s == null) continue
            db.prepare('UPDATE jobs SET triage_score = ? WHERE id = ?').run(s, u.id)
            if (s < c.minTriage) db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = ?, posting_text = NULL WHERE id = ?").run(`auto: title not a match (${s}/100)`, u.id)
          }
        })()
      }

      // 2b. Full scoring, best triage first, capped per run to bound cost.
      const queue = db.prepare("SELECT id, title, company, url, posting_text, ats FROM jobs WHERE status = 'new' AND triage_score IS NOT NULL ORDER BY triage_score DESC LIMIT ?")
        .all(c.maxScorePerRun) as { id: number; title: string; company: string; url: string; posting_text: string; ats: 'greenhouse' | 'lever' | 'ashby' }[]
      const facts = listConfirmedFacts()
      let n = 0
      for (const j of queue) {
        say(`Scoring ${++n}/${queue.length}: ${j.title}`)
        try {
          const fit = await scoreFit({ title: j.title, company: j.company, text: j.posting_text ?? '' }, resume, facts, c)
          const blockers = await detectBlockers(j.ats, j.url)
          const hard = blockers.length > 0
          db.prepare(`UPDATE jobs SET fit_score = ?, reasons = ?, stretch_notes = ?, blockers = ?, status = ? WHERE id = ?`)
            .run(fit.fit, JSON.stringify(fit.reasons), fit.stretchNotes, JSON.stringify(blockers), hard ? 'needs_user' : 'scored', j.id)
          scored++
          if (fit.fit >= c.notifyScore) strong++
        } catch (e) {
          errors.push(`Scoring "${j.title}": ${(e as Error).message}`)
          if (/api key|authentication|rate limit|credit/i.test((e as Error).message)) break // don't hammer a failing API
        }
      }
    }
  } finally {
    running = false
    phase = ''
  }
  const summary: RunSummary = {
    at: now(), started, trigger, fetched, added, scored, strong, errors,
    summary: `${fetched} postings fetched, ${added} new passed filters, ${scored} scored, ${strong} strong matches${errors.length ? `, ${errors.length} problem(s)` : ''}`
  }
  setSetting('discovery_last', JSON.stringify(summary))
  return summary
}

/** Re-run blocker detection (no LLM) after the user adds answers or facts. */
export async function recheckBlockers(): Promise<number> {
  const db = getDb()
  const rows = db.prepare("SELECT j.id, j.url, b.ats FROM jobs j LEFT JOIN boards b ON b.id = j.board_id WHERE j.status IN ('scored','needs_user')").all() as { id: number; url: string; ats: 'greenhouse' | 'lever' | 'ashby' | null }[]
  for (const r of rows) {
    const blockers = await detectBlockers(r.ats, r.url)
    db.prepare('UPDATE jobs SET blockers = ?, status = ? WHERE id = ?').run(JSON.stringify(blockers), blockers.length ? 'needs_user' : 'scored', r.id)
  }
  return rows.length
}
