import { getDb } from './db'
import type { Fact } from '../shared/tailor'

type Row = Omit<Fact, 'confirmed'> & { confirmed: number }
const all = (): Fact[] => (getDb().prepare('SELECT id, text, source, confirmed, evidence, previous_text FROM facts ORDER BY id').all() as Row[]).map((r) => ({ ...r, confirmed: !!r.confirmed }))

/** Everything, for the Facts screen. */
export const listFacts = all
/** What the tailoring and scoring engines may use. Unconfirmed (generated) facts are excluded. */
export const listConfirmedFacts = (): Fact[] => all().filter((f) => f.confirmed)

export function addFact(text: string): Fact[] {
  if (text.trim()) getDb().prepare("INSERT INTO facts (text, source, confirmed) VALUES (?, 'user', 1)").run(text.trim())
  return all()
}
export function updateFact(id: number, text: string, confirmed: boolean): Fact[] {
  const t = text.trim()
  if (t) getDb().prepare('UPDATE facts SET text = ?, confirmed = ? WHERE id = ?').run(t, confirmed ? 1 : 0, id)
  return all()
}
export function confirmAllFacts(): Fact[] {
  getDb().prepare('UPDATE facts SET confirmed = 1').run()
  return all()
}
export function removeFact(id: number): Fact[] {
  getDb().prepare('DELETE FROM facts WHERE id = ?').run(id)
  return all()
}

/** Apply an approved rewrite. The old wording is kept so it can be reverted; confirmation status is unchanged. */
export function rewriteFact(id: number, text: string): void {
  const t = text.trim()
  if (t) getDb().prepare('UPDATE facts SET previous_text = text, text = ? WHERE id = ? AND text != ?').run(t, id, t)
}
export function revertFact(id: number): Fact[] {
  getDb().prepare("UPDATE facts SET text = previous_text, previous_text = '' WHERE id = ? AND previous_text != ''").run(id)
  return all()
}
