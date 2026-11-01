import { z } from 'zod'
import type { Fact } from '../shared/tailor'
import { renderPlainText } from './export'
import { getDb } from './db'
import { callTool, MODELS } from './llm'
import { listFacts } from './facts'
import { loadResume } from './resumeStore'
import { getSetting } from './settings'

const FactsSchema = z.object({
  facts: z.array(z.object({
    text: z.string().describe('one self-contained factual sentence'),
    evidence: z.array(z.string()).describe('exact quotes copied from the resume text that support the fact')
  }))
})

const SYSTEM = `You extract atomic, reusable facts about a candidate from their resume, for later use in job applications.
Hard rules:
- Every fact must be directly stated in the resume, or be simple arithmetic on dates the resume states (for example "about 6 years at Employer, Jan 2018 - Present"; say how it was computed).
- Never infer seniority, leadership, scope, impact, team size, tools or numbers that the text does not state. Do not round up. Do not generalize one tool to a category.
- Each fact is one self-contained sentence naming the employer or context (for example "Managed 4 engineers as Tools Department Lead at Rainbow Studios, 2 years.").
- Prefer facts that answer common application questions: years in a role or field, people management and team size, specific tools and technologies and where they were used, domains and industries, education and certifications, awards, languages, location and work history gaps stated in the text.
- Do not restate resume bullets verbatim; extract the underlying checkable facts. Skip facts already listed under "Existing facts".
- evidence: exact quotes copied character-for-character from the resume text. At least one per fact.
- At most 40 facts. Quality over quantity.`

const norm = (s: string): string => s.toLowerCase().replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

/** Generate unconfirmed facts from the saved resume. Facts whose evidence is not in the resume text are dropped. */
export async function generateFacts(): Promise<{ facts: Fact[]; added: number; dropped: number }> {
  const resume = loadResume()
  if (!resume.experience.length && !resume.contact.name) throw new Error('Upload and structure your resume first.')
  const sourceText = JSON.parse(getSetting('resume_source') ?? '{"text":""}').text as string
  const plain = renderPlainText(resume)
  const haystack = norm(`${sourceText}\n${plain}`)
  const existing = listFacts()

  const res = await callTool({
    model: MODELS.structure, name: 'facts', schema: FactsSchema, system: SYSTEM, maxTokens: 8000,
    user: `Existing facts:\n${existing.map((f) => `- ${f.text}`).join('\n') || '(none)'}\n\nResume text:\n${sourceText || plain}`
  })

  const seen = new Set(existing.map((f) => norm(f.text)))
  const ins = getDb().prepare("INSERT INTO facts (text, source, confirmed, evidence) VALUES (?, 'resume', 0, ?)")
  let added = 0, dropped = 0
  getDb().transaction(() => {
    for (const f of res.facts) {
      const text = f.text.trim()
      const grounded = f.evidence.length > 0 && f.evidence.every((q) => q.trim() && haystack.includes(norm(q)))
      if (!text || seen.has(norm(text))) continue
      if (!grounded) { dropped++; continue }
      ins.run(text, f.evidence.map((q) => q.trim()).join(' | '))
      seen.add(norm(text))
      added++
    }
  })()
  return { facts: listFacts(), added, dropped }
}
