import { z } from 'zod'

/** Bullets start unverified; the user confirms each one before tailoring may use it (spec §4, §6). */
export const BulletSchema = z.object({ text: z.string(), verified: z.boolean().default(false) })

export const ExperienceSchema = z.object({
  employer: z.string(),
  title: z.string(),
  start: z.string().describe('"Mon YYYY" e.g. "Jan 2020", or empty if absent'),
  end: z.string().describe('"Mon YYYY", or "Present", or empty if absent'),
  location: z.string().default(''),
  isSideProject: z.boolean().default(false),
  peopleManaged: z.number().nullable().default(null),
  bullets: z.array(BulletSchema)
})

export const EducationSchema = z.object({
  school: z.string(), degree: z.string(), field: z.string().default(''), end: z.string().default('')
})

export const ResumeSchema = z.object({
  contact: z.object({
    name: z.string(), email: z.string(), phone: z.string(),
    city: z.string(), state: z.string(), linkedin: z.string()
  }),
  summary: z.string(),
  experience: z.array(ExperienceSchema),
  skills: z.array(z.string()),
  education: z.array(EducationSchema)
})

export type Resume = z.infer<typeof ResumeSchema>
export type Experience = z.infer<typeof ExperienceSchema>

export const emptyResume = (): Resume => ({
  contact: { name: '', email: '', phone: '', city: '', state: '', linkedin: '' },
  summary: '', experience: [], skills: [], education: []
})

export interface ParseIssue { severity: 'error' | 'warn'; message: string }
export type ExportFormat = 'docx' | 'pdf'
