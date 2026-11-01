import { answerEntries } from '../answers'
import { consentFor } from '../consents'
import { deriveFor, suggestionFor } from '../questions'
import { loadResume } from '../resumeStore'
import type { Resume } from '../../shared/resume'
import type { MapContext } from './adapter'

/** The employer a "Current company" field should say: the role that is ongoing, else the most recent one. */
export function currentEmployer(r: Resume): string {
  const jobs = r.experience.filter((x) => !x.isSideProject)
  return (jobs.find((x) => /present|current/i.test(x.end)) ?? jobs[0])?.employer ?? ''
}

export function makeContext(opts: { resume?: Resume; overrides?: Record<string, string>; coverLetter?: string; resumePath?: string; coverLetterPath?: string; company?: string }): MapContext {
  const resume = opts.resume ?? loadResume()
  return {
    contact: resume.contact, answers: answerEntries(), overrides: opts.overrides ?? {}, coverLetter: opts.coverLetter ?? '',
    resumePath: opts.resumePath ?? '', coverLetterPath: opts.coverLetterPath ?? '', currentEmployer: currentEmployer(resume),
    derive: (f) => deriveFor(f, opts.company ?? '', resume),
    suggest: (f) => suggestionFor(f, opts.company ?? ''),
    consent: (f) => consentFor(opts.company ?? '', f.label)
  }
}
