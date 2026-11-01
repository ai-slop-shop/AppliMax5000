import { Notification, shell } from 'electron'
import type { AppChoice, EmailAccount, EmailConnect, EmailEvent, ScanSummary } from '../../shared/email'
import { getDb } from '../db'
import { applyHistoryToQueue } from '../history'
import { deleteSecret, getSecret, hasSecret, setSecret } from '../secrets'
import { getSetting, setSetting } from '../settings'
import { llmClassifier } from './classify'
import { graphSource, whoAmI } from './graph'
import { cancelSignIn, MS, refreshTokens, signIn, type OAuthCfg } from './oauth'
import { PRESETS, testConnection, withSource } from './imap'
import { extractSecurityCode, isCodeSender } from './code'
import { applyOne, assignEvent, scanMailbox, undoEvent, waitForCode, type CodeHit } from './pipeline'

const KEY = 'email_account'
type Stored = Omit<EmailAccount, 'connected'>
const DEFAULT: Stored = { provider: 'gmail', host: PRESETS.gmail.host, port: 993, user: '', clientId: '', autoScan: false, autoApply: true, autoCode: true, lastScan: null }

export function getAccount(): EmailAccount {
  const s = { ...DEFAULT, ...(JSON.parse(getSetting(KEY) ?? '{}') as Partial<Stored>) }
  return { ...s, connected: !!s.user && hasSecret(s.provider === 'outlook' ? 'email_refresh' : 'email') }
}
const save = (s: Partial<Stored>): void => setSetting(KEY, JSON.stringify({ ...DEFAULT, ...(JSON.parse(getSetting(KEY) ?? '{}') as Partial<Stored>), ...s }))

