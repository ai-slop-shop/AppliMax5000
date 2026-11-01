import { z } from 'zod'
import type { FormField } from '../shared/apply'
import type { QuestionRow, ScanResult } from '../shared/apply'
import { patternFor } from './answers'
import { factTopicOf, planMerges } from './questionTopics'
import { resolveOption } from './automation/options'
import { adapterFor } from './automation/registry'
import { getDb } from './db'
import { listConfirmedFacts } from './facts'
import { callTool, MODELS } from './llm'
import { answerYears, roleKey, yearsFor, type Derived } from './experience'
import { loadResume } from './resumeStore'
import type { Resume } from '../shared/resume'
import { buildCatalog } from './tailor'
import { getCriteria } from './discovery/criteria'
import { matchEmployer } from './employers'

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Same question, different wording of the company name, becomes one entry. */
export function questionKey(label: string, company: string): string {
  let k = label.toLowerCase().replace(/\s+/g, ' ').replace(/[\s*]+$/, '').trim()
  const c = company.toLowerCase().trim()
  if (c.length > 2) k = k.replace(new RegExp(`\\b${esc(c)}\\b`, 'g'), '<company>')
  return k
}

/** Remember every non-core question a posting asks. Counted once per posting. */
export function recordQuestions(fields: FormField[], company: string, jobUrl: string): void {
  if (matchEmployer(company, getCriteria().excludeCompanies ?? [])) return // companies on the "never apply to" list add nothing to the Answers screen
  const db = getDb()
  const up = db.prepare(`INSERT INTO questions (key, label, kind, options, required, sensitivity, last_seen) VALUES (@key, @label, @kind, @options, @required, @sensitivity, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET required = MAX(required, excluded.required), last_seen = datetime('now')`)
  db.transaction(() => {
    for (const f of fields) {
      if (f.section === 'core' || f.section === 'eeoc' || f.section === 'location' || f.kind === 'file') continue
      const key = questionKey(f.label, company)
      up.run({ key, label: f.label.trim(), kind: f.kind, options: JSON.stringify(f.options), required: f.required ? 1 : 0, sensitivity: f.sensitivity })
      const q = db.prepare('SELECT id, companies FROM questions WHERE key = ?').get(key) as { id: number; companies: string }
      if (db.prepare('INSERT OR IGNORE INTO question_sightings (question_id, job_url) VALUES (?, ?)').run(q.id, jobUrl).changes) {
        const cs = new Set<string>(JSON.parse(q.companies)); cs.add(company)
        db.prepare('UPDATE questions SET seen_count = seen_count + 1, companies = ? WHERE id = ?').run(JSON.stringify([...cs].slice(0, 8)), q.id)
      }
    }
  })()
  mergeObviousDuplicates()
}

type QRow = { id: number; key: string; label: string; kind: string; options: string; required: number; sensitivity: QuestionRow['sensitivity']
  seen_count: number; companies: string; suggestion: string; basis: string
  group_id: number | null; analyzed: number; years_subject: string; years_roles: string; years_overall: number; dismissed: number }

export function listQuestions(includeDismissed = false): QuestionRow[] {
  const db = getDb()
  const all = db.prepare('SELECT * FROM questions').all() as QRow[]
  const answers = db.prepare('SELECT question_id, question_pattern, answer FROM answers').all() as { question_id: number | null; question_pattern: string; answer: string }[]
  const resume = loadResume()
  const matches = (pat: string, label: string): boolean => { try { return new RegExp(pat, 'i').test(label) } catch { return false } }
  return all.filter((r) => r.group_id == null && (includeDismissed || !r.dismissed)).map((r): QuestionRow => {
    const members = all.filter((m) => m.group_id === r.id)
    const hit = answers.find((a) => a.question_id === r.id) ?? answers.find((a) => [r.label, ...members.map((m) => m.label)].some((l) => matches(a.question_pattern, l)))
    let years: QuestionRow['years'] = null
    if (r.years_subject || r.years_overall) {
      const y = yearsFor(resume, r.years_overall ? 'overall' : JSON.parse(r.years_roles))
      if (y) years = { subject: r.years_subject || 'overall experience', years: y.years, whole: y.whole, basis: y.basis }
    }
    const companies = [...new Set([...JSON.parse(r.companies) as string[], ...members.flatMap((m) => JSON.parse(m.companies) as string[])])].slice(0, 8)
    return { id: r.id, label: r.label, kind: r.kind, options: JSON.parse(r.options), required: !!r.required, sensitivity: r.sensitivity,
      seen: r.seen_count + members.reduce((n, m) => n + m.seen_count, 0), companies, suggestion: r.suggestion, basis: r.basis, answer: hit?.answer ?? null,
      variants: [...new Set(members.map((m) => m.label).filter((l) => l !== r.label))], years }
  }).sort((p, q) => q.seen - p.seen || p.id - q.id)
}

