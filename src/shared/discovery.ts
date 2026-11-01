export type Ats = 'greenhouse' | 'lever' | 'ashby'
export type WorkMode = 'remote' | 'hybrid' | 'onsite'

export interface Board { source: 'manual' | 'suggested' | 'search'; id: number; ats: Ats; token: string; name: string; enabled: boolean; last_polled_at: string | null; last_error: string | null; job_count: number }

export interface Criteria {
  payFloor: number // annual USD; jobs whose listed max is below this are skipped
  workModes: WorkMode[]
  city: string
  state: string // two-letter
  nearby: string[] // other places that count as "local" for hybrid/onsite
  targetTitles: string[]
  excludeTitles: string[] // substrings that auto-skip a title
  excludeCompanies: string[] // never apply to these employers
  includeCompanies: string[] // exceptions: previous employers you are happy to apply to again
  maxAgeDays: number
  minTriage: number // 0-100 title relevance needed to be scored in full
  notifyScore: number // fit needed for a desktop notification
  maxScorePerRun: number // caps LLM spend per run
}

export type BlockerKind = 'essay' | 'consent' | 'answer' | 'file' | 'no_adapter' | 'other'
export interface JobBlocker { kind: BlockerKind; label: string; options?: string[]; company?: string; question?: string }

export interface JobRow {
  id: number; company: string; title: string; url: string; ats: Ats | null; location: string
  work_mode: string | null; pay_min: number | null; pay_max: number | null; pay_note: string
  status: string; skip_reason: string | null; fit_score: number | null; reasons: string[]; stretch_notes: string
  blockers: JobBlocker[]; posted_at: string | null; first_seen_at: string | null; autoApply: boolean
  applied_at: string | null; applied_via: 'app' | 'manual' | null // set once the job is in the Applied folder
}

export interface SearchSettings { remotive: boolean; remoteok: boolean; adzuna: boolean; adzunaKeySet: boolean }
export interface SearchResult { leads: number; companies: number; added: string[]; noBoard: number; errors: string[] }

export interface Schedule { enabled: boolean; intervalHours: number }
export interface RunSummary { at: string; started?: string; trigger: string; summary: string; fetched: number; added: number; scored: number; strong: number; errors: string[] }
export interface DiscoveryStatus { running: boolean; phase: string; last: RunSummary | null }
export interface DraftSeed { url: string; title: string; company: string; text: string }

export interface BoardCandidate { name: string; ats: Ats; token: string; jobs: number; matches: number; why: string; nameVerified: boolean }
export interface SetupResult {
  criteria: { set: string[]; notes: string[] } // fields that were empty and are now filled
  added: BoardCandidate[] // verified boards with relevant open roles, added automatically
  suggestions: BoardCandidate[] // plausible but not verified enough to auto-add
  unresolved: string[] // companies with no public Greenhouse/Lever/Ashby board found
}

export interface SearchBrief { text: string; updatedAt: string | null }

/** What Claude proposes from the user's description. Nothing is applied until the user selects it. */
export interface BriefProposal {
  targetTitles: string[]; excludeTitles: string[]; nearby: string[]; excludeCompanies: string[]
  workModes: WorkMode[] | null // null = no change
  payFloor: { value: number; quote: string } | null
  boards: BoardCandidate[] // verified employer boards worth adding
  unresolved: string[] // employers named with no public board found
  notes: string[] // how Claude read the description
  questions: string[] // things that were ambiguous: answer them in the description and run again
  factEdits: FactEdit[] // proposed rewrites of existing facts (only when the request asked for it)
  resumeEdits: ResumeEdit[] // proposed rewrites of the master resume's summary, bullets and skills
}
export interface ResumeEdit { key: string; label: string; before: string; after: string; why: string; flagged: boolean; note: string }
export interface FactEdit { id: number; before: string; after: string; why: string; flagged: boolean; note: string }
export interface BriefSelection {
  targetTitles: string[]; excludeTitles: string[]; nearby: string[]; excludeCompanies: string[]
  workModes: WorkMode[] | null; payFloor: number | null
  boards: { ats: Ats; token: string }[]
  factEdits: { id: number; after: string }[]
  resumeEdits: { key: string; before: string; after: string }[]
}
export interface BriefApplied { criteria: string[]; boardsAdded: number; queueSkipped: number; factsEdited: number; resumeEdited: number; resumeStale: number }

export interface AutopilotSettings {
  enabled: boolean // run an autopilot pass after each scheduled discovery run
  threshold: number // minimum fit score to apply
  dailyCap: number // most applications submitted per day
  dryRun: boolean // fill and verify, but never press Submit
  requireCleanClaims: boolean // only submit when every claim in the tailored documents traces to a confirmed fact
}
export type AutopilotOutcome = 'submitted' | 'dry_run' | 'needs_you' | 'skipped'
export interface AutopilotEntry { at: string; jobId: number; company: string; title: string; score: number | null; outcome: AutopilotOutcome; note: string }
export interface AutopilotStatus { settings: AutopilotSettings; running: boolean; phase: string; log: AutopilotEntry[]; today: number }

/** One thing the person has to decide before queued jobs can be applied to unattended. */
export interface PendingApproval {
  kind: 'consent' | 'answer'; company: string; question: string; options: string[]
  jobs: { id: number; title: string; score: number | null }[]; topScore: number
}
