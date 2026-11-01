import type { Page } from 'playwright-core'
import type { FormField, PlanItem } from '../../shared/apply'
import type { Derived } from '../experience'

export interface MapContext {
  contact: { name: string; email: string; phone: string; city: string; state: string; linkedin: string }
  answers: { id: number; question_pattern: string; answer: string }[]
  coverLetter: string
  resumePath: string
  coverLetterPath: string // cover letter rendered as a PDF, for forms that want a file
  currentEmployer: string
  /** Answers computed from the resume (years of experience). Null when the question is not one. */
  derive?: (f: FormField) => Derived
  /** An answer proposed from the resume and facts (not yet confirmed). Always needs the user's confirmation before it is used. */
  suggest?: (f: FormField) => { value: string; basis: string } | null
  /** The option the person approved for this exact consent wording at this company, or null. */
  consent?: (f: FormField) => string | null
  overrides: Record<string, string>
}

/** Every ATS adapter is plain code, not model improvisation (spec §6, §8). */
export interface AtsAdapter {
  name: string
  detect(url: string): boolean
  /** Resolves when the application form is on screen; rejects if it never appears (login wall, closed posting). */
  waitForForm(page: Page): Promise<void>
  /** Questions from the ATS's public API (no browser needed). */
  loadForm(url: string): Promise<{ title: string; company: string; applyUrl: string; fields: FormField[] }>
  mapAnswers(fields: FormField[], ctx: MapContext): PlanItem[]
  /** Field names actually present in the live page; used to detect resets and layout changes. */
  readForm(page: Page): Promise<string[]>
  fill(page: Page, plan: PlanItem[]): Promise<void>
  verify(page: Page, plan: PlanItem[]): Promise<string[]> // returns mismatches
  /** The value the page currently holds for this field, in the same form as the plan's value; null if it cannot be read. */
  readValue?(page: Page, item: PlanItem): Promise<string | null>
  /** Required single checkboxes (agreements) on the live page that are still unticked: boxes the form needs that the plan did not know about. */
  untickedRequired?(page: Page): Promise<string[]>
  detectChallenge(page: Page): Promise<boolean>
  submit(page: Page): Promise<void>
  confirm(page: Page, timeoutMs?: number): Promise<boolean>
  /** After Submit, is the page asking for a code that was emailed to the applicant? */
  needsVerificationCode?(page: Page): Promise<boolean>
  enterVerificationCode?(page: Page, code: string): Promise<void>
  /** The page's own message when it rejects a code (wrong, expired), if it shows one. */
  verificationError?(page: Page): Promise<string | null>
  /** Why a submit did not confirm, when the page says so (for example a spam flag). */
  explainFailure?(page: Page): Promise<string | null>
}