export async function connect(c: EmailConnect): Promise<EmailAccount> {
  if (c.provider === 'outlook') throw new Error('Use "Sign in with Microsoft" for Outlook.')
  const preset = PRESETS[c.provider]
  const host = (c.provider === 'custom' ? c.host : preset.host).trim()
  const port = c.provider === 'custom' ? c.port : preset.port
  if (!host || !c.user.trim() || !c.password) throw new Error('Enter your email address and an app password.')
  await testConnection({ ...c, host, port }) // throws a readable message if the server says no
  await setSecret('email', c.password) // encrypted with the OS keychain; never sent to the page
  save({ provider: c.provider, host, port, user: c.user.trim() })
  return getAccount()
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cfgFor = (clientId: string): OAuthCfg => ({ clientId, authority: MS.authority, scopes: MS.scopes })

/** Outlook.com and Microsoft 365: sign in through the browser. The app only ever holds a read-only (Mail.Read) token. */
export async function connectOutlook(clientId: string): Promise<EmailAccount> {
  const id = clientId.trim()
  if (!GUID.test(id)) throw new Error('That does not look like an Application (client) ID. It is a 36-character code like 1a2b3c4d-1234-5678-9abc-def012345678.')
  const t = await signIn(cfgFor(id), (url) => { void shell.openExternal(url) })
  if (!t.refresh_token) throw new Error('Microsoft did not allow the app to stay signed in. In your app registration, make sure the offline_access permission is present.')
  const user = await whoAmI(t.access_token)
  await setSecret('email_refresh', t.refresh_token) // encrypted with the OS keychain
  save({ provider: 'outlook', host: '', port: 0, user, clientId: id })
  return getAccount()
}
export const cancelOutlook = (): void => cancelSignIn()

/** Forget the login. With purge, also delete everything recognized from email. */
export function disconnect(purge: boolean): EmailAccount {
  deleteSecret('email'); deleteSecret('email_refresh')
  save({ user: '', autoScan: false, lastScan: null })
  if (purge) { const db = getDb(); db.prepare('DELETE FROM email_events').run(); db.prepare('DELETE FROM email_seen').run() }
  return getAccount()
}
export const setOptions = (o: { autoScan?: boolean; autoApply?: boolean; autoCode?: boolean }): EmailAccount => { save(o); return getAccount() }

let scanning = false
export const isScanning = (): boolean => scanning

export async function scan(days: number | null, onOpen?: () => void): Promise<ScanSummary> {
  if (scanning) throw new Error('A scan is already running.')
  const acct = getAccount()
  if (!acct.connected) throw new Error('Connect your email first.')
  scanning = true
  try {
    const since = new Date(Date.now() - (days ?? (acct.lastScan ? Math.max(2, Math.ceil((Date.now() - new Date(acct.lastScan).getTime()) / 86_400_000) + 1) : 30)) * 86_400_000)
    const run = (src: Parameters<typeof scanMailbox>[1]): ReturnType<typeof scanMailbox> => scanMailbox(getDb(), src, { since, classify: llmClassifier, autoApply: acct.autoApply })
    let r: Awaited<ReturnType<typeof scanMailbox>>
    if (acct.provider === 'outlook') {
      const refresh = await getSecret('email_refresh')
      if (!refresh) throw new Error('Connect your email first.')
      const t = await refreshTokens(cfgFor(acct.clientId), refresh)
      if (t.refresh_token && t.refresh_token !== refresh) await setSecret('email_refresh', t.refresh_token) // Microsoft rotates them
      r = await run(graphSource(t.access_token))
    } else {
      const password = await getSecret('email')
      if (!password) throw new Error('Connect your email first.')
      r = await withSource({ provider: acct.provider, host: acct.host, port: acct.port, user: acct.user, password }, run)
    }
    if (!r.errors.length) save({ lastScan: new Date().toISOString() }) // after an error, the next scan covers the same window again

    const worth = r.newOutcomes.filter((o) => ['interview', 'offer', 'screen'].includes(o.category))
    if (worth.length && Notification.isSupported()) {
      const n = new Notification({ title: worth.some((o) => o.category === 'offer') ? 'Job offer email' : 'Good news in your inbox',
        body: worth.slice(0, 3).map((o) => `${o.category === 'offer' ? 'Offer' : o.category === 'interview' ? 'Interview' : 'Screen'}: ${o.company || 'a company'}`).join('\n') })
      if (onOpen) n.on('click', onOpen)
      n.show()
    }
    const { newOutcomes: _unused, ...summary } = r
    void _unused
    return summary
  } finally { scanning = false }
}

/** Scheduled scans: every three hours while the app is open, if the user turned that on. */
export function autoScanDue(): boolean {
  const a = getAccount()
  return a.connected && a.autoScan && !scanning && (!a.lastScan || Date.now() - new Date(a.lastScan).getTime() > 3 * 3_600_000)
}

type Row = { id: number; date: string; from_addr: string; subject: string; category: EmailEvent['category']; company: string; role: string; confidence: EmailEvent['confidence']
  evidence: string; application_id: number | null; applied: number; added_past: number; ignored: number }
export function listEvents(): EmailEvent[] {
  return (getDb().prepare('SELECT * FROM email_events ORDER BY date DESC, id DESC LIMIT 300').all() as Row[]).map((r) => ({
    id: r.id, date: r.date, from: r.from_addr, subject: r.subject, category: r.category, company: r.company, role: r.role, confidence: r.confidence, evidence: r.evidence,
    applicationId: r.application_id, applied: !!r.applied, addedPast: !!r.added_past, ignored: !!r.ignored
  }))
}
export const appChoices = (): AppChoice[] =>
  (getDb().prepare(`SELECT a.id, j.company, j.title FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.attempt_status = 'submitted' ORDER BY a.id DESC`).all() as { id: number; company: string; title: string }[])
    .map((a) => ({ id: a.id, label: `${a.company}: ${a.title}` }))

export const assign = (id: number, appId: number | null): EmailEvent[] => { assignEvent(getDb(), id, appId, getAccount().autoApply); return listEvents() }
export const applyNow = (id: number): EmailEvent[] => { applyOne(getDb(), id); return listEvents() }
export const undo = (id: number): EmailEvent[] => { undoEvent(getDb(), id); return listEvents() }

/** An unmatched confirmation shows you applied somewhere the app did not know about: remember it so it is never repeated. */
export function addToPast(id: number): EmailEvent[] {
  const db = getDb()
  const e = db.prepare('SELECT company, role, date FROM email_events WHERE id = ?').get(id) as { company: string; role: string; date: string } | undefined
  if (e?.company) {
    db.prepare('INSERT INTO past_applications (company, title, url, applied_at, note) VALUES (?, ?, ?, ?, ?)').run(e.company, e.role, '', e.date, 'From a confirmation email')
    db.prepare('UPDATE email_events SET added_past = 1 WHERE id = ?').run(id)
    applyHistoryToQueue()
  }
  return listEvents()
}

/**
 * A site has just asked for the security code it emailed to the applicant. Look for that email, only in mail that
 * arrived since `since`, only from the site's mail domains. Returns null if the email is not connected, the user turned this
 * off, or nothing arrives in time. The code is returned to the caller and kept nowhere.
 */
export async function waitForVerificationCode(since: Date, timeoutMs: number): Promise<{ hit: CodeHit | null; why: 'ok' | 'not_connected' | 'off' | 'timeout' }> {
  const acct = getAccount()
  if (!acct.connected) return { hit: null, why: 'not_connected' }
  if (!acct.autoCode) return { hit: null, why: 'off' }
  const opts = { since, timeoutMs, isSender: isCodeSender, extract: extractSecurityCode }
  let hit: CodeHit | null
  if (acct.provider === 'outlook') {
    const refresh = await getSecret('email_refresh')
    if (!refresh) return { hit: null, why: 'not_connected' }
    const t = await refreshTokens(cfgFor(acct.clientId), refresh)
    if (t.refresh_token && t.refresh_token !== refresh) await setSecret('email_refresh', t.refresh_token)
    hit = await waitForCode(graphSource(t.access_token), opts)
  } else {
    const password = await getSecret('email')
    if (!password) return { hit: null, why: 'not_connected' }
    hit = await withSource({ provider: acct.provider, host: acct.host, port: acct.port, user: acct.user, password }, (src) => waitForCode(src, opts))
  }
  return { hit, why: hit ? 'ok' : 'timeout' }
}
