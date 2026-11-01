import { z } from 'zod'
import type { Ats, BoardCandidate, Criteria, SetupResult } from '../../shared/discovery'
import { getDb } from '../db'
import { callTool, MODELS } from '../llm'
import { loadResume } from '../resumeStore'
import { getCriteria, setCriteria } from './criteria'
import { getBrief } from './brief'
import { preferencesBlock } from './briefLogic'
import { matchEmployer, previousEmployers } from '../history'
import { resolveCompany } from './resolve'
import { addBoard, resetAutoSkips } from './store'

const CriteriaSchema = z.object({
  targetTitles: z.array(z.string()).describe('up to 12 job titles to search for'),
  nearby: z.array(z.string()).describe('up to 10 cities within a normal commute of the candidate'),
  excludeTitles: z.array(z.string()).describe('title words that are clearly the wrong level or kind of job'),
  notes: z.array(z.string()).describe('short notes explaining the choices')
})
const CompaniesSchema = z.object({ companies: z.array(z.object({ name: z.string(), why: z.string() })) })

const CRITERIA_SYSTEM = `You set up a job search from a resume.
- targetTitles: the candidate's recent exact titles first, then closely adjacent roles they could credibly do, including creative or cross-over roles in the same field. Titles as employers write them. No more than 12.
- nearby: other towns and cities in the same metro area or a normal commute from the candidate's city (not the city itself). No more than 10. Empty if the city is unknown.
- excludeTitles: only words that signal the wrong job: always "intern" and "internship"; add "junior" or "entry level" only if the candidate is clearly senior, and "vice president" or "chief" only if clearly not at that level. Keep it short.
- Do not guess pay.`

const COMPANY_SYSTEM = `You suggest real employers for a job search, given a resume and target titles.
- Only real companies that hire for these kinds of roles. Include a mix: employers in or near the candidate's city (for hybrid or on-site work) and well-known remote-friendly employers in the same field. Include the candidate's own industry first.
- Prefer companies that publish jobs on public applicant-tracking boards (Greenhouse, Lever, Ashby): mid-size and large tech, games, media and software companies are likely. Avoid staffing agencies and job boards.
- Give the plain company name as it is commonly written. Up to 40. Each with one short reason.
- Do not invent companies. If unsure a company exists, leave it out.
- Never suggest the candidate's own past or current employers (listed below as Past employers).`

const profile = (): string => {
  const r = loadResume()
  return `Past employers: ${r.experience.map((x) => x.employer).join(', ')}\nCity: ${[r.contact.city, r.contact.state].filter(Boolean).join(', ') || '(unknown)'}\nExperience:\n${r.experience.slice(0, 6).map((x) => `- ${x.title} at ${x.employer} (${x.start} - ${x.end})`).join('\n')}\nSkills: ${r.skills.slice(0, 25).join(', ')}\nEducation: ${r.education.map((e) => `${e.degree} ${e.field}`.trim()).join('; ')}${preferencesBlock(getBrief().text)}`
}

/** Fill criteria fields that are still empty. Never overwrites what the user set; never guesses pay. */
async function fillCriteria(): Promise<{ criteria: Criteria; set: string[]; notes: string[] }> {
  const cur = getCriteria()
  const s = await callTool({ model: MODELS.check, name: 'criteria', schema: CriteriaSchema, system: CRITERIA_SYSTEM, user: profile(), maxTokens: 3000 })
  const next = { ...cur }
  const set: string[] = []
  const clean = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))]
  if (!cur.targetTitles.length && s.targetTitles.length) { next.targetTitles = clean(s.targetTitles).slice(0, 12); set.push(`target titles (${next.targetTitles.length})`) }
  if (!cur.nearby.length && s.nearby.length) { next.nearby = clean(s.nearby).slice(0, 10); set.push(`nearby places (${next.nearby.length})`) }
  if (!cur.excludeTitles.length && s.excludeTitles.length) { next.excludeTitles = clean(s.excludeTitles).slice(0, 8); set.push(`excluded title words (${next.excludeTitles.length})`) }
  if (set.length) { setCriteria(next); resetAutoSkips() }
  const notes = [...s.notes]
  if (!cur.payFloor) notes.push('I left your pay floor at 0. Set it yourself: jobs are only skipped when their listed maximum is below it, so a floor is safe to set.')
  return { criteria: set.length ? getCriteria() : cur, set, notes }
}

const MAX_AUTO = 30

/**
 * Suggest employers from the resume, then keep only those with a verified public board.
 * Boards with relevant open roles are added automatically; the rest are offered. Manual adding is unchanged.
 */
export async function setupFromResume(onPhase: (p: string) => void = () => {}): Promise<SetupResult> {
  const r = loadResume()
  if (!r.experience.length) throw new Error('Upload and structure your resume first.')
  onPhase('Setting criteria from your resume')
  const c = await fillCriteria()

  onPhase('Finding employers in your field')
  const have = new Set((getDb().prepare('SELECT ats, token FROM boards').all() as { ats: Ats; token: string }[]).map((b) => `${b.ats}/${b.token}`))
  const sug = await callTool({
    model: MODELS.check, name: 'companies', schema: CompaniesSchema, system: COMPANY_SYSTEM, maxTokens: 4000,
    user: `${profile()}\nTarget titles: ${c.criteria.targetTitles.join('; ')}\nWork modes wanted: ${c.criteria.workModes.join(', ')}`
  })

  const found: BoardCandidate[] = []
  const unresolved: string[] = []
  const mine = previousEmployers()
  const queue = [...new Map(sug.companies.filter((x) => !matchEmployer(x.name, mine)).map((x) => [x.name.toLowerCase(), x])).values()].slice(0, 40)
  let done = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      onPhase(`Checking employers (${++done}/${done + queue.length})`)
      const hit = await resolveCompany(q.name, q.why, c.criteria.targetTitles)
      if (hit) { if (!have.has(`${hit.ats}/${hit.token}`)) found.push(hit) } else unresolved.push(q.name)
    }
  }))

  found.sort((a, b) => b.matches - a.matches)
  const auto = found.filter((f) => f.nameVerified && f.matches > 0).slice(0, MAX_AUTO)
  const added: BoardCandidate[] = []
  for (const f of auto) {
    onPhase(`Adding ${f.name}`)
    const url = f.ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${f.token}` : f.ats === 'lever' ? `https://jobs.lever.co/${f.token}` : `https://jobs.ashbyhq.com/${f.token}`
    try { await addBoard(url, 'suggested'); added.push(f) } catch { /* board vanished between check and add: skip */ }
  }
  const suggestions = found.filter((f) => !added.includes(f) && f.matches > 0).slice(0, 30)
  return { criteria: { set: c.set, notes: c.notes }, added, suggestions, unresolved }
}
