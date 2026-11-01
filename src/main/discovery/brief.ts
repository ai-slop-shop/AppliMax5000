import { z } from 'zod'
import type { BriefApplied, BriefProposal, BriefSelection, FactEdit, ResumeEdit, SearchBrief } from '../../shared/discovery'
import type { Resume } from '../../shared/resume'
import { renderPlainText } from '../export'
import { listFacts, rewriteFact } from '../facts'
import { applyHistoryToQueue, matchEmployer, previousEmployers } from '../history'
import { callTool, MODELS } from '../llm'
import { loadResume, saveResume } from '../resumeStore'
import { getSetting, setSetting } from '../settings'
import { resetAutoSkips, listBoards, addBoard } from './store'
import { getCriteria, setCriteria } from './criteria'
import { checkFactEdit, checkResumeEdit, mergeSelection, sanitize } from './briefLogic'
import { resolveCompany } from './resolve'

export function getBrief(): SearchBrief {
  const v = getSetting('search_brief')
  return v ? JSON.parse(v) as SearchBrief : { text: '', updatedAt: null }
}
export function setBrief(text: string): SearchBrief {
  const b = { text: text.slice(0, 4000), updatedAt: new Date().toISOString() }
  setSetting('search_brief', JSON.stringify(b))
  return b
}

const ProposalSchema = z.object({
  addTargetTitles: z.array(z.string()), addExcludeTitles: z.array(z.string()), addNearby: z.array(z.string()), addExcludeCompanies: z.array(z.string()),
  workModes: z.array(z.string()).describe('only if the user stated work-mode preferences; otherwise empty'),
  payFloor: z.number().nullable().describe('annual USD, only if the user stated a minimum'), payFloorQuote: z.string().describe('the exact words the user used for the pay minimum, or empty'),
  employerIdeas: z.array(z.object({ name: z.string(), why: z.string() })),
  factEdits: z.array(z.object({ id: z.number(), after: z.string(), why: z.string() })),
  resumeEdits: z.array(z.object({ key: z.string(), after: z.string(), why: z.string() })),
  notes: z.array(z.string()), questions: z.array(z.string())
})
const AuditSchema = z.object({ results: z.array(z.object({ id: z.string(), supported: z.boolean(), issue: z.string() })) })

const SYSTEM = `You turn a job seeker's description and requests into concrete changes they can review. You never apply anything yourself.

SEARCH (always, based on the description and request):
- addTargetTitles: further job titles worth searching, including adjacent and cross-over roles they say they are open to or that clearly fit their resume. Do not repeat existing ones.
- addExcludeTitles: title words that are clearly wrong for what they want.
- addNearby: other places that count as local, including cities they say they would relocate to.
- addExcludeCompanies: ONLY companies the user names as ones to avoid.
- workModes: remote, hybrid, onsite: only when they state a preference.
- payFloor: only when they state a minimum, converted to annual USD, with their exact words in payFloorQuote.
- employerIdeas: up to 30 real employers that fit what they describe, mixing their own field with the adjacent industries they ask to expand into. Real companies only; never their past employers.
- notes: one short line on how you read the request. questions: only real ambiguities.

FACT REWRITES (factEdits): produce these ONLY if the request asks to rewrite, improve or optimize their facts, for example so automated screeners, search tools or AI recruiting agents can match them. Otherwise return an empty list.
- Reword so that machines and humans both match it: use the standard industry name for a title or skill when it is exactly equivalent to what is already stated, spell out an acronym once with the acronym in parentheses, and put employer, role and time frame in one plain, self-contained sentence. One fact stays one fact.
- HARD RULES: never add a skill, tool, number, title, scope, team size, employer, date or claim that is not in that fact or the resume. Never raise seniority or round numbers up. No keyword lists, no repeated terms, no hidden or invisible text, and no instructions aimed at a screening system. If a fact is already clear, leave it out of factEdits.
- If asked to exaggerate, invent, or hide text for machines, do not; say so in notes.

RESUME REWRITES (resumeEdits): produce these ONLY if the request asks to improve, rewrite or optimize the resume, its summary, bullets or skills (for example so applicant-tracking systems and AI screeners parse and match it). Otherwise return an empty list. Items are identified by their keys: "summary", "skills", and "b:<role>.<bullet>".
- You may change ONLY the wording of the summary, individual bullets, and the skills list. Never change employers, job titles, dates, or the structure.
- Same honesty rules as facts: no new skill, tool, number, title, scope, team size or claim that is not already in the resume or the facts. No keyword stuffing, repetition, padding, hidden text or instructions aimed at a screener.
- Bullets: lead with the action and outcome in plain words, use the standard industry name for a skill or tool the bullet already states, spell out an acronym once with the acronym in parentheses. Keep length about the same. Keep every number exactly as written.
- skills: return the whole list as comma-separated text: rename to standard names (and spell out acronyms once), and put the most relevant to the stated target roles first. Never add a skill and never drop one.
- summary: 2 to 3 plain sentences stating who they are professionally, drawn only from the resume and facts. If the summary is empty you may write one under the same rules.
- Skip anything already clear. Fewer, better edits beat many.

Facts are identified by their numeric ids.`

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** The editable parts of the master resume, each with a stable key. Employers, titles and dates are never editable. */
function editableParts(r: Resume): Map<string, { label: string; kind: 'summary' | 'bullet' | 'skills'; text: string }> {
  const m = new Map<string, { label: string; kind: 'summary' | 'bullet' | 'skills'; text: string }>()
  m.set('summary', { label: 'Summary', kind: 'summary', text: r.summary })
  m.set('skills', { label: 'Skills', kind: 'skills', text: r.skills.join(', ') })
  r.experience.forEach((x, i) => x.bullets.forEach((b, j) => m.set(`b:${i}.${j}`, { label: `${x.employer}, ${x.title}: bullet ${j + 1}`, kind: 'bullet', text: b.text })))
  return m
}

