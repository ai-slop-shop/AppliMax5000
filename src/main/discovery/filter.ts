import type { Criteria } from '../../shared/discovery'
import { matchEmployer } from '../employers'
import { US_STATES } from '../automation/options'
import type { RawJob } from './sources'

const STATE_NAMES = Object.values(US_STATES).map((s) => s.toLowerCase())
const mentionsUsState = (loc: string): boolean =>
  STATE_NAMES.some((n) => loc.toLowerCase().includes(n)) || Object.keys(US_STATES).some((a) => new RegExp(`(^|[\\s,(-])${a}($|[\\s,)|/-])`).test(loc))
const US_HINT = /united states|\busa?\b|north america|americas|worldwide|global|anywhere/i

function isLocal(loc: string, c: Criteria): boolean {
  const l = loc.toLowerCase()
  const places = [c.city, ...c.nearby].map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (places.some((p) => l.includes(p))) return true
  if (c.state) {
    const abbr = c.state.toUpperCase()
    if (new RegExp(`(^|[\\s,(-])${abbr}($|[\\s,)|/-])`).test(loc)) return true
    if ((US_STATES[abbr] ?? '').toLowerCase() && l.includes(US_STATES[abbr].toLowerCase())) return true
  }
  return false
}

/** Cheap, deterministic filters run before any LLM call. Returns a reason when the job should be skipped. */
export function prefilter(j: RawJob, c: Criteria): string | null {
  const noCo = matchEmployer(j.company, c.excludeCompanies ?? [])
  if (noCo) return `auto: excluded company (${noCo})`
  const title = j.title.toLowerCase()
  const bad = c.excludeTitles.map((t) => t.trim().toLowerCase()).filter(Boolean).find((t) => title.includes(t))
  if (bad) return `auto: title contains "${bad}"`

  if (c.maxAgeDays > 0 && j.postedAt) {
    const age = (Date.now() - new Date(j.postedAt).getTime()) / 86_400_000
    if (age > c.maxAgeDays) return `auto: posted ${Math.round(age)} days ago`
  }

  const loc = j.location
  const remote = j.workMode === 'remote' || /\bremote\b/i.test(loc)
  if (remote) {
    if (!c.workModes.includes('remote')) return 'auto: remote roles excluded'
    const rest = loc.replace(/remote|anywhere|[-,()|/]/gi, ' ').trim()
    if (rest && !US_HINT.test(loc) && !mentionsUsState(loc) && !isLocal(loc, c)) return `auto: remote outside your region (${loc})`
  } else {
    const m = j.workMode ?? 'onsite' // unknown is treated as on-site
    if (!c.workModes.includes(m)) return `auto: ${m} roles excluded`
    if (!isLocal(loc, c)) return `auto: not near you (${loc || 'no location'})`
  }

  if (c.payFloor > 0 && j.payMax != null && j.payMax < c.payFloor) return `auto: pay tops out at $${j.payMax.toLocaleString()} (floor $${c.payFloor.toLocaleString()})`
  return null
}
