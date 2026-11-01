import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { ResumeSchema, type Resume } from '../shared/resume'
import { getSecret } from './secrets'

// Stronger model drafts; mid-tier model structures and validates (spec §6).
export const MODELS = {
  draft: 'claude-opus-5-5', check: 'claude-sonnet-5-5', structure: 'claude-sonnet-5-5',
  triage: 'claude-haiku-5-5', score: 'claude-sonnet-5-5'
}

/**
 * One structured-output request validated against a zod schema.
 * Forced tool_choice is rejected by Sonnet 5.5 / Opus 5.5, so we use output_config.format instead.
 */
export async function callTool<S extends z.ZodType>(opts: {
  model: string; system: string; user: string; name: string; schema: S; maxTokens?: number
}): Promise<z.infer<S>> {
  const apiKey = await getSecret('anthropic')
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.')
  const client = new Anthropic({ apiKey })
  // Streaming avoids HTTP timeouts on long outputs; finalMessage() gives the complete response.
  const res = await client.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    output_config: { format: zodOutputFormat(opts.schema) },
    messages: [{ role: 'user', content: opts.user }]
  }).finalMessage()
  if (res.stop_reason === 'refusal') throw new Error('The model declined this request.')
  if (res.stop_reason === 'max_tokens') throw new Error('The response was cut off (too long). Try shorter input.')
  const text = res.content.find((b) => b.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Model returned no structured result')
  return opts.schema.parse(JSON.parse(text.text))
}

const STRUCTURE_SYSTEM = `You convert resume text into structured data.
Hard rules:
- Copy facts exactly as written. Never invent, infer, or embellish employers, titles, dates, metrics, skills, or management claims.
- If a field is absent from the text, use an empty string (or null for peopleManaged).
- Normalize dates to "Mon YYYY"; keep "Present" for current roles.
- Keep bullets verbatim (fix only line-wrap artifacts). Set verified=false on every bullet.
- Experience is reverse-chronological as in the source. Mark isSideProject only if the text labels it a side/personal project.
- Skills: only terms explicitly listed or clearly named in the text.`

export async function structureResume(text: string): Promise<Resume> {
  const parsed = await callTool({
    model: MODELS.structure, system: STRUCTURE_SYSTEM, user: `Resume text:\n\n${text}`,
    name: 'save_resume', schema: ResumeSchema
  })
  // Enforce unverified regardless of what the model returned.
  parsed.experience.forEach((e) => e.bullets.forEach((b) => (b.verified = false)))
  return parsed
}
