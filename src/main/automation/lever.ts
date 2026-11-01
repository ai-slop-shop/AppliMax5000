import { parse, type HTMLElement } from 'node-html-parser'
import type { Page } from 'playwright-core'
import type { FieldKind, FormField, PlanItem } from '../../shared/apply'
import { politeFetch } from './http'
import type { AtsAdapter, MapContext } from './adapter'
import { classify } from './classify'
import { fullName, mapFields } from './mapping'
import { US_STATES } from './options'

// Lever's apply page is server-rendered HTML, so the form is read from the HTML (no API for questions exists).
// Field identity is the input `name` attribute. Lever puts an hCaptcha on submit; the app never solves it.
const CORE: ReadonlySet<string> = new Set(['name', 'email', 'phone', 'location', 'org', 'resume', 'comments', 'urls[LinkedIn]', 'urls[GitHub]', 'urls[Portfolio]', 'urls[Other]'])
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
const URL_RE = /jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i

export const parseLeverUrl = (url: string): { token: string; id: string } | null => {
  const m = url.match(URL_RE)
  return m ? { token: m[1], id: m[2] } : null
}

const sel = (page: Page, name: string) => page.locator(`[name="${name}"]`)
const text = (e: HTMLElement | null): string => (e?.text ?? '').replace(/✱/g, '').replace(/\s+/g, ' ').trim()

/** Parse the application form into fields. Exported for tests. */
export function parseLeverForm(html: string): FormField[] {
  const root = parse(html)
  const form = root.querySelector('form#application-form') ?? root
  const fields: FormField[] = []
  const seen = new Set<string>()

  const push = (name: string, label: string, kind: FieldKind, required: boolean, options: string[]): void => {
    if (seen.has(name)) return
    seen.add(name)
    const section: FormField['section'] = name.startsWith('surveysResponses[') || name === 'pronouns' ? 'eeoc' : name === 'location' ? 'location' : 'question'
    const core = CORE.has(name)
    fields.push({ name, label, kind, required, section: core && section === 'question' ? 'core' : section, options, sensitivity: classify(label, kind, required, section, core) })
  }

  // Resume is its own block, not an .application-question.
  if (form.querySelector('input[name="resume"]')) push('resume', 'Resume/CV', 'file', true, [])

  for (const q of form.querySelectorAll('.application-question')) {
    const controls = q.querySelectorAll('input, textarea, select').filter((c) => c.getAttribute('type') !== 'hidden' && c.getAttribute('name'))
    if (!controls.length) continue
    // Nested questions are handled on their own; skip wrappers whose inner questions hold the controls.
    if (q.querySelector('.application-question')) continue
    const label = text(q.querySelector('.application-label .text') ?? q.querySelector('.application-label'))
    const required = !!q.querySelector('.required') || controls.some((c) => c.hasAttribute('required'))
    const byName = new Map<string, HTMLElement[]>()
    for (const c of controls) { const n = c.getAttribute('name')!; byName.set(n, [...(byName.get(n) ?? []), c]) }
    for (const [name, group] of byName) {
      if (name === 'consent[marketing]') continue // marketing opt-in: never ticked, never offered
      const type = group[0].getAttribute('type')
      if (type === 'radio') push(name, label, 'select', required, group.map((c) => c.getAttribute('value') ?? ''))
      else if (type === 'checkbox') push(name, label, 'multiselect', required, group.map((c) => c.getAttribute('value') ?? ''))
      else if (type === 'file') push(name, label || name, 'file', required, [])
      else if (group[0].tagName === 'TEXTAREA') push(name, label || name, 'textarea', required, [])
      else if (group[0].tagName === 'SELECT') continue // unnamed or country pickers (optional demographics)
      else push(name, label || name, 'text', required, [])
    }
  }
  return fields
}

