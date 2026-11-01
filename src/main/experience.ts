import type { FormField } from '../shared/apply'
import type { Resume } from '../shared/resume'
import { resolveOption } from './automation/options'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const idx = (y: number, m: number): number => y * 12 + m

/** "Jan 2020" -> month index. A bare year is treated as mid-year so it neither inflates nor deflates the total. */
function monthIndex(s: string, now = new Date()): number | null {
  const t = s.trim()
  if (/^(present|current|now)$/i.test(t)) return idx(now.getFullYear(), now.getMonth())
  const m = t.match(/([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})/)
  if (m) { const mi = MONTHS.indexOf(m[1].toLowerCase()); if (mi >= 0) return idx(Number(m[2]), mi) }
  const y = t.match(/^(\d{4})$/)
  return y ? idx(Number(y[1]), 6) : null
}

export const roleKey = (x: { employer: string; title: string; start: string }): string => `${x.employer}|${x.title}|${x.start}`.toLowerCase()

export interface YearsResult { years: number; whole: number; basis: string; roles: number }

/** Total time covered by the given roles. Overlapping roles are not double counted; side projects never count. */
export function yearsFor(r: Resume, keys: string[] | 'overall'): YearsResult | null {
  const want = keys === 'overall' ? null : new Set(keys)
  const picked = r.experience.filter((x) => !x.isSideProject && (want === null || want.has(roleKey(x))))
  const spans: [number, number][] = []
  const used: string[] = []
  for (const x of picked) {
    const a = monthIndex(x.start), b = monthIndex(x.end)
    if (a == null || b == null || b < a) continue // an unreadable date is skipped, never guessed
    spans.push([a, b]); used.push(`${x.employer} (${x.start} - ${x.end})`)
  }
  if (!spans.length) return null
  spans.sort((p, q) => p[0] - q[0])
  let months = 0, [cs, ce] = spans[0]
  for (const [s, e] of spans.slice(1)) { if (s <= ce) ce = Math.max(ce, e); else { months += ce - cs; cs = s; ce = e } }
  months += ce - cs
  const years = months / 12
  return { years, whole: Math.floor(years), basis: `${years.toFixed(1)} years from ${used.join('; ')}`, roles: spans.length }
}

/** Parse option labels like "0-1", "1-3 years", "5+", "Less than 1 year", "10+ years" into [min, max). */
function bucket(label: string): [number, number] | null {
  const l = label.toLowerCase().replace(/years?|yrs?/g, '').trim()
  let m = l.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/); if (m) return [Number(m[1]), Number(m[2]) + 1]
  m = l.match(/(\d+)\s*\+|(\d+)\s*or more|more than\s*(\d+)|over\s*(\d+)|at least\s*(\d+)/); if (m) { const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]); return [n, Infinity] }
  m = l.match(/(?:less than|under|fewer than|<)\s*(\d+)/); if (m) return [0, Number(m[1])]
  m = l.match(/^\s*(\d+)\s*$/); if (m) return [Number(m[1]), Number(m[1]) + 1]
  return null
}

export type Derived = { value: string; note: string } | { unsure: string } | null

/**
 * Turn computed years into the answer a form field needs. Only ever answers when the resume supports it:
 * a shortfall against a threshold is handed back to the user rather than answered "No".
 */
export function answerYears(f: Pick<FormField, 'label' | 'kind' | 'options'>, y: YearsResult, subject: string): Derived {
  if (y.years <= 0) return null
  const note = `${subject || 'experience'}: ${y.basis}`
  const threshold = f.label.match(/(\d+)\s*\+?\s*(?:or more\s+)?years?/i)
  const yesNo = f.options.length > 0 && f.options.every((o) => /^(yes|no)\b/i.test(o))

  if (f.kind === 'select' || f.kind === 'multiselect') {
    if (yesNo || (threshold && f.options.some((o) => /^yes/i.test(o)))) {
      if (!threshold) { const o = resolveOption(f.options, 'Yes'); return o ? { value: o, note } : null } // "Do you have experience with X?"
      const need = Number(threshold[1])
      if (y.years >= need) { const o = resolveOption(f.options, 'Yes'); return o ? { value: o, note } : null }
      return { unsure: `Your resume shows ${y.years.toFixed(1)} years of ${subject || 'experience'}; this asks for ${need}+. Answer it yourself.` }
    }
    const hits = f.options.filter((o) => { const b = bucket(o); return b && y.whole >= b[0] && y.years < b[1] })
    return hits.length === 1 ? { value: hits[0], note } : null
  }
  if (f.kind === 'text') return { value: String(y.whole), note }
  return null
}
