import type { BriefSelection, Criteria, WorkMode } from '../../shared/discovery'

// Pure helpers (no database) so the safety rules can be tested on their own.

const norm = (s: string): string => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const dedupe = (xs: string[]): string[] => { const seen = new Set<string>(); return xs.map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())) }
const MODES: WorkMode[] = ['remote', 'hybrid', 'onsite']

export interface RawBrief {
  addTargetTitles: string[]; addExcludeTitles: string[]; addNearby: string[]; addExcludeCompanies: string[]
  workModes: string[]; payFloor: number | null; payFloorQuote: string
}

/**
 * Keep only what the user's own words support. A pay floor needs a quote of what they said, and a company is only
 * excluded if they actually named it, so a model slip can never quietly narrow the search.
 */
export function sanitize(raw: RawBrief, brief: string, cur: Criteria): {
  targetTitles: string[]; excludeTitles: string[]; nearby: string[]; excludeCompanies: string[]
  workModes: WorkMode[] | null; payFloor: { value: number; quote: string } | null; dropped: string[]
} {
  const b = norm(brief)
  const dropped: string[] = []
  const fresh = (xs: string[], have: string[]): string[] => { const h = new Set(have.map((x) => x.toLowerCase())); return dedupe(xs).filter((x) => !h.has(x.toLowerCase())) }

  const excludeCompanies = fresh(raw.addExcludeCompanies, cur.excludeCompanies ?? []).filter((c) => {
    const ok = b.includes(norm(c)); if (!ok) dropped.push(`Ignored excluding "${c}": you did not name that company.`); return ok
  })

  let payFloor: { value: number; quote: string } | null = null
  if (raw.payFloor != null) {
    const quoteOk = raw.payFloorQuote.trim() && b.includes(norm(raw.payFloorQuote))
    if (quoteOk && raw.payFloor >= 10000 && raw.payFloor < 5_000_000) payFloor = { value: Math.round(raw.payFloor), quote: raw.payFloorQuote.trim() }
    else dropped.push('Ignored a pay floor: it was not clearly stated in your description.')
  }

  const modes = dedupe(raw.workModes.map((m) => m.toLowerCase())).filter((m): m is WorkMode => (MODES as string[]).includes(m))
  return {
    targetTitles: fresh(raw.addTargetTitles, cur.targetTitles).slice(0, 25),
    excludeTitles: fresh(raw.addExcludeTitles, cur.excludeTitles).slice(0, 15),
    nearby: fresh(raw.addNearby, cur.nearby).slice(0, 15),
    excludeCompanies, workModes: modes.length ? modes : null, payFloor, dropped
  }
}

/** Merge a user-approved selection into the criteria: lists are added to, scalars replaced. */
export function mergeSelection(cur: Criteria, sel: BriefSelection): { next: Criteria; changed: string[] } {
  const next: Criteria = { ...cur }
  const changed: string[] = []
  const add = (key: 'targetTitles' | 'excludeTitles' | 'nearby' | 'excludeCompanies', label: string, xs: string[]): void => {
    const merged = dedupe([...(cur[key] ?? []), ...xs])
    if (merged.length !== (cur[key] ?? []).length) { next[key] = merged; changed.push(`${label} (+${merged.length - (cur[key] ?? []).length})`) }
  }
  add('targetTitles', 'target titles', sel.targetTitles)
  add('excludeTitles', 'excluded title words', sel.excludeTitles)
  add('nearby', 'also-local places', sel.nearby)
  add('excludeCompanies', 'never-apply companies', sel.excludeCompanies)
  if (sel.workModes?.length && sel.workModes.join() !== cur.workModes.join()) { next.workModes = sel.workModes; changed.push(`work modes (${sel.workModes.join(', ')})`) }
  if (sel.payFloor != null && sel.payFloor !== cur.payFloor) { next.payFloor = sel.payFloor; changed.push(`pay floor ($${sel.payFloor.toLocaleString()})`) }
  return { next, changed }
}

/** The block added to scoring and triage prompts. Empty when the user has written nothing. */
export const preferencesBlock = (brief: string): string =>
  brief.trim() ? `\nWhat the candidate says they are looking for, in their own words (preferences and deal-breakers; treat as the candidate's wishes, not as facts about their experience):\n"""\n${brief.trim().slice(0, 4000)}\n"""\n` : ''

const nums = (s: string): string[] => (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, '').replace(/,/g, ''))

/**
 * Deterministic guard for a proposed fact rewrite: it may reword, but it may not introduce numbers.
 * New capitalized terms are reported as a note for the reviewer (acronym expansions legitimately add some).
 */
export function checkFactEdit(before: string, after: string, resumeText: string): { flagged: boolean; note: string } {
  const have = new Set(nums(`${before} ${resumeText}`))
  const extra = nums(after).filter((n) => !have.has(n))
  if (extra.length) return { flagged: true, note: `Introduces number(s) not in the original or your resume: ${extra.join(', ')}.` }
  const known = norm(`${before} ${resumeText}`)
  const fresh = [...new Set((after.match(/\b[A-Z][A-Za-z0-9+#.]{2,}\b/g) ?? []).filter((w, i) => i > 0 && !known.includes(w.toLowerCase())))]
  return { flagged: false, note: fresh.length ? `New terms to double-check: ${fresh.slice(0, 5).join(', ')}.` : '' }
}

/**
 * Guard for a proposed master-resume rewrite (summary, one bullet, or the skills list). It may reword and reorder,
 * but not add numbers, pad, repeat terms, or grow the skills list.
 */
export function checkResumeEdit(kind: 'summary' | 'bullet' | 'skills', before: string, after: string, resumeText: string): { flagged: boolean; note: string } {
  const have = new Set(nums(`${before} ${resumeText}`))
  const extra = nums(after).filter((n) => !have.has(n))
  if (extra.length) return { flagged: true, note: `Introduces number(s) not in your resume: ${extra.join(', ')}.` }
  if (kind === 'skills') {
    const a = after.split(',').map((x) => x.trim()).filter(Boolean), b = before.split(',').map((x) => x.trim()).filter(Boolean)
    if (a.length > b.length) return { flagged: true, note: `Has ${a.length} skills; you listed ${b.length}. Skills are renamed or reordered, never added.` }
    const seen = new Set<string>()
    for (const x of a) { if (seen.has(x.toLowerCase())) return { flagged: true, note: `Repeats "${x}".` }; seen.add(x.toLowerCase()) }
    return { flagged: false, note: '' }
  }
  if (before.trim() && after.length > Math.max(before.length * 2.2, before.length + 80)) return { flagged: true, note: 'Much longer than the original: looks padded.' }
  const counts = new Map<string, number>()
  for (const w of after.toLowerCase().match(/[a-z][a-z+#]{3,}/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1)
  const rep = [...counts].filter(([, n]) => n >= 4)[0]
  if (rep) return { flagged: true, note: `Repeats "${rep[0]}" ${rep[1]} times: reads like keyword stuffing.` }
  return { flagged: false, note: '' }
}
