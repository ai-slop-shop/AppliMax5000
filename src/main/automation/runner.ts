import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import type { ApplyPlan, FillResult, PlanItem, SubmitResult } from '../../shared/apply'
import { getDb } from '../db'
import { getDraft } from '../drafts'
import { addAnswer, rememberSelfId } from '../answers'
import { renderCoverLetterPdf, renderPdf } from '../export'
import { adapterFor as findAdapter } from './registry'
import { makeContext } from './context'
import { answerQuestion, ensureAnalyzed, questionKey, rememberAnswer } from '../questions'
import { findPrior } from '../history'
import { missingAfterFill } from './presence'
import { detectChanges } from './values'
import { waitForVerificationCode } from '../email/service'
import type { AtsAdapter } from './adapter'

const COOLDOWN_DAYS = 14 // per company (spec §12)
const MIN_GAP_MS = 60_000 // between submissions

interface Session {
  submittedAt?: number; beforeShot?: string
  formCompany: string
  mismatches: string[]
  draftId: number; ctx: BrowserContext; page: Page; adapter: AtsAdapter; plan: PlanItem[]
  applicationId: number; dir: string; closed: boolean; dryRunClean: boolean
}
let session: Session | null = null
let lastSubmitAt = 0

const adapterFor = (url: string): AtsAdapter => {
  const a = findAdapter(url)
  if (!a) throw new Error('No adapter for this URL. Supported: Greenhouse, Lever and Ashby posting URLs.')
  return a
}
const dirFor = (draftId: number): string => {
  const d = join(app.getPath('userData'), 'applications', String(draftId))
  mkdirSync(d, { recursive: true })
  return d
}
const dataUrl = (path: string): string => `data:image/png;base64,${readFileSync(path).toString('base64')}`

/** Per-company cooldown (spec §12), plus Ashby's published limits: 3 applications per 60 days, no re-apply within 180 days. */
function cooldownReason(company: string, adapter: AtsAdapter, jobUrl: string): string | null {
  const db = getDb()
  const recent = db.prepare(`SELECT a.submitted_at FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE lower(j.company) = lower(?) AND a.attempt_status = 'submitted' AND a.submitted_at > datetime('now', ?) ORDER BY a.submitted_at DESC LIMIT 1`)
    .get(company, `-${COOLDOWN_DAYS} days`) as { submitted_at: string } | undefined
  if (recent) return `You already applied to ${company} on ${recent.submitted_at}. Cooldown is ${COOLDOWN_DAYS} days.`
  if (adapter.name === 'ashby') {
    const again = db.prepare(`SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.url = ? AND a.attempt_status = 'submitted' AND a.submitted_at > datetime('now', '-180 days')`).get(jobUrl)
    if (again) return 'Ashby does not allow re-applying to the same job within 180 days.'
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE lower(j.company) = lower(?) AND a.attempt_status = 'submitted' AND a.submitted_at > datetime('now', '-60 days')`).get(company) as { n: number }).n
    if (n >= 3) return `Ashby limits applications to 3 per 60 days per company; you have ${n} at ${company}.`
  }
  return null
}

export async function buildPlan(draftId: number, overrides: Record<string, string> = {}, remember: string[] = []): Promise<ApplyPlan> {
  const draft = getDraft(draftId)
  const adapter = adapterFor(draft.posting.url)
  // Answers the user typed in the plan screen and asked to keep become stored, user-confirmed answers.
  const form = await adapter.loadForm(draft.posting.url)
  await ensureAnalyzed(form.fields, form.company, draft.posting.url) // record the questions first so remembered answers attach to them
  for (const name of remember) {
    const f = form.fields.find((x) => x.name === name)
    if (f && overrides[name] && !(f.sensitivity === 'demographic' && rememberSelfId(f.label, overrides[name])) && !rememberAnswer(f.label, form.company, overrides[name])) addAnswer(`^${f.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, overrides[name])
  }
  const coverLetter = draft.coverLetter.map((p) => p.text).join('\n\n')
  const company = draft.posting.company || form.company
  const items = adapter.mapAnswers(form.fields, makeContext({ resume: draft.resume, overrides, coverLetter, resumePath: 'PENDING', coverLetterPath: coverLetter ? 'PENDING' : '', company: form.company }))
  return {
    draftId, company, formCompany: form.company, title: form.title, items,
    ready: items.every((i) => i.status !== 'needs_user'), cooldown: cooldownReason(company, adapter, draft.posting.url),
    blocked: findPrior({ url: draft.posting.url, company, title: draft.posting.title || form.title })?.message ?? null
  }
}

