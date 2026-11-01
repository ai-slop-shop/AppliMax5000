import type { JobBlocker, PendingApproval } from '../shared/discovery'
import { addAnswer } from './answers'
import { approveConsent } from './consents'
import { getDb } from './db'
import { companyKey } from './history'
import { recheckBlockers } from './discovery/run'
import { rememberAnswer } from './questions'

const PREFIX = /^(Consent\/agreement needs your approval|Answer needed): /

/** Every consent box and unanswered question holding up a queued job, once each, best-scoring first. */
export function pendingApprovals(): PendingApproval[] {
  const rows = getDb().prepare("SELECT id, company, title, fit_score, blockers FROM jobs WHERE status = 'needs_user' ORDER BY fit_score DESC").all() as
    { id: number; company: string; title: string; fit_score: number | null; blockers: string }[]
  const map = new Map<string, PendingApproval>()
  for (const r of rows) {
    let bs: JobBlocker[] = []
    try { bs = JSON.parse(r.blockers || '[]') } catch { /* ignore */ }
    for (const b of bs) {
      if (b.kind !== 'consent' && b.kind !== 'answer') continue
      const question = b.question ?? b.label.replace(PREFIX, '')
      const company = b.company ?? r.company
      // consent is per company and wording; a plain question is the same wherever it is asked
      const key = b.kind === 'consent' ? `c|${companyKey(company)}|${question.toLowerCase()}` : `a|${question.toLowerCase()}`
      const cur = map.get(key) ?? { kind: b.kind, company: b.kind === 'consent' ? company : '', question, options: b.options ?? [], jobs: [], topScore: 0 }
      cur.jobs.push({ id: r.id, title: r.title, score: r.fit_score })
      cur.topScore = Math.max(cur.topScore, r.fit_score ?? 0)
      if (!cur.options.length && b.options?.length) cur.options = b.options
      map.set(key, cur)
    }
  }
  return [...map.values()].sort((a, b) => b.topScore - a.topScore)
}

/** Record the person's decision, then re-check the queue so newly unblocked jobs become eligible for autopilot. */
export async function resolveApproval(a: { kind: 'consent' | 'answer'; company: string; question: string; value: string }): Promise<PendingApproval[]> {
  const v = a.value.trim()
  if (!v) throw new Error('Choose or enter an answer first.')
  if (a.kind === 'consent') approveConsent(a.company, a.question, v)
  else if (!rememberAnswer(a.question, a.company, v)) addAnswer(`^${a.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, v)
  await recheckBlockers()
  return pendingApprovals()
}
