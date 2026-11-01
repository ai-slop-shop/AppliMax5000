import type { ParseIssue, Resume } from '../shared/resume'
import { roleLine } from './export'

const norm = (s: string): string => s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').toLowerCase().trim()

/** Diff re-parsed export text against the structured profile (spec §5 "Parse check"). */
export function parseCheck(parsedText: string, r: Resume): ParseIssue[] {
  const issues: ParseIssue[] = []
  const flat = norm(parsedText)
  const need = (label: string, v: string, sev: ParseIssue['severity'] = 'error'): void => {
    if (v && !flat.includes(norm(v))) issues.push({ severity: sev, message: `${label} missing or altered in parsed text: "${v}"` })
  }

  need('Name', r.contact.name)
  need('Email', r.contact.email)
  need('Phone', r.contact.phone)
  if (!r.contact.name) issues.push({ severity: 'error', message: 'No name in profile' })
  if (!r.contact.email) issues.push({ severity: 'warn', message: 'No email in profile' })

  for (const h of ['Experience', 'Skills', 'Education']) {
    const has = h === 'Experience' ? r.experience.some((x) => !x.isSideProject) : h === 'Skills' ? r.skills.length : r.education.length
    if (has && !new RegExp(`^\\s*${h}\\s*$`, 'mi').test(parsedText)) issues.push({ severity: 'error', message: `Section heading "${h}" not found as its own line` })
  }

  let lastIdx = -1
  for (const x of r.experience.filter((e) => !e.isSideProject)) {
    const line = roleLine(x)
    const idx = flat.indexOf(norm(line))
    if (idx < 0) {
      issues.push({ severity: 'error', message: `Role line merged or altered: "${line}"` })
      need('Employer', x.employer); need('Title', x.title)
    } else {
      if (idx < lastIdx) issues.push({ severity: 'warn', message: `Role out of order: "${line}"` })
      lastIdx = idx
    }
    if (!x.start) issues.push({ severity: 'warn', message: `No start date: ${x.employer}` })
    if (!x.end) issues.push({ severity: 'warn', message: `No end date (use "Present"?): ${x.employer}` })
    for (const b of x.bullets) need('Bullet', b.text.slice(0, 60), 'warn')
  }
  for (const s of r.skills) need('Skill', s, 'warn')
  return issues
}