/** Plan must be complete and every sensitive item approved by the user. */
function assertRunnable(plan: ApplyPlan, approvals: Record<string, boolean>, allowCooldown: boolean): void {
  if (plan.blocked) throw new Error(plan.blocked) // never overridable: remove the past record in the Tracker if it is wrong
  if (plan.cooldown && !allowCooldown) throw new Error(plan.cooldown)
  const open = plan.items.filter((i) => i.status === 'needs_user')
  if (open.length) throw new Error(`Needs your input: ${open.map((i) => i.label).join('; ')}`)
  const unapproved = plan.items.filter((i) => i.status === 'ready' && i.needsApproval && !approvals[i.name])
  if (unapproved.length) throw new Error(`Approve these first: ${unapproved.map((i) => i.label).join('; ')}`)
}

function logApplication(draftId: number, fields: Record<string, string | number | null>): number {
  const db = getDb()
  const d = getDraft(draftId)
  const existing = db.prepare("SELECT id FROM applications WHERE job_id = ? AND attempt_status IN ('planned','filled')").get(d.jobId) as { id: number } | undefined
  let id = existing?.id
  if (!id) id = Number(db.prepare("INSERT INTO applications (job_id, resume_version, cover_letter, variant, draft_id) VALUES (?, ?, ?, ?, ?)")
    .run(d.jobId, `${d.variant}:draft${draftId}`, d.coverLetter.map((p) => p.text).join('\n\n'), d.variant, draftId).lastInsertRowid)
  const keys = Object.keys(fields)
  if (keys.length) db.prepare(`UPDATE applications SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id })
  return id
}

async function openContext(): Promise<BrowserContext> {
  const dir = join(app.getPath('userData'), 'browser-profile')
  // The user's installed Chrome, with a dedicated profile. Falls back to Playwright's bundled Chromium.
  try { return await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, viewport: null }) }
  catch { return await chromium.launchPersistentContext(dir, { headless: false }) }
}

export async function closeSession(): Promise<void> {
  const s = session
  session = null
  if (s && !s.closed) { s.closed = true; await s.ctx.close().catch(() => {}) }
}

/** Open the form, fill it from the plan, verify every value, screenshot. Never submits. */
export async function fillForm(draftId: number, overrides: Record<string, string>, approvals: Record<string, boolean>, allowCooldown = false, remember: string[] = []): Promise<FillResult> {
  await closeSession()
  const plan = await buildPlan(draftId, overrides, remember)
  assertRunnable(plan, approvals, allowCooldown)
  const draft = getDraft(draftId)
  const adapter = adapterFor(draft.posting.url)
  const dir = dirFor(draftId)

  const resumePath = join(dir, 'resume.pdf')
  writeFileSync(resumePath, await renderPdf(draft.resume))
  const form = await adapter.loadForm(draft.posting.url)
  const coverLetter = draft.coverLetter.map((p) => p.text).join('\n\n')
  let coverLetterPath = ''
  if (coverLetter) {
    coverLetterPath = join(dir, 'cover-letter.pdf')
    writeFileSync(coverLetterPath, await renderCoverLetterPdf(draft.resume, draft.coverLetter.map((p) => p.text)))
  }
  const live = adapter.mapAnswers(form.fields, makeContext({ resume: draft.resume, overrides, coverLetter, resumePath, coverLetterPath, company: form.company }))

  const ctx = await openContext()
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  page.setDefaultTimeout(10_000) // a missing element should fail in seconds, not after Playwright's 30s default
  const s: Session = { formCompany: form.company, mismatches: [], draftId, ctx, page, adapter, plan: live, applicationId: 0, dir, closed: false, dryRunClean: false }
  ctx.on('close', () => { s.closed = true })
  session = s

  try {
    await page.goto(form.applyUrl, { waitUntil: 'domcontentloaded' })
    // No form within 20s usually means a login wall, an account requirement, or a closed posting. We never create accounts.
    await adapter.waitForForm(page).catch(() => {
      throw new Error('Application form did not appear (login/account required, or the posting is closed). Nothing was filled.')
    })
    const present = new Set(await adapter.readForm(page))
    const missing = live.filter((i) => i.status === 'ready' && !i.domOnly && !present.has(i.name))
    const missingRequired = missing.filter((i) => i.required)
    if (missingRequired.length) throw new Error(`The application page is laid out differently from what this app expects, so it could not find: ${missingRequired.map((i) => i.label).join(', ')}. Your answers are fine and nothing was filled or submitted. This is a gap in the app's support for this form: please report it.`)
    const runnable = live.map((i) => (missing.includes(i) ? { ...i, status: 'skip' as const, reason: 'Not present on the live page' } : i))
    s.plan = runnable

    // Fill one field at a time: a field that cannot be set is reported for you to fix by hand in the open browser,
    // instead of aborting everything and closing the window.
    const fillErrors: string[] = []
    for (const it of runnable) {
      try { await adapter.fill(page, [it]) } catch (e) { fillErrors.push(`${it.label}: could not be set automatically. ${(e as Error).message.split('\n')[0]}`) }
    }
    const problems = await adapter.verify(page, runnable)
    const mismatches = [...fillErrors, ...problems.filter((m) => !fillErrors.some((f) => f.startsWith(m.split(':')[0])))]
    const shot = join(dir, 'before.png')
    await page.screenshot({ path: shot, fullPage: true })
    s.mismatches = mismatches
    s.applicationId = logApplication(draftId, { attempt_status: 'filled', screenshot_before: shot, notes: mismatches.length ? `Mismatches: ${mismatches.join(' | ')}` : null })
    s.dryRunClean = mismatches.length === 0
    return { mismatches, missingFields: missing.map((i) => i.label), screenshot: dataUrl(shot), challenge: await adapter.detectChallenge(page), changed: [] }
  } catch (e) {
    // Abort cleanly; do not retry blindly. The job stays queued.
    logApplication(draftId, { attempt_status: 'aborted', notes: (e as Error).message })
    await closeSession()
    throw e
  }
}