/** Save (or clear, if blank) the user's confirmed answer for a question. Becomes a normal stored answer. */
export function answerQuestion(id: number, value: string): QuestionRow[] {
  const db = getDb()
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QRow | undefined
  if (!q) throw new Error('Question not found')
  const v = value.trim()
  const opts = JSON.parse(q.options) as string[]
  // Validate first: a rejected edit must never wipe a saved answer.
  let stored = v
  if (v && opts.length) {
    const o = opts.includes(v) ? v : resolveOption(opts, v)
    if (!o) throw new Error(`"${v}" is not one of this question's options.`)
    stored = o
  }
  db.transaction(() => {
    db.prepare('DELETE FROM answers WHERE question_id = ?').run(id)
    if (stored) {
      db.prepare("INSERT INTO answers (question_pattern, answer, source, question_id) VALUES (?, ?, 'user-confirmed', ?)").run(patternFor(q.key), stored, id)
      db.prepare("UPDATE questions SET suggestion = '', basis = '' WHERE id = ?").run(id)
    }
  })()
  return listQuestions()
}
export function dismissQuestion(id: number, dismissed = true): QuestionRow[] {
  getDb().prepare('UPDATE questions SET dismissed = ? WHERE id = ?').run(dismissed ? 1 : 0, id)
  return listQuestions()
}

/** Network-only scan (no LLM): read the application form of each open posting and record its questions. */
export async function scanPostings(limit = 150): Promise<ScanResult> {
  const jobs = getDb().prepare(`SELECT j.url, j.company FROM jobs j JOIN boards b ON b.id = j.board_id
    WHERE j.status IN ('new','scored','needs_user','drafted','queued')
    AND j.url NOT IN (SELECT job_url FROM question_sightings) ORDER BY j.fit_score DESC, j.id LIMIT ?`).all(limit) as { url: string; company: string }[]
  let errors = 0
  const queue = [...jobs]
  // Two workers with a small gap keeps us well under the ATSes' rate limits.
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const a = adapterFor(j.url)
        if (a) recordQuestions((await a.loadForm(j.url)).fields, j.company, j.url)
      } catch { errors++ }
    }
  }))
  let merged = mergeObviousDuplicates()
  try { merged += (await consolidateQuestions()).merged } catch { /* no API key yet: only the free merges applied */ }
  const qs = listQuestions()
  return { scanned: jobs.length, questions: qs.length, errors, merged, yearsAnswered: qs.filter((q) => q.years).length }
}

const SuggestSchema = z.object({
  suggestions: z.array(z.object({ id: z.number(), answer: z.string(), sourceIds: z.array(z.string()) }))
})

const SYSTEM = `You propose answers to job application questions using ONLY a catalog of confirmed facts about the candidate.
Hard rules:
- Answer a question only when the catalog directly establishes the answer. Otherwise return an empty answer. Leaving it blank is correct and expected for most questions.
- Never answer questions about preferences, willingness, availability, start date, relocation, work authorization, sponsorship, salary, or anything about the candidate's future intentions.
- Years of experience with a tool or field: answer only if dated roles in the catalog explicitly involve it; compute from the stated dates; do not round up.
- For questions with options, the answer must be exactly one option label.
- Yes/No questions: answer only when a catalog row establishes it (for example holding a degree, or living in a city).
- Cite the catalog ids that establish the answer in sourceIds. No ids, no answer.`

