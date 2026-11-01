import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EmailCategory, ScanSummary } from '../../shared/email'
import type { Classifier, Classified } from './classify'
import { companySlugs, looksJobRelated } from './filter'
import { matchApplication, type AppRow } from './match'

// No electron, no network, no secrets in here: the database, the mailbox and the classifier are all passed in,
// which is what lets the privacy rules be tested against fake mailboxes.

export interface MailMessage {
  uid: number; messageId: string; date: Date; fromName: string; fromAddr: string; subject: string
  hasListUnsub: boolean; bulk: boolean
}
export interface MailSource { list(since: Date, opts?: { afterUid?: number }): Promise<MailMessage[]>; body(uid: number): Promise<string> }

const hash = (m: MailMessage): string => createHash('sha256').update(`${m.messageId || m.uid}|${m.date.toISOString()}|${m.fromAddr}`).digest('hex')
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
const OUTCOME: Partial<Record<EmailCategory, 'screen' | 'interview' | 'offer' | 'rejection'>> = { screen: 'screen', assessment: 'screen', interview: 'interview', offer: 'offer', rejection: 'rejection' }

/** The evidence quote must really be in the email. If not, the classification is not trusted for automatic updates. */
function trust(c: Classified, subject: string, body: string): Classified {
  const hay = norm(`${subject} ${body}`)
  const ok = c.evidence.trim().length >= 8 && hay.includes(norm(c.evidence))
  return ok ? c : { ...c, confidence: 'low' }
}

export async function scanMailbox(db: Database.Database, source: MailSource, o: { since: Date; classify: Classifier; autoApply: boolean }): Promise<ScanSummary & { newOutcomes: { company: string; category: EmailCategory }[] }> {
  const s: ScanSummary = { examined: 0, ignored: 0, sentForReview: 0, kept: 0, matched: 0, applied: 0, unmatched: 0, errors: [] }
  const newOutcomes: { company: string; category: EmailCategory }[] = []

  const names = [
    ...(db.prepare("SELECT DISTINCT j.company AS c FROM applications a JOIN jobs j ON j.id = a.job_id").all() as { c: string }[]).map((r) => r.c),
    ...(db.prepare('SELECT company AS c FROM past_applications').all() as { c: string }[]).map((r) => r.c)
  ]
  const known = companySlugs(names)
  const seen = db.prepare('SELECT 1 FROM email_seen WHERE hash = ?')
  const mark = db.prepare('INSERT OR IGNORE INTO email_seen (hash) VALUES (?)')

  // 1. Headers only, filtered locally. A message that fails is never read further.
  const candidates: { m: MailMessage; h: string }[] = []
  for (const m of await source.list(o.since)) {
    const h = hash(m)
    if (seen.get(h)) continue
    s.examined++
    if (!looksJobRelated({ fromAddr: m.fromAddr, fromName: m.fromName, subject: m.subject, hasListUnsub: m.hasListUnsub, bulk: m.bulk }, known).pass) { mark.run(h); s.ignored++; continue }
    candidates.push({ m, h })
  }

  // 2. Only the survivors have their body read, and only an excerpt is classified.
  const bodies = new Map<number, string>()
  for (const c of candidates) {
    try { bodies.set(c.m.uid, await source.body(c.m.uid)) } catch (e) { s.errors.push(`Could not read "${c.m.subject.slice(0, 40)}": ${(e as Error).message}`) }
  }
  const items = candidates.filter((c) => bodies.has(c.m.uid)).map((c) => ({ id: c.m.uid, from: `${c.m.fromName} <${c.m.fromAddr}>`.trim(), subject: c.m.subject, date: c.m.date.toISOString().slice(0, 10), body: bodies.get(c.m.uid)! }))
  s.sentForReview = items.length
  let results: Classified[] = []
  try { results = items.length ? await o.classify(items) : [] } catch (e) { s.errors.push(`Classification failed: ${(e as Error).message}`) ; return { ...s, newOutcomes } } // nothing is marked seen, so a retry reprocesses them

  const byUid = new Map(results.map((r) => [r.id, r]))
  const ins = db.prepare(`INSERT OR IGNORE INTO email_events (msg_hash, date, from_addr, subject, category, company, role, confidence, evidence)
    VALUES (@h, @date, @from, @subject, @category, @company, @role, @confidence, @evidence)`)
  db.transaction(() => {
    for (const c of candidates) {
      if (!bodies.has(c.m.uid)) continue
      const r0 = byUid.get(c.m.uid)
      mark.run(c.h) // looked at either way
      if (!r0 || r0.category === 'not_job' || r0.category === 'other_job') continue
      const r = trust(r0, c.m.subject, bodies.get(c.m.uid)!)
      ins.run({ h: c.h, date: c.m.date.toISOString().slice(0, 10), from: c.m.fromAddr, subject: c.m.subject.slice(0, 200), category: r.category,
        company: r.company.trim().slice(0, 120), role: r.role.trim().slice(0, 160), confidence: r.confidence, evidence: r.evidence.trim().slice(0, 200) })
      s.kept++
    }
  })()

  // 3. Match to applications and, if allowed, move the tracker forward.
  const m = matchEvents(db, o.autoApply)
  return { ...s, matched: m.matched, applied: m.applied, unmatched: m.unmatched, newOutcomes: m.newOutcomes }
}

