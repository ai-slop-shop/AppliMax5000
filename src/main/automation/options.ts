const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const DECLINE = /decline|don'?t wish|do not wish|prefer not|not wish to|choose not|rather not/i

/**
 * Map an answer to ONE exact option label. Exact match first, then whole-word match,
 * and only if that is unambiguous. Never substring ("Employed" must not pick "Unemployed").
 */
export function resolveOption(options: string[], answer: string): string | null {
  const a = norm(answer)
  if (!a) return null
  const exact = options.filter((o) => norm(o) === a)
  if (exact.length === 1) return exact[0]
  const word = options.filter((o) => new RegExp(`(^| )${a}( |$)`).test(norm(o)))
  return word.length === 1 ? word[0] : null
}

export const findDecline = (options: string[]): string | null => {
  const m = options.filter((o) => DECLINE.test(o))
  return m.length >= 1 ? m[0] : null
}

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
}

const strip = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\+\d+/g, ' ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const ALIASES: Record<string, string[]> = { 'united states': ['united states of america', 'usa', 'us', 'u s', 'america'] }

/**
 * Which of a page's offered options is the one we want? Tolerates decoration (dial codes like "+1", brackets, accents) and
 * common alternate names, but never guesses between genuinely different options.
 * Returns the index, or null when nothing fits, or the candidates when several do.
 */
export function chooseOption(label: string, offered: string[]): number | null | { ambiguous: string[] } {
  const want = strip(label)
  const wants = [want, ...(ALIASES[want] ?? [])]
  const norm = offered.map(strip)
  const same = norm.map((o, i) => (wants.includes(o) ? i : -1)).filter((i) => i >= 0)
  if (same.length === 1) return same[0]
  if (same.length > 1) return { ambiguous: same.map((i) => offered[i]) }
  // otherwise: options that begin with the wanted words ("United States" vs "United States Minor Outlying Islands")
  const starts = norm.map((o, i) => (wants.some((w) => o.startsWith(w + ' ')) ? i : -1)).filter((i) => i >= 0)
  if (starts.length === 1) return starts[0]
  return starts.length ? { ambiguous: starts.map((i) => offered[i]) } : null
}

/** Equal once stray spaces are ignored: forms often define labels like "0 (no experience) " that the page shows trimmed. */
export const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

const STOP = new Set(['i', 'am', 'a', 'an', 'the', 'of', 'or', 'and', 'to', 'as', 'is', 'my', 'one', 'more'])
const NEG = /\b(no|not|none|never|neither)\b/
const words = (s: string): string[] => norm(s.replace(/n't\b/gi, ' not')).split(' ').filter((w) => w && !STOP.has(w))

/**
 * Like resolveOption, for self-identification answers saved from one form and applied to another whose wording differs
 * ("No" or "I am not a protected veteran" vs "No, I am not a veteran"). Never guesses between different meanings:
 * it needs one clear winner among options that agree on yes/no, and never lands on a "prefer not to answer" option unless asked.
 */
export function resolveSelfId(options: string[], answer: string): string | null {
  const exact = resolveOption(options, answer)
  if (exact) return exact
  const wantsDecline = DECLINE.test(answer)
  const pool = options.filter((o) => DECLINE.test(o) === wantsDecline)
  if (wantsDecline) return pool.length === 1 ? pool[0] : null
  const a = norm(answer.replace(/n't\b/gi, ' not'))
  const neg = NEG.test(a)
  const side = pool.filter((o) => NEG.test(norm(o.replace(/n't\b/gi, ' not'))) === neg)
  if (a === 'no' || a === 'yes') return side.length === 1 ? side[0] : (side.filter((o) => norm(o).startsWith(a)).length === 1 ? side.find((o) => norm(o).startsWith(a))! : null)
  const aw = new Set(words(a).filter((w) => w !== 'no' && w !== 'not'))
  const scored = side.map((o) => ({ o, n: words(o).filter((w) => aw.has(w)).length })).filter((s) => s.n > 0).sort((x, y) => y.n - x.n)
  if (!scored.length) return side.length === 1 ? side[0] : null
  if (scored[1] && scored[1].n === scored[0].n) return null
  return scored[0].o
}
