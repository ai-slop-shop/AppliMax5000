import type { Page } from 'playwright-core'
import type { FieldKind, FormField, PlanItem } from '../../shared/apply'
import { politeFetch } from './http'
import type { AtsAdapter, MapContext } from './adapter'
import { US_STATES, chooseOption, sameText } from './options'
import { classify } from './classify'
import { fullName, mapFields } from './mapping'

interface ApiField { name: string; type: string; values?: { label: string; value: string }[] }
interface ApiQuestion { label: string; required: boolean; fields: ApiField[] }
/** The newer "Voluntary Self-Identification" format: no `fields`, options live in `answer_options`. */
interface ApiDemographic { id: number; label: string; required?: boolean; type: string; answer_options?: { id: number; label: string; free_form?: boolean; decline_to_answer?: boolean }[] }

const KINDS: Record<string, FieldKind> = {
  input_text: 'text', textarea: 'textarea', input_file: 'file',
  multi_value_single_select: 'select', multi_value_multi_select: 'multiselect'
}

const CORE: ReadonlySet<string> = new Set(['first_name', 'last_name', 'email', 'phone', 'resume', 'resume_text', 'cover_letter', 'cover_letter_text'])

export function parseGreenhouseUrl(url: string): { board: string; jobId: string } | null {
  const m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)\/jobs\/(\d+)/)
  if (m) return { board: m[1], jobId: m[2] }
  return null
}

function fromDemographic(q: ApiDemographic): FormField | null {
  const kind = KINDS[q.type]
  if (kind !== 'select' && kind !== 'multiselect') return null
  const opts = q.answer_options ?? []
  return {
    name: String(q.id), // the page uses the question id as the field's DOM id
    label: q.label.replace(/\s+/g, ' ').trim(), kind, required: !!q.required, section: 'eeoc',
    options: opts.map((o) => o.label.trim()), optionValues: opts.map((o) => String(o.id)),
    declineOption: opts.find((o) => o.decline_to_answer)?.label.trim(), sensitivity: 'demographic'
  }
}

function toFields(q: ApiQuestion, section: FormField['section']): FormField[] {
  return (q.fields ?? []).filter((f) => KINDS[f.type]).map((f) => {
    const kind = KINDS[f.type]
    const core = CORE.has(f.name)
    // resume_text / cover_letter_text are alternatives to the file; never required on their own.
    const required = f.name === 'resume_text' || f.name === 'cover_letter_text' ? false : q.required
    return { name: f.name, label: q.label.trim(), kind, required, section: core ? 'core' : section,
      options: (f.values ?? []).map((v) => v.label.trim()), optionValues: (f.values ?? []).map((v) => String(v.value)), sensitivity: classify(q.label, kind, required, section, core) }
  })
}

const sel = (page: Page, name: string) => page.locator(`[id="${name}"]`)
/** The API calls the city field "location"; on the page it is the autocomplete with this id. */
/** Marks a field the app could not read back. The wording matters: the runner and the screen recognize it. */
export const UNCHECKABLE = 'could not be checked automatically.'
const LOCATION_ID = 'candidate-location'
const DEMOGRAPHIC_CONSENT = 'gdpr_demographic_data_consent_given' // a one-box checkbox group on the page: id "<name>_1"
const domId = (it: { name: string; section: string }): string => (it.section === 'location' ? LOCATION_ID : it.name)
/** Some boards render a multi-select as one checkbox per option (id "<field>_<option id>") instead of a dropdown. */
const checkId = (it: { name: string; optionValues?: string[] }, k: number): string => `${it.name}_${it.optionValues?.[k]}`
const isCheckGroup = async (page: Page, it: { name: string; optionValues?: string[] }): Promise<boolean> =>
  !!it.optionValues?.length && (await page.locator(`[id="${checkId(it, 0)}"]`).count()) > 0
const digits = (s: string): string => s.replace(/\D/g, '')

async function pickOption(page: Page, name: string, label: string): Promise<void> {
  const input = sel(page, name)
  await input.scrollIntoViewIfNeeded()
  await input.click()
  await input.fill(label) // filter the list, then click the exact option (never trust Return on a filtered list)
  // If the list did not open (the widget was still starting up), close it and open it again, up to three times.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await page.getByRole('option').first().waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) break
    await input.press('Escape').catch(() => {})
    await page.waitForTimeout(400)
    await input.click(); await input.fill(''); await input.fill(label)
  }
  const exact = page.getByRole('option', { name: label, exact: true }).first()
  if (await exact.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false)) { await exact.click(); return }
  // Some widgets decorate labels ("United States +1") or list near-matches. Read what is offered and choose carefully.
  const offered = async (): Promise<string[]> => (await page.getByRole('option').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  let texts = await offered()
  if (!texts.length && label.includes(' ')) { await input.fill(label.split(' ')[0]); await page.waitForTimeout(400); texts = await offered() } // a looser search
  const pick = chooseOption(label, texts)
  if (typeof pick === 'number') { await page.getByRole('option').nth(pick).click(); return }
  const seen = texts.slice(0, 8).join(' | ') || '(nothing)'
  throw new Error(pick ? `Several options match "${label}" and none is clearly right. The page offers: ${pick.ambiguous.slice(0, 6).join(' | ')}` : `No option matching "${label}". The page offers: ${seen}`)
}

