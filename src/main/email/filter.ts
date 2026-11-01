// The local gate. Nothing that fails here is ever read further or sent anywhere. Pure functions, no I/O.

export interface Header { fromAddr: string; fromName: string; subject: string; hasListUnsub: boolean; bulk: boolean }

/** Applicant tracking systems that send application confirmations and updates on employers' behalf. */
const ATS = ['greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com', 'myworkday.com', 'myworkdayjobs.com', 'workday.com', 'icims.com', 'smartrecruiters.com',
  'jobvite.com', 'workablemail.com', 'workable.com', 'breezy.hr', 'bamboohr.com', 'recruitee.com', 'teamtailor.com', 'applytojob.com', 'jazz.co', 'taleo.net',
  'successfactors.com', 'successfactors.eu', 'eightfold.ai', 'hirevue.com', 'pinpointhq.com', 'gem.com', 'dover.com', 'paylocity.com', 'ultipro.com', 'paycomonline.net', 'adp.com']
/** Job boards that relay employer responses. Their marketing and alert emails are dropped by the subject rules below. */
const BOARDS = ['linkedin.com', 'indeed.com', 'indeedemail.com', 'dice.com', 'ziprecruiter.com', 'glassdoor.com', 'builtin.com', 'wellfound.com', 'flexjobs.com', 'hired.com']

const RESPONSE = /thank you for (applying|your (application|interest))|application (received|confirmation|status|update|was received|has been)|your application (to|for|with|at)|we('| a)?re (excited|pleased|delighted) to|interview|next steps?|phone screen|schedule (a|your) (call|chat|time|conversation)|move forward|moving forward|not (be )?(moving|proceeding|selected)|unfortunately|regret to inform|offer( letter)?\b|assessment|coding (challenge|exercise)|take-?home|candidacy|your candidacy|hiring team|recruit(er|ing) (team|coordinator)|application for/i
const ALERT = /job alerts?|new jobs? (for you|match|that)|recommended (jobs|for you)|jobs? you may (like|be interested)|people also viewed|weekly (digest|jobs)|daily (digest|jobs)|\b\d+\+? new (jobs?|roles?|matches)|top jobs|jobs near you|similar jobs|who viewed your profile|you appeared in|newsletter|webinar|career (tips|advice)/i

const domainOf = (addr: string): string => (addr.split('@')[1] ?? '').toLowerCase()
const inList = (domain: string, list: string[]): boolean => list.some((d) => domain === d || domain.endsWith('.' + d))
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Company names the user has actually dealt with, as lowercase letters-and-digits slugs. */
export const companySlugs = (names: string[]): string[] => [...new Set(names.map(squash).filter((n) => n.length >= 4))]

function fromKnownCompany(domain: string, slugs: string[]): boolean {
  // "careers.acmecorp.com" matches "Acme Corp" or "Acme"; the registrable label is the second-from-last part
  const label = squash(domain.split('.').slice(-2, -1)[0] ?? '')
  return !!label && slugs.some((s) => label.includes(s) || (label.length >= 4 && s.includes(label)))
}

export function looksJobRelated(h: Header, known: string[]): { pass: boolean; why: string } {
  const d = domainOf(h.fromAddr)
  const alert = ALERT.test(h.subject)
  const response = RESPONSE.test(h.subject)
  if (alert) return { pass: false, why: 'alert or newsletter subject' }
  if (inList(d, ATS)) return { pass: true, why: 'applicant tracking system sender' }
  if (fromKnownCompany(d, known) && (response || !h.hasListUnsub)) return { pass: true, why: 'sender is a company you applied to' }
  if (inList(d, BOARDS)) return response && !h.hasListUnsub ? { pass: true, why: 'job board response' } : { pass: false, why: 'job board marketing' }
  if (response && !h.hasListUnsub && !h.bulk) return { pass: true, why: 'subject reads like a hiring response' }
  return { pass: false, why: 'not recognizably a hiring email' }
}
