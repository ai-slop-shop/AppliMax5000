export type EmailCategory = 'received' | 'screen' | 'interview' | 'assessment' | 'offer' | 'rejection' | 'other_job' | 'not_job'
export type Provider = 'gmail' | 'icloud' | 'yahoo' | 'fastmail' | 'outlook' | 'custom'

export interface EmailAccount {
  connected: boolean; provider: Provider; host: string; port: number; user: string
  clientId: string // Outlook only: the user's own Azure app registration
  autoScan: boolean // scan on a schedule while the app runs
  autoApply: boolean // update the tracker from clear matches (always reversible)
  autoCode: boolean // enter an emailed verification code when a site asks for one after Submit
  lastScan: string | null
}
export interface EmailConnect { provider: Provider; host: string; port: number; user: string; password: string }

export interface EmailEvent {
  id: number; date: string; from: string; subject: string
  category: EmailCategory; company: string; role: string; confidence: 'high' | 'medium' | 'low'; evidence: string
  applicationId: number | null; applied: boolean; addedPast: boolean; ignored: boolean
}
export interface ScanSummary {
  examined: number // messages whose headers were read
  ignored: number // dropped locally by sender/subject; never read further, never sent anywhere
  sentForReview: number // looked job-related; excerpt sent to Claude to classify
  kept: number // confirmed job responses, stored as a short summary
  matched: number; applied: number; unmatched: number
  errors: string[]
}
export interface AppChoice { id: number; label: string }
