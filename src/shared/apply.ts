export type FieldKind = 'text' | 'textarea' | 'select' | 'multiselect' | 'file'
export type Sensitivity = 'none' | 'consent' | 'demographic' | 'legal' | 'pay' | 'essay'

export interface FormField {
  name: string // equals the DOM id on Greenhouse boards
  label: string
  kind: FieldKind
  required: boolean
  section: 'core' | 'question' | 'location' | 'eeoc'
  options: string[]
  optionValues?: string[] // the form's own id for each option, parallel to options (used by checkbox groups)
  declineOption?: string // the option the form itself marks as "prefer not to answer"
  sensitivity: Sensitivity
  hint?: 'phone' | 'cover_letter_file' | 'location'
}

export interface PlanItem {
  name: string
  label: string
  kind: FieldKind
  section: FormField['section']
  required: boolean
  value: string
  source: 'profile' | 'answer' | 'draft' | 'default' | 'user' | 'resume' | 'suggested' | 'none'
  status: 'ready' | 'needs_user' | 'skip'
  sensitivity: Sensitivity
  needsApproval: boolean
  reason: string
  options: string[]
  optionValues?: string[]
  declineOption?: string
  domOnly?: boolean // exists in the page but not in the API (e.g. country)
  hint?: FormField['hint']
}

export interface ApplyPlan {
  draftId: number
  company: string
  formCompany: string // the name the application form itself uses; keys scanned questions
  title: string
  items: PlanItem[]
  ready: boolean // no needs_user items
  cooldown: string | null // reason a new application is blocked, if any (can be overridden)
  blocked: string | null // already applied to this job or role: never overridable here
}

/** A field the user edited in the open browser window: what the plan said, and what the page now holds. */
export interface FieldChange { name: string; label: string; before: string; after: string; saveable: boolean; why: string }
export interface FillResult { mismatches: string[]; missingFields: string[]; screenshot: string; challenge: boolean; changed: FieldChange[] }
export type SubmitStatus = 'submitted' | 'unconfirmed' | 'needs_user' | 'aborted'
export interface SubmitResult { status: SubmitStatus; note: string; confirmationUrl: string; screenshot: string }

export interface Answer { id: number; question_pattern: string; answer: string; source: string; question_id: number | null }
export interface ApplicationRow {
  id: number; company: string; title: string; url: string; attempt_status: string
  submitted_at: string | null; confirmation_url: string | null; variant: string | null; response_status: string | null; notes: string | null
}

export interface QuestionRow {
  id: number; label: string; kind: string; options: string[]; required: boolean
  sensitivity: 'none' | 'consent' | 'demographic' | 'legal' | 'pay' | 'essay'
  seen: number; companies: string[]
  suggestion: string; basis: string // a proposal only: never used until the user confirms it
  answer: string | null // the confirmed answer, if any
  variants: string[] // other wordings merged into this question; one answer covers them all
  years: { subject: string; years: number; whole: number; basis: string } | null // computed from the resume, applied automatically
}
export interface ScanResult { scanned: number; questions: number; errors: number; merged: number; yearsAnswered: number }
