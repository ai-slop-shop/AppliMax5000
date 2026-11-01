import type { Ats, WorkMode } from '../../shared/discovery'
import { politeFetch } from '../automation/http'

export interface RawJob {
  ats: Ats; token: string; externalId: string
  url: string // canonical posting URL (Greenhouse is normalized so the apply adapter accepts it)
  title: string; company: string; location: string; department: string
  workMode: WorkMode | null
  payMin: number | null; payMax: number | null
  description: string; postedAt: string | null
}

const ENT: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&rsquo;': "'", '&ndash;': '-', '&mdash;': '-' }
const decode = (s: string): string => s.replace(/&(lt|gt|amp|quot|#39|nbsp|rsquo|ndash|mdash);/g, (m) => ENT[m] ?? m)

/** Greenhouse content is entity-escaped HTML. Decode, strip tags, decode again. */
export function htmlToText(html: string): string {
  return decode(decode(html).replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

const toNum = (raw: string): number => {
  const k = /k$/i.test(raw.trim())
  const n = parseFloat(raw.replace(/[,$\sk]/gi, ''))
  return k ? n * 1000 : n
}

/** Annual USD range from free text like "$150,000 - $190,000" or "$75k to $95k". Hourly is converted (x2080). */
export function parsePay(text: string): { min: number; max: number } | null {
  const amt = '\\$\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s?[kK]?)'
  const re = new RegExp(`${amt}\\s*(?:-|–|—|to)\\s*\\$?\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s?[kK]?)`, 'g')
  for (const m of text.matchAll(re)) {
    let lo = toNum(m[1]), hi = toNum(m[2])
    const near = text.slice(m.index, (m.index ?? 0) + m[0].length + 25)
    if (hi < 1000 && /hour|\/hr|per hr/i.test(near)) { lo *= 2080; hi *= 2080 }
    if (lo >= 20000 && hi >= lo && hi < 2_000_000) return { min: Math.round(lo), max: Math.round(hi) }
  }
  return null
}

const mode = (s: string | undefined | null): WorkMode | null => {
  const v = (s ?? '').toLowerCase()
  if (/remote/.test(v)) return 'remote'
  if (/hybrid/.test(v)) return 'hybrid'
  if (/on-?\s?site|in-?office|in-?person/.test(v)) return 'onsite'
  return null
}

export function parseBoardUrl(url: string): { ats: Ats; token: string } | null {
  let m = url.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/)
  if (m && !['embed', 'v1'].includes(m[1])) return { ats: 'greenhouse', token: m[1] }
  m = url.match(/jobs\.lever\.co\/([^/?#]+)/)
  if (m) return { ats: 'lever', token: m[1] }
  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/)
  if (m) return { ats: 'ashby', token: decodeURIComponent(m[1]) }
  return null
}

async function getJson<T>(url: string): Promise<T> {
  const res = await politeFetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url.split('?')[0]} returned HTTP ${res.status}`)
  return res.json() as Promise<T>
}

interface GhJob { id: number; title: string; absolute_url: string; company_name?: string; first_published?: string; updated_at?: string; content?: string
  location?: { name?: string }; metadata?: { name: string; value: unknown }[] | null; departments?: { name: string }[] }
interface LeverJob { id: string; text: string; hostedUrl: string; createdAt?: number; workplaceType?: string; descriptionPlain?: string; additionalPlain?: string
  categories?: { location?: string; department?: string; allLocations?: string[] }; salaryRange?: { min?: number; max?: number; interval?: string } }
interface AshbyJob { id: string; title: string; jobUrl: string; location?: string; department?: string; isListed?: boolean; isRemote?: boolean; workplaceType?: string
  publishedAt?: string; descriptionPlain?: string; secondaryLocations?: { location: string }[]
  compensation?: { compensationTierSummary?: string | null; summaryComponents?: { compensationType: string; interval: string; minValue: number | null; maxValue: number | null }[] } }

export async function fetchBoard(ats: Ats, token: string, nameHint = ''): Promise<{ company: string; jobs: RawJob[] }> {
  if (ats === 'greenhouse') {
    const d = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`)
    const company = d.jobs[0]?.company_name ?? (nameHint || token)
    return { company, jobs: d.jobs.map((j): RawJob => {
      const text = htmlToText(j.content ?? '')
      const meta = (j.metadata ?? []).find((x) => /location type|workplace|work type|remote/i.test(x.name))
      const location = j.location?.name ?? ''
      const pay = parsePay(text)
      return { ats, token, externalId: String(j.id), url: `https://job-boards.greenhouse.io/${token}/jobs/${j.id}`,
        title: j.title.trim(), company, location, department: j.departments?.[0]?.name ?? '',
        workMode: mode(typeof meta?.value === 'string' ? meta.value : null) ?? (/\bremote\b/i.test(location) ? 'remote' : null),
        payMin: pay?.min ?? null, payMax: pay?.max ?? null, description: text, postedAt: j.first_published ?? j.updated_at ?? null }
    }) }
  }
  if (ats === 'lever') {
    const d = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${token}?mode=json`)
    const company = nameHint || token
    return { company, jobs: d.map((j): RawJob => {
      const text = [j.descriptionPlain, j.additionalPlain].filter(Boolean).join('\n')
      const sr = j.salaryRange
      const hourly = /hour/i.test(sr?.interval ?? '')
      const pay = sr?.min && sr?.max ? { min: sr.min * (hourly ? 2080 : 1), max: sr.max * (hourly ? 2080 : 1) } : parsePay(text)
      return { ats, token, externalId: j.id, url: j.hostedUrl, title: j.text.trim(), company,
        location: (j.categories?.allLocations?.join(' | ') ?? j.categories?.location) ?? '', department: j.categories?.department ?? '',
        workMode: mode(j.workplaceType), payMin: pay?.min ?? null, payMax: pay?.max ?? null, description: text,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null }
    }) }
  }
  const d = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`)
  const company = nameHint || token
  return { company, jobs: d.jobs.filter((j) => j.isListed !== false).map((j): RawJob => {
    const text = j.descriptionPlain ?? ''
    const sal = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary' && c.minValue && c.maxValue)
    const mul = sal && /hour/i.test(sal.interval) ? 2080 : 1
    const pay = sal ? { min: sal.minValue! * mul, max: sal.maxValue! * mul } : parsePay(text)
    const locs = [j.location, ...(j.secondaryLocations ?? []).map((x) => x.location)].filter(Boolean).join(' | ')
    return { ats, token, externalId: j.id, url: j.jobUrl, title: j.title.trim(), company, location: locs, department: j.department ?? '',
      workMode: mode(j.workplaceType) ?? (j.isRemote ? 'remote' : null), payMin: pay?.min ?? null, payMax: pay?.max ?? null,
      description: text, postedAt: j.publishedAt ?? null }
  }) }
}

/** Is the posting still live on the employer's own board? Used before a draft is created. */
export async function isLive(ats: Ats, token: string, externalId: string): Promise<boolean> {
  try {
    if (ats === 'greenhouse') return (await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${externalId}`)).ok
    if (ats === 'lever') return (await fetch(`https://api.lever.co/v0/postings/${token}/${externalId}`)).ok
    return (await fetchBoard(ats, token)).jobs.some((j) => j.externalId === externalId)
  } catch { return true } // network trouble is not evidence the posting closed
}
