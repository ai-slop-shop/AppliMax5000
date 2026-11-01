// Finding an emailed security code. Pure text matching: no model is involved, so the email never leaves this computer,
// and nothing here stores a code.

/** Greenhouse sends these from its own mail domains. Only mail from here is considered. */
export const CODE_SENDERS = ['greenhouse-mail.io', 'greenhouse.io']

const STOP = new Set(['security', 'password', 'verified', 'verify', 'confirm', 'greenhou', 'complete', 'identity', 'external', 'internal', 'document'])
const isCode = (t: string): boolean =>
  /^[A-Za-z0-9]{8}$/.test(t) && !/^[a-z]+$/.test(t) && !/^[A-Z][a-z]{7}$/.test(t) && !STOP.has(t.toLowerCase()) // not a plain word

const plain = (body: string): string =>
  body.replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\r/g, '')

/**
 * The 8-character code in a Greenhouse "security code" email, or null. Tried in order of how specific the layout is:
 * a line that is only the code, then "...code: XXXXXXXX" ending a sentence, then "code is XXXXXXXX" followed by more text.
 * A random-looking token is required (so the word "security" or "Greenhouse" can never be mistaken for it).
 */
export function extractSecurityCode(body: string): string | null {
  const lines = plain(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (const l of lines) if (isCode(l)) return l
  for (const l of lines) { const m = l.match(/code\b.{0,160}?[:\s]([A-Za-z0-9]{8})\s*[.!]?$/i); if (m && isCode(m[1])) return m[1] }
  for (const l of lines) { const m = l.match(/\bcode\s*(?:is)?\s*[:\-]?\s*([A-Za-z0-9]{8})\b/i); if (m && isCode(m[1])) return m[1] }
  return null
}

const suffix = (domain: string, list: string[]): boolean => list.some((d) => domain === d || domain.endsWith('.' + d))
export const isCodeSender = (addr: string): boolean => suffix((addr.split('@')[1] ?? '').toLowerCase(), CODE_SENDERS)
