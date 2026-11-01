import type { SearchSettings, SearchResult } from '../../shared/discovery'
import { politeFetch } from '../automation/http'
import { getDb } from '../db'
import { matchEmployer, previousEmployers } from '../history'
import { deleteSecret, getSecret, hasSecret, setSecret } from '../secrets'
import { getSetting, setSetting } from '../settings'
import { getCriteria } from './criteria'
import { countMatches, resolveCompany } from './resolve'
import { parseBoardUrl } from './sources'
import { addBoard } from './store'

const DEFAULTS: SearchSettings = { remotive: true, remoteok: true, adzuna: false, adzunaKeySet: false }
const MAX_TITLES = 6 // search terms per site per run
const MAX_RESOLVE = 40 // new companies probed per run (each probe is up to 21 requests)
const RETRY_DAYS = 14 // a company with no public board is not probed again for this long
const UA = { 'User-Agent': 'Mozilla/5.0 AppliMax5000', Accept: 'application/json' }

export const getSearch = (): SearchSettings => ({ ...DEFAULTS, ...(JSON.parse(getSetting('search') ?? '{}') as Partial<SearchSettings>), adzunaKeySet: hasSecret('adzuna') })
export function setSearch(s: Partial<SearchSettings>): SearchSettings {
  const { remotive, remoteok, adzuna } = { ...getSearch(), ...s }
  setSetting('search', JSON.stringify({ remotive, remoteok, adzuna }))
  return getSearch()
}
/** Adzuna needs a free app id and key from developer.adzuna.com. Kept encrypted in the keychain, never sent to the screen. */
export async function setAdzunaKey(id: string, key: string): Promise<SearchSettings> {
  if (!id.trim() && !key.trim()) deleteSecret('adzuna')
  else await setSecret('adzuna', JSON.stringify({ id: id.trim(), key: key.trim() }))
  return getSearch()
}

interface Lead { company: string; title: string; urls: string[] }

async function json<T>(url: string): Promise<T> {
  const r = await politeFetch(url, { headers: UA }, 2)
  if (!r.ok) throw new Error(`${url.split('?')[0]} returned HTTP ${r.status}`)
  return r.json() as Promise<T>
}

async function remotive(titles: string[]): Promise<Lead[]> {
  const out: Lead[] = []
  for (const t of titles) {
    const d = await json<{ jobs?: { title: string; company_name: string; url: string }[] }>(`https://remotive.com/api/remote-jobs?limit=50&search=${encodeURIComponent(t)}`)
    for (const j of d.jobs ?? []) out.push({ company: j.company_name, title: j.title, urls: [j.url] })
  }
  return out
}

async function remoteok(): Promise<Lead[]> {
  const d = await json<{ position?: string; company?: string; url?: string; apply_url?: string }[]>('https://remoteok.com/api')
  return d.filter((j) => j.position && j.company).map((j) => ({ company: j.company!, title: j.position!, urls: [j.apply_url, j.url].filter(Boolean) as string[] }))
}

async function adzuna(titles: string[], maxAge: number): Promise<Lead[]> {
  const raw = await getSecret('adzuna')
  if (!raw) throw new Error('Adzuna is switched on but has no app id and key. Add them under Job search sites.')
  const { id, key } = JSON.parse(raw) as { id: string; key: string }
  const out: Lead[] = []
  for (const t of titles) {
    const q = new URLSearchParams({ app_id: id, app_key: key, results_per_page: '50', what: t, ...(maxAge > 0 ? { max_days_old: String(maxAge) } : {}) })
    const d = await json<{ results?: { title: string; company?: { display_name?: string }; redirect_url: string }[] }>(`https://api.adzuna.com/v1/api/jobs/us/search/1?${q}`)
    for (const j of d.results ?? []) if (j.company?.display_name) out.push({ company: j.company.display_name, title: j.title, urls: [j.redirect_url] })
  }
  return out
}

const boardUrl = (ats: string, token: string): string =>
  ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${token}` : ats === 'lever' ? `https://jobs.lever.co/${token}` : `https://jobs.ashbyhq.com/${token}`

/**
 * Look for jobs by keyword on public job sites, then follow each one back to the employer's own Greenhouse, Lever or Ashby
 * board and add that board. The normal discovery run then reads every job on it, so the postings are live, show real pay
 * and can be applied to. Nothing is taken from the aggregators except the company name and where the job points.
 */
export async function searchSites(onPhase: (p: string) => void = () => {}): Promise<SearchResult> {
  const s = getSearch()
  const c = getCriteria()
  const res: SearchResult = { leads: 0, companies: 0, added: [], noBoard: 0, errors: [] }
  if (!s.remotive && !s.remoteok && !s.adzuna) return res
  if (!c.targetTitles.length) { res.errors.push('Job sites were not searched: add target titles on the Criteria tab first.'); return res }
  const titles = c.targetTitles.slice(0, MAX_TITLES)

  const leads: Lead[] = []
  const run = async (name: string, f: () => Promise<Lead[]>): Promise<void> => {
    onPhase(`Searching ${name}`)
    try { leads.push(...await f()) } catch (e) { res.errors.push(`${name}: ${(e as Error).message}`) }
  }
  if (s.remotive) await run('Remotive', () => remotive(titles))
  if (s.remoteok) await run('RemoteOK', remoteok)
  if (s.adzuna) await run('Adzuna', () => adzuna(titles, c.maxAgeDays))

  const relevant = leads.filter((l) => countMatches([l.title], c.targetTitles) > 0)
  res.leads = relevant.length

  // One entry per company, skipping everyone the person has ruled out or already has a board for.
  const db = getDb()
  const have = (db.prepare('SELECT name FROM boards').all() as { name: string }[]).map((b) => b.name)
  const mine = previousEmployers().filter((e) => !matchEmployer(e, c.includeCompanies ?? []))
  const tried = JSON.parse(getSetting('search_unresolved') ?? '{}') as Record<string, string>
  const byCompany = new Map<string, Lead[]>()
  for (const l of relevant) {
    const k = l.company.trim().toLowerCase()
    if (!k || matchEmployer(l.company, c.excludeCompanies ?? []) || matchEmployer(l.company, mine) || matchEmployer(l.company, have)) continue
    byCompany.set(k, [...(byCompany.get(k) ?? []), l])
  }
  res.companies = byCompany.size

  const queue = [...byCompany.entries()].filter(([k]) => !(tried[k] && Date.now() - new Date(tried[k]).getTime() < RETRY_DAYS * 86_400_000)).slice(0, MAX_RESOLVE)
  let n = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const [key, ls] = q
      onPhase(`Finding job boards (${++n}/${n + queue.length})`)
      try {
        // A link that already points at an employer board is proof enough; otherwise look the company up by name.
        const direct = ls.flatMap((l) => l.urls).map(parseBoardUrl).find(Boolean)
        const hit = direct ? { name: ls[0].company, ...direct } : await resolveCompany(ls[0].company, 'found by job search', c.targetTitles)
        if (!hit || ('nameVerified' in hit && (!hit.nameVerified || !hit.matches))) { tried[key] = new Date().toISOString(); res.noBoard++; continue }
        await addBoard(boardUrl(hit.ats, hit.token), 'search')
        res.added.push(hit.name)
      } catch (e) {
        tried[key] = new Date().toISOString()
        res.errors.push(`${ls[0].company}: ${(e as Error).message}`)
      }
    }
  }))
  setSetting('search_unresolved', JSON.stringify(tried))
  return res
}