/** Read the user's description (and optional one-off request) and propose changes. Applies nothing. */
export async function proposeFromBrief(request: string | null): Promise<BriefProposal> {
  const brief = getBrief().text
  const ask = (request ?? '').trim()
  if (!brief.trim() && !ask) throw new Error('Write what you are looking for, or ask Claude for something, first.')
  const resume = loadResume()
  const cur = getCriteria()
  const facts = listFacts()
  const resumeText = renderPlainText(resume)

  const raw = await callTool({
    model: MODELS.check, name: 'proposal', schema: ProposalSchema, system: SYSTEM, maxTokens: 8000,
    user: `Standing description of what they are looking for:\n"""\n${brief || '(none)'}\n"""\n\nThis request:\n"""\n${ask || '(none: just apply the standing description)'}\n"""\n\n` +
      `Current search settings:\n- target titles: ${cur.targetTitles.join('; ') || '(none)'}\n- excluded title words: ${cur.excludeTitles.join('; ') || '(none)'}\n- also local: ${cur.nearby.join('; ') || '(none)'}\n- work modes: ${cur.workModes.join(', ')}\n- pay floor: ${cur.payFloor || '(none)'}\n- city: ${cur.city}, ${cur.state}\n\n` +
      `Resume:\n${resumeText}\n\nEditable resume parts (key | current text):\n${[...editableParts(resume)].map(([k, v]) => `${k} | ${v.text || '(empty)'}`).join('\n')}\n\nFacts:\n${facts.map((f) => `[${f.id}] ${f.text}`).join('\n') || '(none)'}`
  })

  const s = sanitize(raw, `${brief}\n${ask}`, cur)

  // Fact rewrites: deterministic number check, then an independent audit against the original and the resume.
  const byId = new Map(facts.map((f) => [f.id, f]))
  const candidates = raw.factEdits.filter((e) => byId.has(e.id) && e.after.trim() && norm(e.after) !== norm(byId.get(e.id)!.text))
  let factEdits: FactEdit[] = candidates.map((e) => {
    const before = byId.get(e.id)!.text
    const c = checkFactEdit(before, e.after.trim(), resumeText)
    return { id: e.id, before, after: e.after.trim(), why: e.why, flagged: c.flagged, note: c.note }
  })
  // Resume rewrites: same deterministic guard, then audited together with the fact rewrites.
  const parts = editableParts(resume)
  let resumeEdits: ResumeEdit[] = raw.resumeEdits.flatMap((e): ResumeEdit[] => {
    const part = parts.get(e.key)
    const after = e.after.trim()
    if (!part || !after || norm(after) === norm(part.text)) return []
    const c = checkResumeEdit(part.kind, part.text, after, resumeText)
    return [{ key: e.key, label: part.label, before: part.text, after, why: e.why, flagged: c.flagged, note: c.note }]
  })

  const auditItems = [
    ...factEdits.filter((e) => !e.flagged).map((e) => ({ id: `f:${e.id}`, original: e.before, rewrite: e.after })),
    ...resumeEdits.filter((e) => !e.flagged).map((e) => ({ id: e.key, original: e.before, rewrite: e.after }))
  ]
  if (auditItems.length) {
    const audit = await callTool({
      model: MODELS.check, name: 'audit', schema: AuditSchema, maxTokens: 6000,
      system: 'You audit rewrites of text about a candidate (facts, resume summary, bullets, skills lists). For each, supported=true only if the rewrite says nothing beyond the original and the resume: no new skill, tool, number, title, scope, seniority, employer, date or claim, and nothing dropped that changes the meaning. Rewording, standard terminology for the same thing, spelling out an acronym, and reordering a skills list are fine. Adding or removing a skill is not. Otherwise supported=false with a one-sentence issue.',
      user: JSON.stringify(auditItems, null, 1) + `\n\nResume:\n${resumeText}`
    })
    const verdict = new Map(audit.results.map((r) => [r.id, r]))
    const judge = <T extends { flagged: boolean; note: string }>(e: T, id: string): T => {
      if (e.flagged) return e
      const v = verdict.get(id)
      return !v || !v.supported ? { ...e, flagged: true, note: v?.issue || 'Not reviewed by the checker.' } : e
    }
    factEdits = factEdits.map((e) => judge(e, `f:${e.id}`))
    resumeEdits = resumeEdits.map((e) => judge(e, e.key))
  }

  // Employers: verify each has a public board; skip past employers and boards already added.
  const have = new Set(listBoards().map((b) => `${b.ats}/${b.token}`))
  const mine = previousEmployers()
  const targets = [...cur.targetTitles, ...s.targetTitles]
  const boards: BriefProposal['boards'] = []
  const unresolved: string[] = []
  const queue = [...new Map(raw.employerIdeas.filter((x) => !matchEmployer(x.name, mine)).map((x) => [x.name.toLowerCase(), x])).values()].slice(0, 30)
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const hit = await resolveCompany(q.name, q.why, targets)
      if (!hit) unresolved.push(q.name)
      else if (!have.has(`${hit.ats}/${hit.token}`) && hit.nameVerified && hit.matches > 0) boards.push(hit)
    }
  }))
  boards.sort((a, b) => b.matches - a.matches)

  return {
    targetTitles: s.targetTitles, excludeTitles: s.excludeTitles, nearby: s.nearby, excludeCompanies: s.excludeCompanies,
    workModes: s.workModes, payFloor: s.payFloor, boards, unresolved,
    notes: [...raw.notes, ...s.dropped], questions: raw.questions, factEdits, resumeEdits
  }
}

