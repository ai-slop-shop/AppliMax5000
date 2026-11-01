import { z } from 'zod'
import type { Resume } from './resume'

// A fresh schema per use keeps the generated JSON Schema free of $ref.
const sourced = () => z.object({ text: z.string(), sourceIds: z.array(z.string()) })

/** What the drafting model returns. Employer/title/dates are NOT here: code copies them from the master. */
export const ModelDraftSchema = z.object({
  summary: sourced(),
  roles: z.array(z.object({ roleIndex: z.number().int(), bullets: z.array(sourced()) })),
  skills: z.array(z.string()),
  coverLetter: z.array(sourced().extend({
    boilerplate: z.boolean().describe('true only for a greeting, closing or courtesy line with no factual claim')
  })),
  gaps: z.array(z.object({ requirement: z.string(), statement: z.string() }))
})
export type ModelDraft = z.infer<typeof ModelDraftSchema>

export const CheckSchema = z.object({
  results: z.array(z.object({ id: z.string(), supported: z.boolean(), issue: z.string() }))
})

/** What the repair pass returns: each flagged statement rewritten to say only what its sources establish (empty text = cannot be said truthfully). */
export const RepairSchema = z.object({
  results: z.array(z.object({ id: z.string(), text: z.string(), sourceIds: z.array(z.string()) }))
})

export interface SourceRow { id: string; kind: 'role' | 'bullet' | 'skill' | 'fact' | 'education'; text: string }

export type ClaimStatus = 'ok' | 'unsourced' | 'unsupported' | 'edited'
export interface Claim {
  id: string // "summary" | "bullet:<role>.<n>" | "cover:<n>"
  where: 'summary' | 'bullet' | 'cover'
  text: string
  sourceIds: string[]
  status: ClaimStatus
  note: string
}

export interface PostingInput { url: string; title: string; company: string; text: string }

export interface TailoredDraft {
  id: number
  jobId: number
  posting: PostingInput
  resume: Resume // tailored
  coverLetter: { text: string; claimId: string | null }[]
  claims: Claim[]
  gaps: { requirement: string; statement: string }[]
  sources: SourceRow[]
  warnings: string[]
  excludedUnverified: number
  approved: boolean
  createdAt: string
  variant: 'tailored' | 'control' // control = master resume, no tailoring (spec §10)
  excludedFromExperiment: boolean
}

export interface DraftSummary { id: number; title: string; company: string; approved: boolean; createdAt: string; flagged: number; variant: 'tailored' | 'control' }
/** source 'resume' facts start unconfirmed; the engine only uses confirmed facts. */
export interface Fact { id: number; text: string; source: 'user' | 'resume'; confirmed: boolean; evidence: string; previous_text: string }

export interface Story { id: number; title: string; body: string; tags: string }
export interface EssayDraft { answer: string; storyIds: number[]; storyTitles: string[]; warnings: string[]; note: string }
