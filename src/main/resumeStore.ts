import { getDb } from './db'
import { ResumeSchema, emptyResume, type Resume } from '../shared/resume'

// The master resume is stored as one JSON document (includes summary, skills, education that the
// spec's profile/experience tables don't cover). Contact fields are mirrored into `profile`.
export function loadResume(): Resume {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'resume_master'").get() as { value: string } | undefined
  return row ? ResumeSchema.parse(JSON.parse(row.value)) : emptyResume()
}

const employerSet = (r: Resume): string => JSON.stringify([...new Set(r.experience.filter((x) => !x.isSideProject).map((x) => x.employer.trim().toLowerCase()).filter(Boolean))].sort())

export function saveResume(input: unknown): Resume {
  const r = ResumeSchema.parse(input)
  const db = getDb()
  const before = employerSet(loadResume())
  db.transaction(() => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('resume_master', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(r))
    db.prepare(`INSERT INTO profile (id, name, email, phone, city, state, linkedin) VALUES (1, @name, @email, @phone, @city, @state, @linkedin)
      ON CONFLICT(id) DO UPDATE SET name=@name, email=@email, phone=@phone, city=@city, state=@state, linkedin=@linkedin`).run(r.contact)
  })()
  // Your employers changed: jobs hidden because you worked there are re-evaluated on the next discovery run.
  if (before !== employerSet(r)) {
    db.prepare(`DELETE FROM jobs WHERE status = 'skipped' AND skip_reason LIKE 'auto: you worked there%'
      AND id NOT IN (SELECT job_id FROM applications) AND id NOT IN (SELECT job_id FROM drafts)`).run()
  }
  return r
}