export const lever: AtsAdapter = {
  name: 'lever',
  detect: (url) => URL_RE.test(url),

  async loadForm(url) {
    const p = parseLeverUrl(url)
    if (!p) throw new Error('Use the posting URL: https://jobs.lever.co/<company>/<id>')
    const meta = await politeFetch(`https://api.lever.co/v0/postings/${p.token}/${p.id}`)
    if (!meta.ok) throw new Error(`Posting not found or closed (HTTP ${meta.status}). Verify it is live on the employer page.`)
    const title = ((await meta.json()) as { text?: string }).text ?? ''
    const applyUrl = `https://jobs.lever.co/${p.token}/${p.id}/apply`
    const res = await politeFetch(applyUrl, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`Application page returned HTTP ${res.status}`)
    const fields = parseLeverForm(await res.text())
    if (!fields.length) throw new Error('Could not read the application form.')
    return { title, company: p.token, applyUrl, fields }
  },

  mapAnswers(fields, ctx: MapContext) {
    const n = fullName(ctx)
    return mapFields(fields, ctx, (f) => {
      switch (f.name) {
        case 'name': return { value: n.full, source: 'profile' }
        case 'email': return { value: ctx.contact.email, source: 'profile' }
        case 'phone': return { value: ctx.contact.phone, source: 'profile' }
        case 'location': return { value: [ctx.contact.city, ctx.contact.state].filter(Boolean).join(', '), source: 'profile' }
        case 'org': return ctx.currentEmployer ? { value: ctx.currentEmployer, source: 'profile' } : null
        case 'resume': return { value: ctx.resumePath, source: 'draft' }
        case 'urls[LinkedIn]': return ctx.contact.linkedin ? { value: ctx.contact.linkedin, source: 'profile' } : 'skip'
        case 'urls[GitHub]': case 'urls[Portfolio]': case 'urls[Other]': return 'skip'
        case 'comments': return /cover letter/i.test(f.label) && ctx.coverLetter ? { value: ctx.coverLetter, source: 'draft' } : 'skip'
      }
      return null
    })
  },

  async waitForForm(page) {
    await page.locator('form#application-form [name="email"]').waitFor({ state: 'visible', timeout: 20000 })
  },

  async readForm(page) {
    return page.evaluate(() => [...new Set([...document.querySelectorAll('#application-form [name]')].map((e) => e.getAttribute('name') ?? ''))].filter(Boolean))
  },

  async fill(page, plan) {
    const ready = plan.filter((i) => i.status === 'ready' && i.value)
    // Lever parses an uploaded resume and auto-fills fields, so upload first and let it finish, then overwrite with our values.
    const resume = ready.find((i) => i.kind === 'file')
    if (resume) {
      await sel(page, resume.name).setInputFiles(resume.value)
      await page.locator('.resume-upload-success, .resume-upload-failure').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {})
    }
    for (const it of ready) {
      if (it.kind === 'file') continue
      if (it.kind === 'select' || it.kind === 'multiselect') {
        // Sections like the demographic survey stay hidden until Lever reveals them; optional ones are simply skipped.
        if (!it.required && !(await optionVisible(page, it.name))) continue
        for (const v of it.value.split('|')) await clickOption(page, it.name, v)
        continue
      }
      if (it.name === 'location') {
        const input = sel(page, 'location')
        const [city, st] = it.value.split(',').map((s) => s.trim())
        await input.click()
        await input.fill('')
        await input.pressSequentially(city, { delay: 40 })
        const state = US_STATES[st?.toUpperCase()] ?? st ?? ''
        const opt = page.locator('.dropdown-results > *').filter({ hasText: new RegExp(`${city}.*(${state}|${st})`, 'i') }).first()
        if (await opt.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) await opt.click() // the suggestion must be clicked
        continue
      }
      await sel(page, it.name).fill(it.value)
    }
  },

  async verify(page, plan) {
    const bad: string[] = []
    for (const it of plan) {
      if (it.status !== 'ready' || !it.value) continue
      if ((it.kind === 'select' || it.kind === 'multiselect') && !it.required && !(await optionVisible(page, it.name))) continue
      try {
        if (it.kind === 'file') {
          const shown = (await page.locator('.filename').first().innerText().catch(() => '')).trim()
          const n = await sel(page, it.name).evaluate((e) => (e as HTMLInputElement).files?.length ?? 0)
          if (!shown && n === 0) bad.push(`${it.label}: file not attached`)
        } else if (it.kind === 'select') {
          const got = await sel(page, it.name).evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).map((e) => (e as HTMLInputElement).value))
          if (got[0] !== it.value) bad.push(`${it.label}: expected "${it.value}", page shows "${got[0] ?? 'nothing'}"`)
        } else if (it.kind === 'multiselect') {
          const got = await sel(page, it.name).evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).map((e) => (e as HTMLInputElement).value))
          const want = it.value.split('|')
          if (want.some((w) => !got.includes(w)) || got.some((g) => !want.includes(g))) bad.push(`${it.label}: expected [${want.join(', ')}], page shows [${got.join(', ')}]`)
        } else if (it.name === 'location') {
          const got = await sel(page, 'location').inputValue()
          if (!got.toLowerCase().startsWith(it.value.split(',')[0].trim().toLowerCase())) bad.push(`${it.label}: expected "${it.value}", page shows "${got}"`)
        } else if (it.name === 'phone') {
          const got = (await sel(page, 'phone').inputValue()).replace(/\D/g, ''), want = it.value.replace(/\D/g, '')
          if (!got.endsWith(want.slice(-10))) bad.push(`${it.label}: expected ${it.value}, page shows ${got}`)
        } else {
          if ((await sel(page, it.name).inputValue()).trim() !== it.value.trim()) bad.push(`${it.label}: value on page differs from plan`)
        }
      } catch {
        bad.push(`${it.label}: could not be checked automatically.`)
      }
    }
    return bad
  },

  async readValue(page, it) {
    try {
      if (it.kind === 'file') return null
      if (it.kind === 'select' || it.kind === 'multiselect') {
        const got = await sel(page, it.name).evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).map((e) => (e as HTMLInputElement).value))
        return got.join('|')
      }
      return (await sel(page, it.name).inputValue({ timeout: 2000 })).trim()
    } catch { return null }
  },

  async detectChallenge(page) {
    return page.locator('iframe[src*="hcaptcha"][src*="challenge"]:visible, iframe[title*="hCaptcha challenge" i]:visible, iframe[title*="recaptcha challenge" i]:visible').count().then((n) => n > 0)
  },

  async submit(page) {
    await page.locator('#btn-submit').click() // triggers hCaptcha; if a challenge appears, the user solves it
  },

  async confirm(page, timeoutMs = 20000) {
    try { await page.waitForURL(/\/thanks/, { timeout: timeoutMs }); return true }
    catch { return /application (has been )?submitted|thank you for (applying|your application)/i.test(await page.locator('body').innerText().catch(() => '')) }
  }
}

const optionVisible = (page: Page, name: string): Promise<boolean> =>
  page.locator(`input[name="${name}"]`).first().locator('xpath=ancestor::label[1]').isVisible().catch(() => false)

/** Radio / checkbox options: click the visible label for the exact value (inputs are often visually hidden). */
async function clickOption(page: Page, name: string, value: string): Promise<void> {
  const input = page.locator(`input[name="${name}"][value="${value.replace(/"/g, '\\"')}"]`)
  if (await input.isChecked().catch(() => false)) return
  await input.locator('xpath=ancestor::label[1]').click()
}

export type { PlanItem }
