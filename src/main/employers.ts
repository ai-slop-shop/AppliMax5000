// Pure helpers (no database) so company-name matching can be tested on its own.

const LEGAL_WORDS = /\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g

/** Lowercase words with legal suffixes and punctuation removed: "House-Rx, Inc." -> ["house", "rx"]. */
export const words = (s: string): string[] =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(LEGAL_WORDS, ' ').split(/[^a-z0-9]+/).filter(Boolean)

const squash = (w: string[]): string => w.join('')

/**
 * Do these two names refer to the same company? Spacing, punctuation, case and legal suffixes are ignored, and the
 * shorter name may be a leading run of words of the longer one:
 *   "House Rx" = "HouseRX" = "House-Rx, Inc." = "HouseRx Pharmacy"; "Meta" = "Meta Platforms".
 * Whole words only at the boundary, so "Meta" does not match "Metabase".
 */
export function sameCompany(a: string, b: string): boolean {
  const x = words(a), y = words(b)
  if (!x.length || !y.length) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  // every leading run of the longer name's words, joined without spaces, may equal the whole shorter name
  for (let i = 1; i <= long.length; i++) if (squash(long.slice(0, i)) === squash(short)) return true
  // ...and the same the other way round, for names split differently ("HouseRx" vs "House Rx")
  for (let i = 1; i <= short.length; i++) if (squash(short.slice(0, i)) === squash(long)) return true
  return false
}

/** The first name in `list` that is the same company as `company`, or null. */
export const matchEmployer = (company: string, list: string[]): string | null => list.find((e) => sameCompany(company, e)) ?? null
