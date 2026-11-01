import { getDb } from './db'
import type { Answer } from '../shared/apply'
import { demoTopic } from './automation/mapping'

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Anchored, case-insensitive pattern for one normalized question key ("<company>" matches any name). */
export const patternFor = (key: string): string => `^\\s*${key.split('<company>').map(esc).join('.*')}\\s*\\**\\s*$`

export const listAnswers = (): Answer[] => getDb().prepare('SELECT * FROM answers ORDER BY id').all() as Answer[]
export function addAnswer(pattern: string, answer: string): Answer[] {
  const p = pattern.trim(), a = answer.trim()
  if (p && a) getDb().prepare("INSERT INTO answers (question_pattern, answer, source) VALUES (?, ?, 'user-confirmed')").run(p, a)
  return listAnswers()
}
export function removeAnswer(id: number): Answer[] {
  getDb().prepare('DELETE FROM answers WHERE id = ?').run(id)
  return listAnswers()
}

/**
 * What the apply and blocker steps match against. An answer saved for a question also applies to every wording
 * merged into it, so a question asked ten ways is answered once.
 */
export function answerEntries(): { id: number; question_pattern: string; answer: string }[] {
  const members = getDb().prepare('SELECT key, group_id FROM questions WHERE group_id IS NOT NULL').all() as { key: string; group_id: number }[]
  return listAnswers().flatMap((a) => {
    if (!a.question_id) return [a]
    return [a, ...members.filter((m) => m.group_id === a.question_id).map((m) => ({ id: a.id, question_pattern: patternFor(m.key), answer: a.answer }))]
  })
}

/**
 * Self-identification answers (veteran, Hispanic/Latino, race, gender...) are kept once per topic, whatever the form's wording,
 * so the newest choice replaces the old ones and applies to every later form. Returns false when the label has no known topic.
 */
export function rememberSelfId(label: string, answer: string): boolean {
  const topic = demoTopic(label), a = answer.trim()
  if (!topic || !a) return false
  const db = getDb()
  for (const r of listAnswers()) if (!r.question_id && demoTopic(r.question_pattern.replace(/[\\^$.*+?()[\]{}|]/g, ' ')) === topic) db.prepare('DELETE FROM answers WHERE id = ?').run(r.id)
  addAnswer(`^Self-identification: ${topic}$`, a)
  return true
}
