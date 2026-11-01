const flushers = new Set<() => Promise<void>>()
/** Register something that saves pending edits. Returns an unregister function. */
export function registerFlush(fn: () => Promise<void>): () => void {
  flushers.add(fn)
  return () => { flushers.delete(fn) }
}
export const flushAll = async (): Promise<void> => { await Promise.all([...flushers].map((f) => f().catch(() => {}))) }