/** Link unmatched events to applications, then apply outcomes in date order without ever clobbering a later stage. */
export function matchEvents(db: Database.Database, autoApply: boolean): { matched: number; applied: number; unmatched: number; newOutcomes: { company: string; category: EmailCategory }[] } {
  const apps = db.prepare(`SELECT a.id, j.company, j.title, a.submitted_at FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.attempt_status = 'submitted'`).all() as AppRow[]
  let matched = 0, applied = 0
  const newOutcomes: { company: string; category: EmailCategory }[] = []
  const pending = db.prepare('SELECT * FROM email_events WHERE application_id IS NULL AND ignored = 0 AND added_past = 0').all() as { id: number; company: string; role: string; date: string }[]
  const link = db.prepare('UPDATE email_events SET application_id = ? WHERE id = ?')
  for (const e of pending) { const r = matchApplication(apps, e); if (r.id != null) { link.run(r.id, e.id); matched++ } }

  if (autoApply) {
    const evs = db.prepare(`SELECT e.id FROM email_events e WHERE e.application_id IS NOT NULL AND e.applied = 0 AND e.ignored = 0 AND e.confidence != 'low' ORDER BY e.date, e.id`).all() as { id: number }[]
    for (const e of evs) { const o = applyOne(db, e.id); if (o) { applied++; newOutcomes.push(o) } }
  }
  const unmatched = (db.prepare('SELECT COUNT(*) AS n FROM email_events WHERE application_id IS NULL AND ignored = 0 AND added_past = 0').get() as { n: number }).n
  return { matched, applied, unmatched, newOutcomes }
}

/**
 * Move one application's outcome forward from one email, if the rules allow: never past a later stage, never from an email
 * older than the application, and a confirmation does not change anything. Returns what happened, or null if nothing did.
 */
export function applyOne(db: Database.Database, eventId: number): { company: string; category: EmailCategory } | null {
  const e = db.prepare('SELECT * FROM email_events WHERE id = ?').get(eventId) as { id: number; application_id: number | null; category: EmailCategory; date: string; company: string; applied: number; ignored: number } | undefined
  if (!e || !e.application_id || e.applied || e.ignored) return null
  const to = OUTCOME[e.category]
  if (!to) return null
  const app = db.prepare('SELECT response_status AS s, response_date AS d, submitted_at AS sub FROM applications WHERE id = ?').get(e.application_id) as { s: string | null; d: string | null; sub: string | null }
  if (app.sub && e.date < app.sub.slice(0, 10)) return null
  const status = app.s ?? 'no_response'
  const allowed = to === 'rejection' ? ['no_response', 'screen', 'interview'].includes(status)
    : to === 'screen' ? status === 'no_response' : to === 'interview' ? ['no_response', 'screen'].includes(status) : status !== 'offer'
  if (!allowed) return null
  db.prepare('UPDATE applications SET response_status = ?, response_date = ? WHERE id = ?').run(to, e.date, e.application_id)
  db.prepare('UPDATE email_events SET applied = 1, prev_status = ?, prev_date = ? WHERE id = ?').run(status, app.d, e.id)
  return { company: e.company, category: e.category }
}

/** Reverse an email's effect on the tracker (only if the application still shows what that email set). */
export function undoEvent(db: Database.Database, id: number): void {
  const e = db.prepare('SELECT * FROM email_events WHERE id = ?').get(id) as { application_id: number | null; applied: number; prev_status: string | null; prev_date: string | null; category: EmailCategory } | undefined
  if (!e) return
  if (e.applied && e.application_id) {
    const cur = db.prepare('SELECT response_status AS s FROM applications WHERE id = ?').get(e.application_id) as { s: string | null }
    if (cur.s === OUTCOME[e.category]) db.prepare('UPDATE applications SET response_status = ?, response_date = ? WHERE id = ?').run(e.prev_status ?? 'no_response', e.prev_date, e.application_id)
  }
  db.prepare('UPDATE email_events SET ignored = 1, applied = 0 WHERE id = ?').run(id)
}

/** The user says which application an email belongs to (or none). This only links it: applying it to the tracker is a separate, explicit step. */
export function assignEvent(db: Database.Database, id: number, applicationId: number | null, autoApply: boolean): void {
  db.prepare('UPDATE email_events SET application_id = ?, applied = 0 WHERE id = ?').run(applicationId, id)
  if (applicationId != null && autoApply) matchEvents(db, true) // confident events apply as usual; low-confidence ones wait for the user
}

// ---- waiting for a verification code ----

export interface CodeHit { code: string; receivedAt: Date; from: string }

/**
 * Poll a mailbox for a security-code email that arrives after `since`. Looks only at mail from the given senders,
 * reads the body only of those, and returns the first code found. Nothing is stored. Resolves null on timeout.
 */
export async function waitForCode(src: MailSource, o: {
  since: Date; timeoutMs: number; intervalMs?: number; isSender: (addr: string) => boolean; extract: (body: string) => string | null
  now?: () => number; sleep?: (ms: number) => Promise<void>
}): Promise<CodeHit | null> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + o.timeoutMs
  let afterUid = 0
  const tried = new Set<number>()
  for (;;) {
    const all = await src.list(o.since, afterUid ? { afterUid } : undefined)
    afterUid = Math.max(afterUid, ...all.map((m) => m.uid)) // every message seen, so the next poll only asks for newer mail
    const msgs = all.filter((m) => m.date.getTime() >= o.since.getTime() && o.isSender(m.fromAddr))
    for (const m of msgs.sort((a, b) => b.date.getTime() - a.date.getTime()).filter((x) => !tried.has(x.uid)).slice(0, 3)) {
      tried.add(m.uid)
      const code = o.extract(await src.body(m.uid))
      if (code) return { code, receivedAt: m.date, from: m.fromAddr }
    }
    if (now() >= deadline) return null
    await sleep(o.intervalMs ?? 4000)
  }
}
