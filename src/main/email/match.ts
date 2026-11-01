import { sameCompany } from '../employers'

export interface AppRow { id: number; company: string; title: string; submitted_at: string | null }
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Which submitted application does this email belong to? Company must match (spelling variants allowed).
 * With several applications at one company, the role title decides; if that is still unclear, nothing is matched
 * rather than guessed.
 */
export function matchApplication(apps: AppRow[], ev: { company: string; role: string; date: string }): { id: number | null; why: string } {
  if (!ev.company.trim()) return { id: null, why: 'no company in the email' }
  const sameCo = apps.filter((a) => sameCompany(a.company, ev.company))
  if (!sameCo.length) return { id: null, why: 'no application to that company' }
  if (sameCo.length === 1) return { id: sameCo[0].id, why: 'only application at that company' }
  const role = slug(ev.role)
  if (role.length >= 4) {
    const byRole = sameCo.filter((a) => { const t = slug(a.title); return t && (t.includes(role) || role.includes(t)) })
    if (byRole.length === 1) return { id: byRole[0].id, why: 'role title matches' }
  }
  return { id: null, why: 'several applications at that company and the role is unclear' }
}
