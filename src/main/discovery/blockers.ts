import type { Ats, JobBlocker } from '../../shared/discovery'
import { adapterByName, adapterFor } from '../automation/registry'
import { makeContext } from '../automation/context'
import { recordQuestions } from '../questions'

/**
 * Up-front blocker detection (spec §7). No browser and no LLM: reads the ATS's form and reuses the same
 * mapping the apply step uses, so what is flagged here is exactly what would stop an application later.
 */
export async function detectBlockers(ats: Ats | null, url: string): Promise<JobBlocker[]> {
  const adapter = adapterByName(ats) ?? adapterFor(url)
  if (!adapter) return [{ kind: 'no_adapter', label: 'No auto-apply adapter for this ATS. Apply manually.' }]
  const out: JobBlocker[] = []
  try {
    const form = await adapter.loadForm(url)
    recordQuestions(form.fields, form.company, url) // feeds the Answers screen
    for (const f of form.fields) {
      if (f.required && f.kind === 'file' && f.section !== 'core') out.push({ kind: 'file', label: `Extra file upload required: ${f.label}` })
    }
    const plan = adapter.mapAnswers(form.fields, makeContext({ coverLetter: 'x', resumePath: 'x', coverLetterPath: 'x', company: form.company }))
    for (const i of plan) {
      if (i.status !== 'needs_user') continue
      if (i.section === 'core') out.push({ kind: 'other', label: `Profile incomplete: ${i.label}` })
      else if (i.sensitivity === 'essay') out.push({ kind: 'essay', label: `Essay: ${i.label}` })
      else if (i.sensitivity === 'consent') out.push({ kind: 'consent', label: `Consent/agreement needs your approval: ${i.label}`, options: i.options, company: form.company, question: i.label })
      else out.push({ kind: 'answer', label: `Answer needed: ${i.label}`, options: i.options, company: form.company, question: i.label })
    }
  } catch (e) {
    out.push({ kind: 'other', label: `Could not read the form: ${(e as Error).message}` })
  }
  return out
}