/** Apply only what the user selected. Re-validates against current data, never trusting the screen. */
export async function applyBrief(sel: BriefSelection): Promise<BriefApplied> {
  const cur = getCriteria()
  const { next, changed } = mergeSelection(cur, sel)
  if (changed.length) { setCriteria(next); resetAutoSkips() }

  let boardsAdded = 0
  for (const b of sel.boards.slice(0, 40)) {
    const url = b.ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${b.token}` : b.ats === 'lever' ? `https://jobs.lever.co/${b.token}` : `https://jobs.ashbyhq.com/${b.token}`
    try { await addBoard(url, 'suggested'); boardsAdded++ } catch { /* the board went away: skip it */ }
  }

  const ids = new Set(listFacts().map((f) => f.id))
  let factsEdited = 0
  for (const e of sel.factEdits) if (ids.has(e.id) && e.after.trim()) { rewriteFact(e.id, e.after); factsEdited++ }

  // Resume rewrites: each is applied only if that part still reads exactly as it did when proposed.
  let resumeEdited = 0, resumeStale = 0
  if (sel.resumeEdits.length) {
    const resume = loadResume()
    const parts = editableParts(resume)
    const next = structuredClone(resume)
    for (const e of sel.resumeEdits) {
      const part = parts.get(e.key)
      if (!part || norm(part.text) !== norm(e.before) || !e.after.trim()) { resumeStale++; continue }
      if (e.key === 'summary') next.summary = e.after.trim()
      else if (e.key === 'skills') {
        const after = [...new Set(e.after.split(',').map((x) => x.trim()).filter(Boolean))]
        if (after.length > resume.skills.length) { resumeStale++; continue } // skills are renamed or reordered, never added
        next.skills = after
      } else {
        const m = e.key.match(/^b:(\d+)\.(\d+)$/)
        const bullet = m && next.experience[Number(m[1])]?.bullets[Number(m[2])]
        if (!bullet) { resumeStale++; continue }
        bullet.text = e.after.trim() // the verified flag is unchanged: you approved this wording
      }
      resumeEdited++
    }
    if (resumeEdited) {
      setSetting('resume_undo', JSON.stringify({ at: new Date().toISOString(), resume }))
      saveResume(next)
    }
  }

  return { criteria: changed, boardsAdded, queueSkipped: applyHistoryToQueue(), factsEdited, resumeEdited, resumeStale }
}

export const hasResumeUndo = (): boolean => !!getSetting('resume_undo')

/** Put the master resume back as it was before the last AI rewrite. Edits made since then are replaced. */
export function undoResumeRewrite(): Resume {
  const v = getSetting('resume_undo')
  if (!v) throw new Error('Nothing to undo.')
  const { resume } = JSON.parse(v) as { resume: Resume }
  const restored = saveResume(resume)
  setSetting('resume_undo', '')
  return restored
}