/** Propose (never apply) answers for unanswered, non-sensitive, factual questions. */
export async function suggestAnswers(onlyKeys?: string[]): Promise<{ questions: QuestionRow[]; suggested: number }> {
  const resume = loadResume()
  if (!resume.experience.length && !resume.education.length) throw new Error('Upload and structure your resume first.')
  let scope: Set<number> | null = null
  if (onlyKeys) { // only the questions on one form: a member counts as its canonical question
    const rows = getDb().prepare(`SELECT id, group_id FROM questions WHERE key IN (${onlyKeys.map(() => '?').join(',') || "''"})`).all(...onlyKeys) as { id: number; group_id: number | null }[]
    scope = new Set(rows.map((r) => r.group_id ?? r.id))
  }
  const eligible = listQuestions().filter((q) => (!scope || scope.has(q.id)) && q.answer === null && !q.years && q.sensitivity === 'none' && !q.suggestion && q.kind !== 'textarea' && q.kind !== 'file')
  if (!eligible.length) return { questions: listQuestions(), suggested: 0 }

  const { rows } = buildCatalog(resume, listConfirmedFacts())
  const c = resume.contact
  const profile = [
    c.city || c.state ? { id: 'profile:location', kind: 'role' as const, text: `Lives in ${[c.city, c.state].filter(Boolean).join(', ')}` } : null,
    c.linkedin ? { id: 'profile:linkedin', kind: 'role' as const, text: `LinkedIn: ${c.linkedin}` } : null
  ].filter((x): x is NonNullable<typeof x> => !!x)
  const catalog = [...rows, ...profile]
  const byId = new Map(catalog.map((r) => [r.id, r]))

  let suggested = 0
  const db = getDb()
  for (let k = 0; k < eligible.length; k += 40) {
    const batch = eligible.slice(k, k + 40)
    const res = await callTool({
      model: MODELS.check, name: 'suggest', schema: SuggestSchema, system: SYSTEM, maxTokens: 6000,
      user: `Catalog:\n${catalog.map((r) => `[${r.id}] ${r.text}`).join('\n')}\n\nQuestions:\n${batch.map((q) =>
        `${q.id} | ${q.label} | ${q.options.length ? `options: ${q.options.join(' / ')}` : 'free text'}`).join('\n')}`
    })
    for (const s of res.suggestions) {
      const q = batch.find((x) => x.id === s.id)
      let answer = s.answer.trim()
      if (!q || !answer || s.sourceIds.length === 0 || s.sourceIds.some((i) => !byId.has(i))) continue
      if (q.options.length) { const o = resolveOption(q.options, answer); if (!o) continue; answer = o }
      const basis = s.sourceIds.map((i) => byId.get(i)!.text).join(' · ')
      db.prepare('UPDATE questions SET suggestion = ?, basis = ? WHERE id = ?').run(answer, basis, q.id)
      suggested++
    }
  }
  return { questions: listQuestions(), suggested }
}

// ---- merging duplicate questions and computing years of experience ----

const ConsolidateSchema = z.object({
  results: z.array(z.object({
    id: z.number(),
    sameAs: z.number().nullable().describe('id of another question that asks exactly the same thing (same information wanted), else null'),
    yearsQuestion: z.boolean().describe('true only if the question asks how many years or how long the candidate has worked in or with something'),
    overall: z.boolean().describe('true if it asks about total professional experience in general, not a specific tool or field'),
    subject: z.string().describe('what the years are about, e.g. "Unity" or "game development"; empty if not a years question'),
    roles: z.array(z.object({ role: z.number(), evidence: z.string().describe('exact words copied from that role that show it involved the subject') }))
  }))
})

const CONSOLIDATE_SYSTEM = `You tidy a candidate's job-application questions.
For each NEW question decide:
1. sameAs: if it asks for exactly the same information as another question in either list, give that question's id. Different wordings of one request merge (for example "Website", "Personal website" and "Portfolio URL"; "LinkedIn Profile" and "LinkedIn URL"). Do NOT merge questions that differ in meaning: different tools or skills, different time frames, authorization versus sponsorship, "current" versus "desired", or anything where one answer would be wrong for the other. When unsure, null.
2. yearsQuestion: whether it asks for years or length of experience. If so, give subject and which of the candidate's roles involved it.
   - roles: list a role only if its own text (title or bullets) plainly shows it involved the subject, and copy the exact words as evidence. Never include a role on a guess.
   - overall: true only for total professional or career experience in general.
   - Years of managing or supervising people are not handled here: set yearsQuestion false for those.
All ids in your answer are the numeric ids given. Return one result per NEW question.`

const norm = (s: string): string => s.toLowerCase().replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim()
const family = (kind: string): string => (kind === 'select' || kind === 'multiselect' ? 'select' : 'text')

