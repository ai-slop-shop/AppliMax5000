import type { FormField, PlanItem } from '../../shared/apply'
import { factTopicOf } from '../questionTopics'
import type { MapContext } from './adapter'
import { findDecline, resolveOption, resolveSelfId, US_STATES } from './options'

/** An adapter's answer for its own standard fields: a value, 'skip' (handled elsewhere / leave blank), or null (not a core field). */
export type CoreResolver = (f: FormField, ctx: MapContext) => { value: string; source: PlanItem['source'] } | 'skip' | null

/** Which self-identification topic a piece of text is about, so "Disabled" and "I have a disability" are recognized as the same topic. */
export function demoTopic(text: string): string | null {
  const t = text.toLowerCase()
  if (/transgender/.test(t)) return 'transgender'
  if (/sexual orientation|orientation/.test(t)) return 'orientation'
  if (/gender/.test(t) && !/transgender/.test(t)) return 'gender'
  if (/hispanic|latino/.test(t)) return 'hispanic'
  if (/\brace\b|ethnic/.test(t)) return 'race'
  if (/veteran|military/.test(t)) return 'veteran'
  if (/disab/.test(t)) return 'disability'
  if (/first[- ]?gen/.test(t)) return 'first-gen'
  if (/pronoun/.test(t)) return 'pronouns'
  return null
}

export const fullName = (ctx: MapContext): { first: string; last: string; full: string } => {
  const t = ctx.contact.name.trim().split(/\s+/).filter(Boolean)
  return { first: t[0] ?? '', last: t.slice(1).join(' '), full: ctx.contact.name.trim() }
}

/**
 * The ATS-independent plan builder (spec §6, §8): overrides > the adapter's core fields > LinkedIn > confirmed answers >
 * decline defaults for demographics. Selects resolve to one exact option; legal/consent/pay/essay never get a guess.
 */