const readSingle = (page: Page, name: string): Promise<string> =>
  sel(page, name).evaluate((el) => {
    const c = el.closest('[class*="select__control"], [class*="-control"]')
    return (c?.querySelector('[class*="single-value"]') as HTMLElement | null)?.innerText.trim() ?? ''
  })
const readMulti = (page: Page, name: string): Promise<string[]> =>
  sel(page, name).evaluate((el) => {
    const c = el.closest('[class*="select__control"], [class*="-control"]')
    return [...(c?.querySelectorAll('[class*="multi-value__label"]') ?? [])].map((e) => (e as HTMLElement).innerText.trim())
  })

async function enterManually(page: Page, name: string): Promise<void> {
  const ta = sel(page, `${name}_text`)
  if (await ta.isVisible().catch(() => false)) return
  const group = sel(page, name).locator('xpath=ancestor::*[.//button[normalize-space()="Enter manually"]][1]')
  await group.getByRole('button', { name: 'Enter manually' }).click()
  await ta.waitFor({ state: 'visible', timeout: 5000 })
}

export const greenhouse: AtsAdapter = {
  name: 'greenhouse',
  detect: (url) => /greenhouse\.io/.test(url) && !!parseGreenhouseUrl(url),

  async loadForm(url) {
    const p = parseGreenhouseUrl(url)
    if (!p) throw new Error('Use the posting URL on job-boards.greenhouse.io (or boards.greenhouse.io): .../<company>/jobs/<id>')
    const res = await politeFetch(`https://boards-api.greenhouse.io/v1/boards/${p.board}/jobs/${p.jobId}?questions=true`)
    if (!res.ok) throw new Error(`Posting not found or closed (HTTP ${res.status}). Verify it is live on the employer page.`)
    const d = await res.json() as {
      title: string; company_name?: string; absolute_url: string
      questions?: ApiQuestion[]; location_questions?: ApiQuestion[]
      compliance?: { questions: ApiQuestion[] }[]; data_compliance?: { demographic_data_consent_applies?: boolean }[]; demographic_questions?: { questions?: ApiDemographic[] } | null
    }
    const fields = [
      ...(d.questions ?? []).flatMap((q) => toFields(q, 'question')),
      ...(d.location_questions ?? []).flatMap((q) => toFields(q, 'location')),
      ...(Array.isArray(d.compliance) ? d.compliance : []).flatMap((c) => (c.questions ?? []).flatMap((q) => toFields(q, 'eeoc'))),
      ...(d.demographic_questions?.questions ?? []).map(fromDemographic).filter((f): f is FormField => !!f)
    ]
    // Some boards add a required checkbox consenting to the processing of the demographic answers. It is not a listed question,
    // so the form's own flag is the only sign of it. It is a consent: the person approves it, the app never ticks it unasked.
    if (Array.isArray(d.data_compliance) && d.data_compliance.some((c) => c.demographic_data_consent_applies) && (d.demographic_questions?.questions ?? []).length) {
      fields.push({
        name: DEMOGRAPHIC_CONSENT, label: `By checking this box, I consent to ${d.company_name ?? 'the employer'} collecting, storing, and processing my responses to the demographic data surveys above.`,
        kind: 'multiselect', required: true, section: 'eeoc', options: ['I consent'], optionValues: ['1'], sensitivity: 'consent'
      })
    }
    // Boards whose job links redirect to the company's own careers site show the form inside an embedded frame.
    // Greenhouse's embed address shows that same form on its own, with the same field ids.
    let host = ''
    try { host = new URL(d.absolute_url).hostname } catch { /* keep empty */ }
    const embedded = !/(^|\.)greenhouse\.io$/.test(host)
    const applyUrl = embedded ? `https://boards.greenhouse.io/embed/job_app?for=${p.board}&token=${p.jobId}` : d.absolute_url
    return { title: d.title, company: d.company_name ?? p.board, applyUrl, fields }
  },

  async waitForForm(page) {
    const settled = (): Promise<unknown> => page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}) // widgets such as the country picker start up after the form is visible
    if (await page.locator('[id="first_name"]').waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) { await settled(); return }
    // Not on this page itself: if the page embeds Greenhouse's form in a frame, open that frame's address directly.
    const src = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src).find((u) => /greenhouse\.io\/embed\/job_app/.test(u)))
    if (src) await page.goto(src, { waitUntil: 'domcontentloaded' })
    await page.locator('[id="first_name"]').waitFor({ state: 'visible', timeout: 15000 })
    await settled()
  },

  mapAnswers(fields, ctx: MapContext) {
    const n = fullName(ctx)
    const items = mapFields(fields, ctx, (f) => {
      switch (f.name) {
        case 'first_name': return { value: n.first, source: 'profile' }
        case 'last_name': return { value: n.last, source: 'profile' }
        case 'email': return { value: ctx.contact.email, source: 'profile' }
        case 'phone': return { value: ctx.contact.phone, source: 'profile' }
        case 'resume': return { value: ctx.resumePath, source: 'draft' }
        case 'cover_letter_text': return { value: ctx.coverLetter, source: 'draft' }
        case 'resume_text': case 'cover_letter': return 'skip'
      }
      if (f.section === 'location') return { value: [ctx.contact.city, ctx.contact.state].filter(Boolean).join(', '), source: 'profile' }
      return null
    })
    // The country picker is in the page but not in the API.
    items.unshift({ name: 'country', label: 'Country', kind: 'select', section: 'core', required: true, value: 'United States', source: 'default',
      status: 'ready', sensitivity: 'none', needsApproval: false, reason: 'Default', options: [], domOnly: true })
    return items
  },

  async readForm(page) {
    const ids = await page.evaluate(() => [...document.querySelectorAll('input[id],textarea[id]')].map((e) => e.id).filter(Boolean))
    const out = new Set(ids)
    for (const id of ids) { const m = id.match(/^(.+\[\])_\d+$/); if (m) out.add(m[1]) } // checkbox group: "question_1[]_55" -> the field "question_1[]"
    if (out.has(`${DEMOGRAPHIC_CONSENT}_1`)) out.add(DEMOGRAPHIC_CONSENT)
    if (out.has(LOCATION_ID)) out.add('location') // plan name for the city field
    return [...out]
  },

  async fill(page, plan) {
    for (const it of plan) {
      if (it.status !== 'ready' || !it.value) continue
      if (it.domOnly && (await sel(page, it.name).count()) === 0) continue
      if (it.kind === 'file') { await sel(page, it.name).setInputFiles(it.value); continue }
      if (it.kind === 'select') { await pickOption(page, it.name, it.value); continue }
      if (it.kind === 'multiselect') {
        if (await isCheckGroup(page, it)) {
          for (const v of it.value.split('|')) {
            const id = checkId(it, it.options.indexOf(v))
            if (!(await page.locator(`[id="${id}"]`).isChecked())) await page.locator(`label[for="${id}"]`).click() // tick through its label, as a person would
          }
        } else for (const v of it.value.split('|')) await pickOption(page, it.name, v)
        continue
      }
      if (it.name === 'cover_letter_text') await enterManually(page, 'cover_letter')
      if (it.section === 'location') {
        const input = sel(page, domId(it))
        const [city, st] = it.value.split(',').map((s) => s.trim())
        await input.click()
        await input.pressSequentially(city, { delay: 40 })
        const state = US_STATES[st?.toUpperCase()] ?? st ?? ''
        const opt = page.getByRole('option').filter({ hasText: state }).first()
        await opt.waitFor({ state: 'visible', timeout: 7000 }) // typed text alone gets cleared: the suggestion must be clicked
        await opt.click()
        continue
      }
      await sel(page, it.name).fill(it.value)
    }
  },

  async verify(page, plan) {
    const bad: string[] = []
    for (const it of plan) {
      if (it.status !== 'ready' || !it.value) continue
      if (it.domOnly && (await sel(page, it.name).count()) === 0) continue
      try {
        if (it.kind === 'file') {
          // After an upload the page usually swaps the file input for a chip showing the file's name, so look for that first.
          const base = (it.value.split('/').pop() ?? '').trim()
          const shown = base ? await page.getByText(base, { exact: false }).first().isVisible().catch(() => false) : false
          const n = await sel(page, it.name).evaluate((e) => (e as HTMLInputElement).files?.length ?? 0, undefined, { timeout: 1500 }).catch(() => -1)
          if (!shown && n === 0) bad.push(`${it.label}: no file is attached`)
          else if (!shown && n < 0) bad.push(`${it.label}: ${UNCHECKABLE} Look for the file name in the open browser window.`)
        } else if (it.kind === 'select') {
          const got = await readSingle(page, it.name)
          // The country picker shows only the dial code (e.g. "+1") once chosen, so for it we check that something is selected.
          const ok = it.domOnly ? got !== '' : sameText(got, it.value)
          if (!ok) bad.push(`${it.label}: expected "${it.value}", page shows "${got}"`)
        } else if (it.kind === 'multiselect' && (await isCheckGroup(page, it))) {
          const want = new Set(it.value.split('|'))
          const wrong: string[] = []
          for (let k = 0; k < it.options.length; k++) {
            const on = await page.locator(`[id="${checkId(it, k)}"]`).isChecked()
            if (on !== want.has(it.options[k])) wrong.push(`${it.options[k]} is ${on ? 'ticked' : 'not ticked'}`)
          }
          if (wrong.length) bad.push(`${it.label}: ${wrong.join('; ')}`)
        } else if (it.kind === 'multiselect') {
          const got = await readMulti(page, it.name)
          const want = it.value.split('|')
          if (want.some((w) => !got.some((g) => sameText(g, w)))) bad.push(`${it.label}: expected [${want.join(', ')}], page shows [${got.join(', ')}]`)
        } else if (it.section === 'location') {
          // an autocomplete: once a suggestion is chosen the page shows it as the selected value, not as typed text
          const got = (await readSingle(page, domId(it))) || (await sel(page, domId(it)).inputValue())
          if (!got.toLowerCase().includes(it.value.split(',')[0].trim().toLowerCase())) bad.push(`${it.label}: expected city "${it.value}", page shows "${got}"`)
        } else if (it.name === 'phone') {
          const got = digits(await sel(page, it.name).inputValue()), want = digits(it.value)
          if (!got.endsWith(want.slice(-10))) bad.push(`${it.label}: expected ${it.value}, page shows ${got}`)
        } else {
          const got = await sel(page, it.name).inputValue()
          if (!sameText(got, it.value)) bad.push(`${it.label}: value on page differs from plan`)
        }
      } catch {
        bad.push(`${it.label}: ${UNCHECKABLE}`)
      }
    }
    return bad
  },

  async untickedRequired(page) {
    return page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')]
      .filter((e) => { const c = e as HTMLInputElement; return !c.checked && (c.required || c.getAttribute('aria-required') === 'true') && !/\[\]/.test(c.name) })
      .map((e) => (e.closest('label')?.textContent || document.querySelector(`label[for="${e.id}"]`)?.textContent || e.id).replace(/\s+/g, ' ').trim().slice(0, 120)))
  },

  async readValue(page, it) {
    try {
      if (it.kind === 'file' || it.domOnly) return null
      if (it.kind === 'select') return (await readSingle(page, domId(it))) || null
      if (it.kind === 'multiselect') {
        if (await isCheckGroup(page, it)) {
          const on: string[] = []
          for (let k = 0; k < it.options.length; k++) if (await page.locator(`[id="${checkId(it, k)}"]`).isChecked()) on.push(it.options[k])
          return on.join('|')
        }
        return (await readMulti(page, it.name)).join('|')
      }
      if (it.section === 'location') return (await readSingle(page, domId(it))) || (await sel(page, domId(it)).inputValue())
      return (await sel(page, domId(it)).inputValue({ timeout: 2000 })).trim()
    } catch { return null }
  },

  async detectChallenge(page) {
    return page.locator('iframe[src*="hcaptcha"]:visible, iframe[title*="recaptcha challenge" i]:visible, iframe[src*="recaptcha/api2/bframe"]:visible').count().then((n) => n > 0)
  },

  async submit(page) {
    await page.getByRole('button', { name: /submit application/i }).click()
  },

  // After Submit, Greenhouse shows #email-verification with eight one-character boxes (#security-input-0 .. 7).
  async needsVerificationCode(page) {
    return page.locator('#email-verification, #security-input-0').first().isVisible().catch(() => false)
  },
  async enterVerificationCode(page, code) {
    if (!/^[A-Za-z0-9]{8}$/.test(code)) throw new Error('The code is not 8 letters and digits.')
    for (let i = 0; i < 8; i++) await page.locator(`#security-input-${i}`).fill(code[i])
  },
  async verificationError(page) {
    const e = page.locator('#email-verification-error')
    return (await e.isVisible().catch(() => false)) ? (await e.innerText()).trim() : null
  },

  async confirm(page, timeoutMs = 20000) {
    try {
      await page.waitForURL(/\/confirmation/, { timeout: timeoutMs })
      return true
    } catch {
      return /thank you for applying/i.test(await page.locator('body').innerText().catch(() => ''))
    }
  }
}
