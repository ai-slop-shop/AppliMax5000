import type { Page } from 'playwright-core'
import type { FieldKind, FormField } from '../../shared/apply'
import { politeFetch } from './http'
import type { AtsAdapter, MapContext } from './adapter'
import { classify } from './classify'
import { fullName, mapFields } from './mapping'
import { US_STATES } from './options'

// The form schema comes from Ashby's public GraphQL endpoint (the same one the hosted page uses).
// Field identity is the field `path`, which is also the DOM id/name on the page.
// Ashby uses invisible reCAPTCHA and sometimes flags automated submissions as spam; that is reported, never worked around.
const URL_RE = /jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i
export const parseAshbyUrl = (url: string): { token: string; id: string } | null => {
  const m = url.match(URL_RE)
  return m ? { token: decodeURIComponent(m[1]), id: m[2] } : null
}

interface ApiField { path: string; title: string; type: string; selectableValues?: { label: string; value: string }[] }
const QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title applicationForm { sections { fieldEntries { field isRequired } } } } }`

const byId = (page: Page, id: string) => page.locator(`[id="${id}"]`)
// Every field entry carries data-field-path, which is the stable way to scope to one question.
const entry = (page: Page, path: string) => page.locator(`[data-field-path="${path}"]`).first()
const fieldset = entry
const containerOf = entry

function toField(f: ApiField, required: boolean): FormField | null {
  const system = f.path.startsWith('_systemfield_')
  let kind: FieldKind = 'text'
  let options: string[] = []
  let hint: FormField['hint']
  switch (f.type) {
    case 'LongText': kind = 'textarea'; break
    case 'File': kind = 'file'; if (/cover letter/i.test(f.title)) hint = 'cover_letter_file'; break
    case 'Boolean': kind = 'select'; options = ['Yes', 'No']; break
    case 'ValueSelect': kind = 'select'; options = (f.selectableValues ?? []).map((v) => v.label.trim()); break
    case 'MultiValueSelect': kind = 'multiselect'; options = (f.selectableValues ?? []).map((v) => v.label.trim()); break
    case 'Phone': hint = 'phone'; break
    case 'Location': hint = 'location'; break
  }
  const core = system || hint === 'phone' || hint === 'cover_letter_file'
  const section: FormField['section'] = core ? 'core' : f.type === 'Location' ? 'location' : 'question'
  return { name: f.path, label: f.title.trim(), kind, required, section, options, hint, sensitivity: classify(f.title, kind, required, section, core) }
}

export const ashby: AtsAdapter = {
  name: 'ashby',
  detect: (url) => URL_RE.test(url),

  async loadForm(url) {
    const p = parseAshbyUrl(url)
    if (!p) throw new Error('Use the posting URL: https://jobs.ashbyhq.com/<company>/<id>')
    const res = await politeFetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
      method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: p.token, jobPostingId: p.id }, query: QUERY })
    })
    if (!res.ok) throw new Error(`Ashby returned HTTP ${res.status}`)
    const d = (await res.json()) as { data?: { jobPosting?: { title: string; applicationForm: { sections: { fieldEntries: { field: ApiField; isRequired: boolean }[] }[] } } | null } }
    const job = d.data?.jobPosting
    if (!job) throw new Error('Posting not found or closed. Verify it is live on the employer page.')
    const fields = job.applicationForm.sections.flatMap((s) => s.fieldEntries).map((e) => toField(e.field, e.isRequired)).filter((f): f is FormField => !!f)
    return { title: job.title.trim(), company: p.token, applyUrl: `https://jobs.ashbyhq.com/${p.token}/${p.id}/application`, fields }
  },

  mapAnswers(fields, ctx: MapContext) {
    const n = fullName(ctx)
    return mapFields(fields, ctx, (f) => {
      if (f.name === '_systemfield_name') return { value: n.full, source: 'profile' }
      if (f.name === '_systemfield_email') return { value: ctx.contact.email, source: 'profile' }
      if (f.name === '_systemfield_resume') return { value: ctx.resumePath, source: 'draft' }
      if (f.hint === 'location') return { value: [ctx.contact.city, ctx.contact.state].filter(Boolean).join(', '), source: 'profile' }
      if (f.hint === 'phone') return { value: ctx.contact.phone, source: 'profile' }
      if (f.hint === 'cover_letter_file') return ctx.coverLetterPath ? { value: ctx.coverLetterPath, source: 'draft' } : null
      return null
    })
  },

  async waitForForm(page) {
    await byId(page, '_systemfield_email').waitFor({ state: 'visible', timeout: 20000 })
  },

  async readForm(page) {
    // Some widgets (location, radio groups) expose the field path only on their <label for=...>.
    return page.evaluate(() => [...document.querySelectorAll('[id],[name],label[for]')].flatMap((e) => [e.id, e.getAttribute('name') ?? '', e.getAttribute('for') ?? '']).filter(Boolean))
  },

  async fill(page, plan) {
    for (const it of plan) {
      if (it.status !== 'ready' || !it.value) continue
      if (it.kind === 'file') { await byId(page, it.name).setInputFiles(it.value); continue }
      if (it.kind === 'select' && it.options.length === 2 && it.options.join('|') === 'Yes|No') {
        await page.locator(`input[name="${it.name}"]`).locator('xpath=..').getByRole('button', { name: it.value, exact: true }).click()
        continue
      }
      if (it.kind === 'select' || it.kind === 'multiselect') {
        for (const v of it.value.split('|')) await fieldset(page, it.name).getByText(v, { exact: true }).first().click()
        continue
      }
      if (it.hint === 'location') {
        const box = containerOf(page, it.name).locator('input[role="combobox"]').first()
        const [city, st] = it.value.split(',').map((s) => s.trim())
        await box.click()
        await box.pressSequentially(city, { delay: 50 })
        const state = US_STATES[st?.toUpperCase()] ?? st ?? ''
        const opt = page.getByRole('option').filter({ hasText: new RegExp(`${city}, ${state}`, 'i') }).first()
        await opt.waitFor({ state: 'visible', timeout: 8000 })
        await opt.click() // typed text alone is discarded: the suggestion must be clicked
        continue
      }
      await byId(page, it.name).fill(it.value)
    }
  },

  async verify(page, plan) {
    const bad: string[] = []
    for (const it of plan) {
      if (it.status !== 'ready' || !it.value) continue
      try {
        if (it.kind === 'file') {
          const base = it.value.split('/').pop() ?? ''
          const txt = await containerOf(page, it.name).innerText()
          if (!txt.includes(base)) bad.push(`${it.label}: file not attached`)
        } else if (it.kind === 'select' && it.options.join('|') === 'Yes|No') {
          const got = await page.locator(`input[name="${it.name}"]`).locator('xpath=..').locator('button[aria-pressed="true"]').allInnerTexts()
          if (got[0]?.trim() !== it.value) bad.push(`${it.label}: expected "${it.value}", page shows "${got[0]?.trim() ?? 'nothing'}"`)
        } else if (it.kind === 'select' || it.kind === 'multiselect') {
          const got = await fieldset(page, it.name).locator('input:checked').evaluateAll((els) =>
            els.map((e) => (e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim() ?? '' : '')))
          const want = it.value.split('|')
          if (want.some((w) => !got.includes(w)) || got.some((g) => !want.includes(g))) bad.push(`${it.label}: expected [${want.join(', ')}], page shows [${got.join(', ')}]`)
        } else if (it.hint === 'location') {
          const got = await containerOf(page, it.name).locator('input[role="combobox"]').first().inputValue()
          if (!got.toLowerCase().startsWith(it.value.split(',')[0].trim().toLowerCase())) bad.push(`${it.label}: expected "${it.value}", page shows "${got}"`)
        } else if (it.hint === 'phone') {
          const got = (await byId(page, it.name).inputValue()).replace(/\D/g, ''), want = it.value.replace(/\D/g, '')
          if (!got.endsWith(want.slice(-10))) bad.push(`${it.label}: expected ${it.value}, page shows ${got}`)
        } else if ((await byId(page, it.name).inputValue()).trim() !== it.value.trim()) bad.push(`${it.label}: value on page differs from plan`)
      } catch {
        bad.push(`${it.label}: could not be checked automatically.`)
      }
    }
    return bad
  },

  async readValue(page, it) {
    try {
      if (it.kind === 'file') return null
      if (it.kind === 'select' && it.options.join('|') === 'Yes|No') {
        return (await page.locator(`input[name="${it.name}"]`).locator('xpath=..').locator('button[aria-pressed="true"]').allInnerTexts())[0]?.trim() ?? null
      }
      if (it.kind === 'select' || it.kind === 'multiselect') {
        const got = await fieldset(page, it.name).locator('input:checked').evaluateAll((els) =>
          els.map((e) => (e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim() ?? '' : '')))
        return got.join('|')
      }
      if (it.hint === 'location') return (await containerOf(page, it.name).locator('input[role="combobox"]').first().inputValue({ timeout: 2000 })).trim()
      return (await byId(page, it.name).inputValue({ timeout: 2000 })).trim()
    } catch { return null }
  },

  async detectChallenge(page) {
    return page.locator('iframe[src*="recaptcha"][src*="bframe"]:visible, iframe[title*="recaptcha challenge" i]:visible, iframe[src*="hcaptcha"]:visible').count().then((n) => n > 0)
  },

  async submit(page) {
    await page.getByRole('button', { name: /submit application/i }).click()
  },

  async confirm(page, timeoutMs = 20000) {
    const ok = /successfully submitted|application (has been )?(received|submitted)|thank you for (applying|your application)/i
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (ok.test(await page.locator('body').innerText().catch(() => ''))) return true
      await page.waitForTimeout(500)
    }
    return false
  },

  async explainFailure(page) {
    const t = await page.locator('body').innerText().catch(() => '')
    return /flagged.*spam|spam.*flagged|possible spam/i.test(t)
      ? 'Ashby flagged the submission as possible spam. The app does not try to get around this: submit it yourself in the open browser, or apply on the company site.'
      : null
  }
}