/** Merge duplicate wordings and work out years-of-experience questions. Never merges sensitive questions. */
export async function consolidateQuestions(onlyKeys?: string[]): Promise<{ merged: number; years: number; analyzed: number }> {
  const db = getDb()
  const resume = loadResume()
  // Sensitive questions (legal, consent, pay, essay, demographic) are never merged or derived: nothing to analyze.
  db.prepare("UPDATE questions SET analyzed = 1 WHERE analyzed = 0 AND sensitivity != 'none'").run()
  mergeObviousDuplicates()
  let pending = db.prepare("SELECT * FROM questions WHERE analyzed = 0 AND group_id IS NULL ORDER BY seen_count DESC, id").all() as QRow[]
  if (onlyKeys) pending = pending.filter((q) => onlyKeys.includes(q.key))
  if (!pending.length) return { merged: 0, years: 0, analyzed: 0 }

  const roles = resume.experience.map((x, i) => ({ i, x, text: norm([x.title, x.employer, ...x.bullets.map((b) => b.text)].join(' \n ')) }))
  const roleBlock = roles.map(({ i, x }) => `R${i}: ${x.title} at ${x.employer} (${x.start} - ${x.end})${x.isSideProject ? ' [side project]' : ''}\n${x.bullets.slice(0, 10).map((b) => `   - ${b.text.slice(0, 160)}`).join('\n')}`).join('\n')
  const root = (id: number): QRow | undefined => { let q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QRow | undefined; while (q?.group_id) q = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.group_id) as QRow | undefined; return q }

  let merged = 0, years = 0, analyzed = 0
  for (let k = 0; k < pending.length; k += 50) {
    const batch = pending.slice(k, k + 50)
    const existing = db.prepare("SELECT id, label, kind FROM questions WHERE analyzed = 1 AND group_id IS NULL AND sensitivity = 'none' ORDER BY seen_count DESC LIMIT 150").all() as { id: number; label: string; kind: string }[]
    const res = await callTool({
      model: MODELS.check, name: 'consolidate', schema: ConsolidateSchema, system: CONSOLIDATE_SYSTEM, maxTokens: 8000,
      user: `EXISTING questions:\n${existing.map((e) => `${e.id} | ${e.label} | ${e.kind}`).join('\n') || '(none)'}\n\nNEW questions:\n${batch.map((q) => `${q.id} | ${q.label} | ${q.kind}${q.options !== '[]' ? ` | options: ${(JSON.parse(q.options) as string[]).slice(0, 8).join(' / ')}` : ''}`).join('\n')}\n\nCandidate roles:\n${roleBlock}`
    })
    db.transaction(() => {
      for (const r of res.results) {
        const q = batch.find((x) => x.id === r.id)
        if (!q) continue
        analyzed++
        let did = false
        if (r.yearsQuestion && (r.overall || r.roles.length)) {
          const keys = r.roles.filter((ro) => { const role = roles[ro.role]; return role && !role.x.isSideProject && ro.evidence.trim() && role.text.includes(norm(ro.evidence)) }).map((ro) => roleKey(roles[ro.role].x))
          if (r.overall || keys.length) {
            db.prepare('UPDATE questions SET years_subject = ?, years_roles = ?, years_overall = ?, analyzed = 1 WHERE id = ?').run(r.subject.trim(), JSON.stringify([...new Set(keys)]), r.overall ? 1 : 0, q.id)
            years++; did = true
          }
        }
        if (!did && r.sameAs != null && r.sameAs !== q.id && !r.yearsQuestion) {
          const target = root(r.sameAs)
          if (target && target.id !== q.id && target.sensitivity === 'none' && family(target.kind) === family(q.kind)) {
            db.prepare('UPDATE questions SET group_id = ?, analyzed = 1 WHERE id = ?').run(target.id, q.id)
            merged++; did = true
          }
        }
        if (!did) db.prepare('UPDATE questions SET analyzed = 1 WHERE id = ?').run(q.id)
      }
    })()
  }
  return { merged, years, analyzed }
}

/** Record this form's questions, and analyze any new ones so years and duplicates are handled before the plan is built. */
export async function ensureAnalyzed(fields: FormField[], company: string, url: string): Promise<void> {
  recordQuestions(fields, company, url)
  const keys = fields.filter((f) => f.section !== 'core' && f.section !== 'eeoc' && f.kind !== 'file').map((f) => questionKey(f.label, company))
  try { await consolidateQuestions(keys) } catch { /* no API key: questions simply stay unanalyzed */ }
  try { await suggestAnswers(keys) } catch { /* no key, or nothing to suggest: those fields just ask you */ }
}

/** The answer to a years-of-experience question, computed from the resume. Null when the question is not one. */
export function deriveFor(f: FormField, company: string, resume: Resume): Derived {
  if (f.sensitivity === 'legal') return null // years of management etc. only ever come from the user's confirmed answers
  const q = getDb().prepare('SELECT years_subject, years_roles, years_overall FROM questions WHERE key = ?').get(questionKey(f.label, company)) as
    { years_subject: string; years_roles: string; years_overall: number } | undefined
  if (!q || (!q.years_subject && !q.years_overall)) return null
  const y = yearsFor(resume, q.years_overall ? 'overall' : JSON.parse(q.years_roles))
  return y ? answerYears(f, y, q.years_subject || 'professional experience') : null
}

