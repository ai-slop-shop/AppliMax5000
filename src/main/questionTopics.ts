// Pure helpers (no database): decide which scanned questions are really the same one. Deliberately conservative:
// a wrong merge would make one saved answer fill a question it does not fit, so only low-risk families are merged.

const STOP = new Set(['a', 'an', 'the', 'please', 'kindly', 'optional', 'your', 'you', 'to', 'of', 'for', 'us', 'our', 'we'])

/** Wording-insensitive form of a question: "(Optional) LinkedIn Profile *" and "linkedin profile" become the same string. */
export function normKey(label: string): string {
  return label.toLowerCase().replace(/\(optional\)|\boptional\b/g, ' ').replace(/[^a-z0-9<> ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ')
}

/**
 * A family tag for common profile-style questions that are asked in many wordings but always want the same thing.
 * Questions that name a place, a percentage or a destination (relocation, in-office days) are NOT merged: the right
 * answer can differ between "SF" and "Seattle".
 */
export function topicOf(label: string): string | null {
  const l = label.toLowerCase()
  if (/linked\s?in/.test(l)) return 'linkedin'
  if (/github|git hub/.test(l)) return 'github'
  if (/\b(website|web site|portfolio|personal (site|page)|homepage)\b/.test(l) && !/publication|scholar|reference/.test(l)) return 'website'
  if (/preferred (first )?name|nickname|name you (go by|prefer)|what should we call you/.test(l)) return 'preferred-name'
  if (/(earliest|when (can|could|would|will) you .*start|availab\w* to start|start date|how soon (can|could) you)/.test(l)) return 'start-date'
  if (/(how did you (hear|find|learn)|where did you (hear|find|learn)|how you heard|referral source|source of (your )?(application|referral))/.test(l)) return 'referral-source'
  if (/(current|present|most recent) (company|employer|organi[sz]ation)/.test(l)) return 'current-employer'
  return null
}

const OTHER_COUNTRY = /\b(canada|canadian|uk|u\.k\.|united kingdom|britain|ireland|india|germany|france|spain|netherlands|poland|australia|new zealand|mexico|brazil|israel|singapore|japan|china|eu|european union|europe|emea|apac)\b/

/**
 * Yes/no facts asked in many wordings whose answer is the same for every posting: work authorization, visa sponsorship, minimum age.
 * The answer still comes only from the person's own confirmed answer. A question naming another country, or mixing
 * authorization with sponsorship in one sentence (opposite polarity), is left alone.
 */
export function factTopicOf(label: string): string | null {
  const l = label.toLowerCase()
  if (/\b(at least|over|older than|minimum age of|age of)\s+(the age of\s+)?(18|eighteen)\b|\b(18|eighteen)\s+(years|yrs)\s+(of age|old|or older)|\b(18|eighteen)\+|are you (18|eighteen)\b/.test(l)) return 'age-18'
  if (OTHER_COUNTRY.test(l)) return null
  const sponsor = /sponsor/.test(l)
  const auth = /(authori[sz]ed|eligible|allowed|permitted|legally|lawfully|right) .{0,30}\bwork\b|\bwork\b.{0,40}(authori[sz]ation|legally|lawfully)/.test(l)
  if (sponsor && auth) return null
  if (sponsor) return 'sponsorship'
  if (auth) return 'work-auth'
  return null
}

export interface QRow { id: number; label: string; kind: string; sensitivity: string; seen: number; group_id: number | null; answered: boolean }
const family = (kind: string): string => (kind === 'select' || kind === 'multiselect' ? 'select' : kind === 'file' ? 'file' : 'text')

/**
 * Which questions should be folded into which. Returns member id -> canonical id. Only top-level (ungrouped) questions
 * are considered; the canonical is the one that already has an answer, else the one seen most, else the oldest.
 */
export function planMerges(rows: QRow[]): Map<number, number> {
  const out = new Map<number, number>()
  const buckets = new Map<string, QRow[]>()
  for (const r of rows) {
    if (r.group_id != null || r.kind === 'file' || r.kind === 'textarea' && r.sensitivity !== 'none') continue
    const t = r.sensitivity === 'none' ? topicOf(r.label) ?? factTopicOf(r.label) : r.sensitivity === 'legal' ? factTopicOf(r.label) : null
    const keys = [`n:${family(r.kind)}:${r.sensitivity}:${normKey(r.label)}`] // same words after cleanup: safe for every class
    if (t) keys.push(`t:${family(r.kind)}:${t}`)
    for (const k of keys) buckets.set(k, [...(buckets.get(k) ?? []), r])
  }
  const pick = (g: QRow[]): QRow => [...g].sort((a, b) => Number(b.answered) - Number(a.answered) || b.seen - a.seen || a.id - b.id)[0]
  for (const g of buckets.values()) {
    if (g.length < 2) continue
    const canon = pick(g.filter((r) => !out.has(r.id)))
    if (!canon) continue
    for (const r of g) if (r.id !== canon.id && !out.has(r.id) && !out.has(canon.id)) out.set(r.id, canon.id)
  }
  return out
}