/** Submit the already-filled, already-verified form. Called only from an explicit user click. */
/** True for the "could not be checked automatically" kind: the person can confirm these by eye. A real wrong value cannot be waved through. */
const unreadable = (m: string): boolean => /could not be checked automatically/.test(m)

export async function submitForm(acknowledgeUnreadable = false): Promise<SubmitResult> {
  const s = session
  if (!s) throw new Error('No open form. Fill it first.')
  const stop = (note: string): SubmitResult => ({ status: 'aborted', note, confirmationUrl: '', screenshot: '' })
  const d = getDraft(s.draftId)
  const dup = findPrior({ url: d.posting.url, company: d.posting.company, title: d.posting.title })
  if (dup) return stop(`${dup.message} Nothing was submitted.`)
  if (s.closed || s.page.isClosed()) { logApplication(s.draftId, { attempt_status: 'aborted', notes: 'Browser session closed before submit' }); await closeSession(); return stop('The browser window was closed or reset. Nothing was submitted; the job is still queued.') }
  if (!s.dryRunClean && !(acknowledgeUnreadable && s.mismatches.every(unreadable))) return stop('Verification found problems. Fix them in the open browser, then use Re-verify.')
  if (Date.now() - lastSubmitAt < MIN_GAP_MS) return stop('Submitting too quickly after the previous application. Wait a minute.')

  const present = new Set(await s.adapter.readForm(s.page))
  const gone = missingAfterFill(s.plan, present)
  if (gone.length) {
    // Is the form still there at all? If so this is a page quirk, not a reset: keep the window and your work, and ask for a re-check.
    const formStillThere = await s.adapter.waitForForm(s.page).then(() => true, () => false)
    if (formStillThere) {
      s.dryRunClean = false
      return stop(`These fields can no longer be found on the page: ${gone.map((i) => i.label).join(', ')}. Your window is still open. Look at it, press Re-verify, and try again. Nothing was submitted.`)
    }
    logApplication(s.draftId, { attempt_status: 'aborted', notes: 'The application page went away before submit' })
    await closeSession()
    return stop('The application page is gone (it reset or navigated away). Nothing was submitted; fill the form again.')
  }
  const unticked = await s.adapter.untickedRequired?.(s.page).catch(() => []) ?? []
  if (unticked.length) { s.dryRunClean = false; return stop(`The form has required box(es) the app does not know about and will not tick on its own: ${unticked.join(' | ')}. Look at the open window; nothing was submitted.`) }
  const again = (await s.adapter.verify(s.page, s.plan)).filter((m) => !unreadable(m))
  if (again.length) { s.dryRunClean = false; return stop(`Values changed since verification: ${again.join(' | ')}`) }

  const before = join(s.dir, 'submit-before.png')
  await s.page.screenshot({ path: before, fullPage: true })
  await s.adapter.submit(s.page)
  lastSubmitAt = Date.now()
  s.submittedAt = lastSubmitAt; s.beforeShot = before
  return afterSubmit(s, before)
}