export function mapFields(fields: FormField[], ctx: MapContext, core: CoreResolver): PlanItem[] {
  const items: PlanItem[] = []
  const matchAnswer = (label: string): string | null => {
    for (const a of ctx.answers) {
      let hit: boolean
      try { hit = new RegExp(a.question_pattern, 'i').test(label) } catch { hit = label.toLowerCase().includes(a.question_pattern.toLowerCase()) }
      if (hit) return a.answer
    }
    return null
  }

  // A saved answer about the same self-identification topic, whatever its wording ("Disabled" vs "I have a disability").
  const matchDemographic = (label: string): string | null => {
    const topic = demoTopic(label)
    if (!topic) return null
    let best: { id: number; answer: string } | null = null // the newest answer about the topic wins
    for (const a of ctx.answers) if (demoTopic(a.question_pattern.replace(/[\\^$.*+?()[\]{}|]/g, ' ')) === topic && (!best || a.id > best.id)) best = a
    return best ? best.answer : null
  }

  // A confirmed answer to the same yes/no fact (work authorization, sponsorship, age 18) asked in other words; the newest wins.
  const matchFact = (label: string): string | null => {
    const topic = factTopicOf(label)
    if (!topic) return null
    let best: { id: number; answer: string } | null = null
    for (const a of ctx.answers) if (factTopicOf(a.question_pattern.replace(/[\\^$.*+?()[\]{}|]/g, ' ')) === topic && (!best || a.id > best.id)) best = a
    return best ? best.answer : null
  }

  for (const f of fields) {
    const base: PlanItem = {
      name: f.name, label: f.label, kind: f.kind, section: f.section, required: f.required, value: '', source: 'none',
      status: 'skip', sensitivity: f.sensitivity, needsApproval: false, reason: '', options: f.options, optionValues: f.optionValues, declineOption: f.declineOption, hint: f.hint
    }
    let value: string | null = null
    let source: PlanItem['source'] = 'none'
    let note = ''

    const ov = ctx.overrides[f.name]
    const c = ov === undefined || ov === '' ? core(f, ctx) : null
    if (ov !== undefined && ov !== '') { value = ov; source = 'user' }
    else if (c === 'skip') { items.push({ ...base, reason: 'Handled by another input, or left blank' }); continue }
    else if (c) { value = c.value; source = c.source }
    else if (/linkedin/i.test(f.label) && ctx.contact.linkedin) { value = ctx.contact.linkedin; source = 'profile' }
    else if (f.sensitivity === 'consent' && ctx.consent?.(f)) { value = ctx.consent(f); source = 'user' } // the person read this exact wording and approved it for this company
    else {
      const a = f.sensitivity === 'demographic' ? (matchDemographic(f.label) ?? matchAnswer(f.label)) : (matchAnswer(f.label) ?? (f.sensitivity === 'none' || f.sensitivity === 'legal' ? matchFact(f.label) : null))
      const d = a === null && ctx.derive ? ctx.derive(f) : null
      // "Country where you currently reside": answered from the profile's US state, never guessed otherwise
      const country = a === null && /country/i.test(f.label) && /reside|located|live in|based/i.test(f.label) && US_STATES[ctx.contact.state.trim().toUpperCase()] ? 'United States' : null
      if (a !== null) { value = a; source = 'answer' }
      else if (country) { value = country; source = 'profile' }
      else if (d && 'value' in d) { value = d.value; source = 'resume'; note = d.note }
      else if (d && 'unsure' in d) { items.push({ ...base, status: 'needs_user', reason: d.unsure }); continue }
      else if (f.sensitivity === 'none' && ctx.suggest && (f.kind === 'text' || f.kind === 'select' || f.kind === 'multiselect') && ctx.suggest(f)) {
        const sg = ctx.suggest(f)!
        value = sg.value; source = 'suggested'; note = `Suggested from your resume and facts: ${sg.basis}`
      }
      else if (f.sensitivity === 'demographic' && (f.kind === 'select' || f.kind === 'multiselect')) {
        const d = f.declineOption ?? findDecline(f.options) // the form's own "prefer not to answer" option when it marks one
        if (d) { value = d; source = 'default' }
      }
    }

    if (value && (f.kind === 'select' || f.kind === 'multiselect')) {
      const parts = f.kind === 'multiselect' ? value.split('|').map((s) => s.trim()).filter(Boolean) : [value]
      const resolved = parts.map((p) => (f.sensitivity === 'demographic' ? resolveSelfId(f.options, p) : resolveOption(f.options, p)))
      if (resolved.some((r) => r === null) && f.sensitivity === 'demographic' && source === 'answer' && (f.declineOption ?? findDecline(f.options))) {
        // A voluntary question whose saved answer fits none of this form's options: decline rather than stop, and say so.
        items.push({ ...base, value: (f.declineOption ?? findDecline(f.options))!, source: 'default', status: 'ready', needsApproval: false, reason: 'Your saved answer fits none of this form\'s options, so this was declined. Change it if you like.' })
        continue
      }
      if (resolved.some((r) => r === null)) {
        items.push({ ...base, status: 'needs_user', reason: source === 'answer' && f.sensitivity === 'demographic' ? `Your saved answer does not match any option on this form. Choose one.` : `No single option matches "${value}". Choose one.` })
        continue
      }
      value = resolved.join('|')
    }

    if (!value) {
      items.push(f.required
        ? { ...base, status: 'needs_user', reason: f.sensitivity === 'legal' ? 'Legally significant: answer only from your confirmed answers.' : 'No confirmed answer.' }
        : { ...base, reason: 'Optional, left blank' })
      continue
    }
    const needsApproval = ((f.sensitivity === 'consent' || f.sensitivity === 'pay' || f.sensitivity === 'essay') && source !== 'user') || source === 'suggested'
    items.push({ ...base, value, source, status: 'ready', needsApproval, reason: source === 'suggested' ? note : needsApproval ? 'Sensitive: approve for this company before filling.' : note })
  }
  return items
}
