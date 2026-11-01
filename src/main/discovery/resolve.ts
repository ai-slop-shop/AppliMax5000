import type { Ats, BoardCandidate } from '../../shared/discovery'
import { politeFetch } from '../automation/http'

const LEGAL = /\b(inc|llc|ltd|corp|corporation|co|company)\b/g
const SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|games|game|studios|studio|labs|technologies|technology|entertainment|interactive|software|systems|group|holdings)\b/g
const squash = (s: string): string => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
const core = (s: string): string => squash(s.toLowerCase().replace(SUFFIX, ' '))

/** Board-token guesses for a company name, most specific first. */
export function slugVariants(name: string): { slug: string; exact: boolean }[] {
  const full = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/)
  const noSuffix = name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIX, ' ').trim().split(/\s+/).filter(Boolean)
  const noLegal = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(LEGAL, ' ').trim().split(/\s+/).filter(Boolean)
  const out = [
    { slug: noLegal.join(''), exact: true }, { slug: noLegal.join('-'), exact: true },
    { slug: full.join(''), exact: true }, { slug: full.join('-'), exact: true },
    { slug: noSuffix.join(''), exact: false }, { slug: noSuffix.join('-'), exact: false }, { slug: noSuffix[0] ?? '', exact: false }
  ]
  const seen = new Set<string>()
  return out.filter((v) => v.slug && !seen.has(v.slug) && seen.add(v.slug))
}

// Words too generic to show that a job title relates to the target titles.
const STOP = new Set(['senior', 'junior', 'staff', 'principal', 'lead', 'head', 'manager', 'director', 'associate', 'of', 'and', 'the', 'for', 'ii', 'iii', 'sr', 'jr', 'team', 'global'])
const sig = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !STOP.has(w))

/** How many open titles relate to the target titles (shared significant word, or the whole phrase). */
export function countMatches(titles: string[], targets: string[]): number {
  const words = new Set(targets.flatMap(sig))
  const phrases = targets.map((t) => t.toLowerCase().trim()).filter(Boolean)
  if (!words.size && !phrases.length) return titles.length
  return titles.filter((t) => { const l = t.toLowerCase(); return phrases.some((p) => l.includes(p)) || sig(t).some((w) => words.has(w)) }).length
}

async function json<T>(url: string): Promise<T | null> {
  try { const r = await politeFetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }, 2); return r.ok ? await r.json() as T : null } catch { return null }
}

interface Probe { ats: Ats; token: string; company: string | null; titles: string[] }
async function probe(ats: Ats, token: string): Promise<Probe | null> {
  if (ats === 'greenhouse') {
    const d = await json<{ jobs: { title: string; company_name?: string }[] }>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`)
    return d?.jobs?.length ? { ats, token, company: d.jobs[0].company_name ?? null, titles: d.jobs.map((j) => j.title) } : null
  }
  if (ats === 'lever') {
    const d = await json<{ text: string }[]>(`https://api.lever.co/v0/postings/${token}?mode=json`)
    return Array.isArray(d) && d.length ? { ats, token, company: null, titles: d.map((j) => j.text) } : null
  }
  const d = await json<{ jobs: { title: string }[] }>(`https://api.ashbyhq.com/posting-api/job-board/${token}`)
  return d?.jobs?.length ? { ats, token, company: null, titles: d.jobs.map((j) => j.title) } : null
}

/** Find a company's public job board and count its relevant open roles. Returns null if none is found. */
export async function resolveCompany(name: string, why: string, targets: string[]): Promise<BoardCandidate | null> {
  for (const v of slugVariants(name)) {
    for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
      const p = await probe(ats, v.slug)
      if (!p) continue
      // A name match is proof it's the right company. Lever/Ashby don't report a name, so only an exact slug of the full name counts.
      const nameVerified = p.company ? core(p.company) === core(name) || squash(p.company) === squash(name) : v.exact
      if (p.company && !nameVerified) continue // a different company owns this token
      return { name: p.company ?? name, ats, token: v.slug, jobs: p.titles.length, matches: countMatches(p.titles, targets), why, nameVerified }
    }
  }
  return null
}