/**
 * Right after Submit the site either confirms, or first asks for a code it emailed to the applicant. Give the page a few
 * seconds to show one or the other; if it is the code prompt, deal with it, otherwise carry on to the usual confirmation check.
 */
async function afterSubmit(s: Session, before: string): Promise<SubmitResult> {
  for (let i = 0; i < 12 && !s.page.isClosed(); i++) {
    if (/\/(confirmation|thanks)\b/i.test(s.page.url())) break
    if (await s.adapter.needsVerificationCode?.(s.page).catch(() => false)) return codeStep(s, before)
    await s.page.waitForTimeout(1000)
  }
  return finish(s, before)
}

const CODE_HELP = 'Type it into the open browser window, press Submit there, then press "Check confirmation".'

/** The page is asking for an emailed code. Fetch it from the connected mailbox, type it in, and submit again. */
async function codeStep(s: Session, before: string): Promise<SubmitResult> {
  const needUser = (note: string): SubmitResult => { logApplication(s.draftId, { notes: note }); return { status: 'needs_user', note, confirmationUrl: '', screenshot: '' } }
  if (!s.adapter.enterVerificationCode) return needUser(`The site emailed you a security code. ${CODE_HELP}`)
  const { hit, why } = await waitForVerificationCode(new Date((s.submittedAt ?? Date.now()) - 30_000), 120_000)
  if (!hit) {
    return needUser(why === 'not_connected' ? `The site emailed you a security code. ${CODE_HELP} (Connect your email on the Inbox tab and the app will find and enter these codes for you.)`
      : why === 'off' ? `The site emailed you a security code. ${CODE_HELP} (Entering codes automatically is turned off on the Inbox tab.)`
      : `The site emailed you a security code, but I watched your inbox for 2 minutes and none arrived (check your spam folder). Press "Look for the code in my email" to try again, or ${CODE_HELP.charAt(0).toLowerCase()}${CODE_HELP.slice(1)}`)
  }
  await s.adapter.enterVerificationCode(s.page, hit.code)
  await s.adapter.submit(s.page)
  await s.page.waitForTimeout(2000)
  const err = await s.adapter.verificationError?.(s.page)
  if (err) return needUser(`The site did not accept the code from your email (${err}). Press "Look for the code in my email" to try a newer one, or enter it yourself in the open window.`)
  const r = await finish(s, before)
  return r.status === 'submitted' ? { ...r, note: `Entered the security code from your email (it arrived at ${hit.receivedAt.toLocaleTimeString()}). ${r.note}` } : r
}

/** Manual retry: the page is showing the code prompt (for example the email was slow). */
export async function enterCodeFromEmail(): Promise<SubmitResult> {
  const s = session
  if (!s || s.closed || s.page.isClosed()) throw new Error('No open form.')
  if (!(await s.adapter.needsVerificationCode?.(s.page).catch(() => false))) return { status: 'unconfirmed', note: 'The page is not asking for a code right now. If it is, look at the open window.', confirmationUrl: '', screenshot: '' }
  return codeStep(s, s.beforeShot ?? '')
}

