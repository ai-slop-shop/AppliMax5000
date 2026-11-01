import type { FieldChange, PlanItem } from '../../shared/apply'

const lc = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
const digits = (s: string): string => s.replace(/\D/g, '')

/** Does what the page holds still amount to what the plan said? Forgiving about formatting, strict about content. */
export function sameValue(it: Pick<PlanItem, 'kind' | 'name' | 'section' | 'hint' | 'value'>, current: string): boolean {
  if (it.kind === 'multiselect') { const a = new Set(it.value.split('|').map(lc)), b = new Set(current.split('|').map(lc).filter(Boolean)); return a.size === b.size && [...a].every((x) => b.has(x)) }
  if (it.hint === 'phone' || it.name === 'phone') return digits(current).endsWith(digits(it.value).slice(-10))
  if (it.section === 'location' || it.hint === 'location') return lc(current).includes(lc(it.value.split(',')[0]))
  return lc(current) === lc(it.value)
}

/** Fields the person is allowed to teach the app: plain questions, not profile data, essays, consent or pay. */
export function saveability(it: Pick<PlanItem, 'kind' | 'section' | 'sensitivity' | 'name' | 'hint'>): { saveable: boolean; why: string } {
  if (it.section === 'core' || it.section === 'location' || it.hint) return { saveable: false, why: 'This comes from your profile. Change it on the Resume tab.' }
  if (it.sensitivity === 'essay' || it.kind === 'textarea') return { saveable: false, why: 'Essays are specific to one job, so they are not saved.' }
  if (it.sensitivity === 'consent') return { saveable: false, why: 'Consent boxes are approved for each company, never saved.' }
  if (it.sensitivity === 'pay') return { saveable: false, why: 'Pay answers are never saved automatically.' }
  if (it.kind === 'file') return { saveable: false, why: '' }
  return { saveable: true, why: '' }
}

/** Compare the plan with what the page holds now. A value that cannot be read (null) is skipped, never guessed. */
export function detectChanges(plan: PlanItem[], current: Record<string, string | null>): FieldChange[] {
  const out: FieldChange[] = []
  for (const it of plan) {
    if (it.kind === 'file' || it.domOnly || it.status === 'needs_user') continue
    const cur = current[it.name]
    if (cur == null) continue
    // a field the app left blank that the person filled in by hand counts as a change from ""
    if (it.status === 'skip' ? !cur.trim() : sameValue(it, cur)) continue
    out.push({ name: it.name, label: it.label, before: it.value, after: cur, ...saveability(it) })
  }
  return out
}
