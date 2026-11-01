import { BrowserWindow } from 'electron'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat } from 'docx'
import type { Resume } from '../shared/resume'

const FONT = 'Calibri'
const loc = (r: Resume): string => [r.contact.city, r.contact.state].filter(Boolean).join(', ')
const contactLine = (r: Resume): string =>
  [loc(r), r.contact.phone, r.contact.email, r.contact.linkedin].filter(Boolean).join(' | ')
const dates = (s: string, e: string): string => [s, e].filter(Boolean).join(' - ')
/** "Employer, Title, Mon YYYY - Mon YYYY" on one predictable line (spec §5). */
export const roleLine = (x: Resume['experience'][number]): string =>
  [x.employer, x.title, dates(x.start, x.end)].filter(Boolean).join(', ')

/** Canonical single-column text; also the "what a screening tool sees" view. */
export function renderPlainText(r: Resume): string {
  const out: string[] = [r.contact.name, contactLine(r), '']
  if (r.summary) out.push('Summary', r.summary, '')
  const jobs = r.experience.filter((x) => !x.isSideProject)
  const side = r.experience.filter((x) => x.isSideProject)
  if (jobs.length) {
    out.push('Experience')
    for (const x of jobs) out.push(roleLine(x), ...x.bullets.map((b) => `- ${b.text}`), '')
  }
  if (r.skills.length) out.push('Skills', r.skills.join(', '), '')
  if (side.length) {
    out.push('Side Project')
    for (const x of side) out.push(roleLine(x), ...x.bullets.map((b) => `- ${b.text}`), '')
  }
  if (r.education.length) {
    out.push('Education')
    for (const e of r.education) out.push([e.school, [e.degree, e.field].filter(Boolean).join(' in '), e.end].filter(Boolean).join(', '))
  }
  return out.join('\n').trimEnd() + '\n'
}

export async function renderDocx(r: Resume): Promise<Buffer> {
  const body = (text: string, opts: { bold?: boolean; size?: number } = {}): Paragraph =>
    new Paragraph({ children: [new TextRun({ text, font: FONT, size: opts.size ?? 22, bold: opts.bold })] })
  const heading = (text: string): Paragraph =>
    new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200 }, children: [new TextRun({ text, font: FONT, bold: true, size: 24 })] })
  const bullet = (text: string): Paragraph =>
    new Paragraph({ numbering: { reference: 'bul', level: 0 }, children: [new TextRun({ text, font: FONT, size: 22 })] })
  const role = (x: Resume['experience'][number]): Paragraph[] => [
    new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: roleLine(x), font: FONT, bold: true, size: 22 })] }),
    ...x.bullets.map((b) => bullet(b.text))
  ]

  const kids: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: r.contact.name, font: FONT, bold: true, size: 32 })] }),
    body(contactLine(r))
  ]
  if (r.summary) kids.push(heading('Summary'), body(r.summary))
  const jobs = r.experience.filter((x) => !x.isSideProject)
  const side = r.experience.filter((x) => x.isSideProject)
  if (jobs.length) kids.push(heading('Experience'), ...jobs.flatMap(role))
  if (r.skills.length) kids.push(heading('Skills'), body(r.skills.join(', ')))
  if (side.length) kids.push(heading('Side Project'), ...side.flatMap(role))
  if (r.education.length) {
    kids.push(heading('Education'))
    for (const e of r.education) kids.push(body([e.school, [e.degree, e.field].filter(Boolean).join(' in '), e.end].filter(Boolean).join(', ')))
  }

  const doc = new Document({
    numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: 'left' }] }] },
    sections: [{ children: kids }] // no headers/footers, no tables: content stays in the body
  })
  return Packer.toBuffer(doc)
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function renderPdf(r: Resume): Promise<Buffer> {
  const sec = (title: string, inner: string): string => `<h2>${title}</h2>${inner}`
  const role = (x: Resume['experience'][number]): string =>
    `<p class="role">${esc(roleLine(x))}</p><ul>${x.bullets.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>`
  const jobs = r.experience.filter((x) => !x.isSideProject)
  const side = r.experience.filter((x) => x.isSideProject)
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:10.5pt;margin:0;line-height:1.35}
    h1{font-size:18pt;margin:0 0 2px} h2{font-size:12pt;margin:14px 0 4px;border-bottom:1px solid #000}
    .role{font-weight:bold;margin:8px 0 2px} ul{margin:0;padding-left:18px} p{margin:2px 0}</style>
    <h1>${esc(r.contact.name)}</h1><p>${esc(contactLine(r))}</p>
    ${r.summary ? sec('Summary', `<p>${esc(r.summary)}</p>`) : ''}
    ${jobs.length ? sec('Experience', jobs.map(role).join('')) : ''}
    ${r.skills.length ? sec('Skills', `<p>${esc(r.skills.join(', '))}</p>`) : ''}
    ${side.length ? sec('Side Project', side.map(role).join('')) : ''}
    ${r.education.length ? sec('Education', r.education.map((e) => `<p>${esc([e.school, [e.degree, e.field].filter(Boolean).join(' in '), e.end].filter(Boolean).join(', '))}</p>`).join('')) : ''}`

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return await win.webContents.printToPDF({ pageSize: 'Letter', margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 } })
  } finally {
    win.destroy()
  }
}

/** Cover letter as a text-based PDF, for forms that want a file (for example Ashby). */
export async function renderCoverLetterPdf(r: Resume, paragraphs: string[]): Promise<Buffer> {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.45;margin:0} p{margin:0 0 10px} h1{font-size:14pt;margin:0 0 2px}</style>
    <h1>${esc(r.contact.name)}</h1><p>${esc(contactLine(r))}</p><br>${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}`
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return await win.webContents.printToPDF({ pageSize: 'Letter', margins: { top: 0.9, bottom: 0.9, left: 1, right: 1 } })
  } finally {
    win.destroy()
  }
}