/** Re-verify after the user fixed things by hand in the open browser. */
export async function reverify(): Promise<FillResult> {
  const s = session
  if (!s || s.closed) throw new Error('No open form.')
  // Read what the page holds now. A value the person edited in the browser is reported as a change to accept,
  // not as an error: the app does not argue with the person who is looking at the form.
  const current: Record<string, string | null> = {}
  for (const it of s.plan) if (it.status !== 'needs_user' && it.kind !== 'file' && s.adapter.readValue) current[it.name] = await s.adapter.readValue(s.page, it)
  const changed = detectChanges(s.plan, current)
  const isChange = (m: string): boolean => changed.some((c) => m.startsWith(c.label))
  const mismatches = (await s.adapter.verify(s.page, s.plan)).filter((m) => !isChange(m))
  s.mismatches = mismatches
  s.dryRunClean = mismatches.length === 0 && changed.length === 0
  const shot = join(s.dir, 'before.png')
  await s.page.screenshot({ path: shot, fullPage: true })
  return { mismatches, missingFields: [], screenshot: dataUrl(shot), challenge: await s.adapter.detectChallenge(s.page), changed }
}

/**
 * The person edited fields in the open browser and accepts the new values. The plan takes the page's values (so
 * verification agrees with it), and the chosen ones are saved as confirmed answers for every future application.
 */
export async function acceptChanges(names: string[], save: string[]): Promise<{ result: FillResult; saved: number }> {
  const s = session
  if (!s || s.closed) throw new Error('No open form.')
  let saved = 0
  for (const name of names) {
    const it = s.plan.find((x) => x.name === name)
    if (!it || !s.adapter.readValue) continue
    const cur = await s.adapter.readValue(s.page, it)
    if (cur == null) continue
    it.value = cur
    it.source = 'user'
    it.status = 'ready' // a field the app had left blank is now part of the application
    const { saveable } = (await import('./values')).saveability(it)
    if (save.includes(name) && saveable && cur.trim()) {
      if ((it.sensitivity === 'demographic' && rememberSelfId(it.label, cur)) || rememberAnswer(it.label, s.formCompany, cur) || addAnswer(`^${it.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, cur)) saved++
    }
  }
  return { result: await reverify(), saved }
}

/** Also used after the user solves a challenge themselves and clicks submit in the browser. */
export async function checkConfirmation(): Promise<SubmitResult> {
  const s = session
  if (!s || s.closed) throw new Error('No open form.')
  return finish(s, join(s.dir, 'submit-before.png'), 5000)
}

async function finish(s: Session, before: string, timeoutMs = 20000): Promise<SubmitResult> {
  const ok = await s.adapter.confirm(s.page, timeoutMs)
  if (ok) {
    const after = join(s.dir, 'confirmation.png')
    await s.page.screenshot({ path: after, fullPage: true })
    const url = s.page.url()
    logApplication(s.draftId, { attempt_status: 'submitted', submitted_at: new Date().toISOString().replace('T', ' ').slice(0, 19), confirmation_url: url, screenshot_before: before, screenshot_after: after })
    getDb().prepare("UPDATE jobs SET status = 'submitted' WHERE id = ?").run(getDraft(s.draftId).jobId)
    await closeSession()
    return { status: 'submitted', note: 'Confirmation page detected.', confirmationUrl: url, screenshot: dataUrl(after) }
  }
  const challenge = await s.adapter.detectChallenge(s.page)
  const why = await s.adapter.explainFailure?.(s.page)
  const note = why ?? (challenge
    ? 'A CAPTCHA is showing. Solve it yourself in the open browser and click Submit there, then press "Check confirmation". The app never solves CAPTCHAs.'
    : 'No confirmation page yet. Check the open browser for errors (missing required field?), fix them, then press "Check confirmation".')
  logApplication(s.draftId, { notes: note })
  return { status: challenge ? 'needs_user' : 'unconfirmed', note, confirmationUrl: '', screenshot: '' }
}

/**
 * Turn suggested answers into confirmed ones: the user has looked at them and said yes. From then on they are ordinary
 * answers, reused on every application. Returns the rebuilt plan.
 */
export async function confirmSuggested(draftId: number, names: string[], overrides: Record<string, string>): Promise<ApplyPlan> {
  const plan = await buildPlan(draftId, overrides)
  const rows = getDb().prepare('SELECT id, group_id, key FROM questions').all() as { id: number; group_id: number | null; key: string }[]
  for (const it of plan.items) {
    if (!names.includes(it.name) || it.source !== 'suggested' || !it.value) continue
    const q = rows.find((r) => r.key === questionKey(it.label, plan.formCompany))
    if (q) { try { answerQuestion(q.group_id ?? q.id, it.value) } catch { /* the option list differs from the canonical question: it just stays a suggestion */ } }
  }
  return buildPlan(draftId, overrides)
}
