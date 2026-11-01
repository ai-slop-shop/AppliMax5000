const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** fetch that backs off on rate limits (429) and transient server errors, honoring Retry-After. */
export async function politeFetch(url: string, init?: RequestInit, tries = 4): Promise<Response> {
  let res: Response | undefined
  for (let n = 0; n < tries; n++) {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
    if (res.status !== 429 && res.status < 500) return res
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** n
    await sleep(Math.min(wait, 15_000))
  }
  return res!
}
