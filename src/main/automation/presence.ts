import type { PlanItem } from '../../shared/apply'

/**
 * Which filled fields can no longer be found on the page, as a sign the form was reset or replaced?
 * A file input is never counted: after an upload, ATS pages replace it with a chip showing the file's name, so its absence
 * is normal. (Its content is checked separately, by the file name.)
 */
export function missingAfterFill(plan: PlanItem[], present: Set<string>): PlanItem[] {
  return plan.filter((i) => i.status === 'ready' && !i.domOnly && i.kind !== 'file' && !present.has(i.name))
}