/**
 * Fold near-identical wordings of the same question into one, with no AI involved: same words after cleanup, or one of
 * a few low-risk families (LinkedIn, website, GitHub, start date, how you heard about us, preferred name, current employer).
 * Runs whenever questions are recorded, so the Answers list never fills up with the same thing in different clothes.
 */
/**
 * Drop unanswered questions that were only ever seen at companies on the "never apply to" list. Answered questions are kept,
 * as are ones other questions are merged into, and ones whose company list may be incomplete (it is capped at 8).
 */
export function pruneExcludedQuestions(): number {
  const db = getDb()
  const never = getCriteria().excludeCompanies ?? []
  if (!never.length) return 0
  const rows = db.prepare(`SELECT id, companies FROM questions q WHERE NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id)
    AND NOT EXISTS (SELECT 1 FROM questions m WHERE m.group_id = q.id)`).all() as { id: number; companies: string }[]
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      const cs = JSON.parse(r.companies) as string[]
      if (!cs.length || cs.length >= 8 || !cs.every((c) => matchEmployer(c, never))) continue
      db.prepare('DELETE FROM question_sightings WHERE question_id = ?').run(r.id)
      db.prepare('DELETE FROM questions WHERE id = ?').run(r.id)
      n++
    }
  })()
  return n
}

export function mergeObviousDuplicates(): number {
  const db = getDb()
  const rows = (db.prepare('SELECT q.id, q.label, q.kind, q.sensitivity, q.seen_count AS seen, q.group_id, EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id) AS answered FROM questions q').all() as
    { id: number; label: string; kind: string; sensitivity: string; seen: number; group_id: number | null; answered: number }[]).map((r) => ({ ...r, answered: !!r.answered }))
  const plan = planMerges(rows)
  db.transaction(() => {
    for (const [from, to] of plan) {
      db.prepare('UPDATE questions SET group_id = ?, analyzed = 1 WHERE id = ?').run(to, from)
      db.prepare('UPDATE questions SET group_id = ? WHERE group_id = ?').run(to, from) // anything that was folded into it follows
    }
  })()
  return plan.size + shareFactAnswers()
}

/**
 * A yes/no fact already answered in other words (stored under another wording or as a typed-in answer) counts as answered for every
 * wording of it, so it stops reappearing in the Answers list. Copies the newest confirmed answer; never invents one.
 */
function shareFactAnswers(): number {
  const db = getDb()
  const stripped = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, ' ')
  const all = db.prepare('SELECT id, question_pattern, answer, question_id FROM answers ORDER BY id DESC').all() as { id: number; question_pattern: string; answer: string; question_id: number | null }[]
  const byTopic = new Map<string, string>()
  for (const a of all) { const t = factTopicOf(stripped(a.question_pattern)); if (t && !byTopic.has(t)) byTopic.set(t, a.answer) }
  if (!byTopic.size) return 0
  const open = db.prepare("SELECT q.id, q.label FROM questions q WHERE q.group_id IS NULL AND q.dismissed = 0 AND q.sensitivity IN ('none','legal') AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id)").all() as { id: number; label: string }[]
  let n = 0
  for (const q of open) {
    const t = factTopicOf(q.label), ans = t ? byTopic.get(t) : undefined
    if (ans) { try { answerQuestion(q.id, ans); n++ } catch { /* the saved answer is not one of this question's options: leave it for the person */ } }
  }
  return n
}

/** A proposed (unconfirmed) answer for this question, from the resume and facts. Never used without the user's confirmation. */
export function suggestionFor(f: FormField, company: string): { value: string; basis: string } | null {
  const db = getDb()
  const q = db.prepare('SELECT suggestion, basis, group_id FROM questions WHERE key = ?').get(questionKey(f.label, company)) as { suggestion: string; basis: string; group_id: number | null } | undefined
  if (!q) return null
  const own = q.suggestion ? q : q.group_id ? db.prepare('SELECT suggestion, basis, group_id FROM questions WHERE id = ?').get(q.group_id) as typeof q | undefined : undefined
  return own?.suggestion ? { value: own.suggestion, basis: own.basis } : null
}

/** Save an answer the user typed on the apply screen as a normal, confirmed answer to that question. */
export function rememberAnswer(label: string, formCompany: string, value: string): boolean {
  const q = getDb().prepare('SELECT id, group_id FROM questions WHERE key = ?').get(questionKey(label, formCompany)) as { id: number; group_id: number | null } | undefined
  if (!q || !value.trim()) return false
  try { answerQuestion(q.group_id ?? q.id, value); return true } catch { return false }
}
