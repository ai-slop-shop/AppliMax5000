import { MS } from './oauth'
import type { MailMessage, MailSource } from './pipeline'

// A READ-ONLY view of the inbox through Microsoft Graph. Only GET requests are ever made, and the token only holds
// Mail.Read, so even a bug here could not send, change or delete anything.

interface GMsg {
  id: string; internetMessageId?: string; receivedDateTime: string; subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }; internetMessageHeaders?: { name: string; value: string }[]
}

async function get<T>(url: string, token: string, extra: Record<string, string> = {}): Promise<T> {
  for (let n = 0; n < 4; n++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra }, signal: AbortSignal.timeout(60_000) })
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, Math.min((Number(res.headers.get('retry-after')) || 2 ** n) * 1000, 15_000))); continue }
    if (res.status === 401) throw new Error('Microsoft rejected the sign-in. Connect again.')
    if (res.status === 403) throw new Error('Microsoft blocked access to the mailbox (Mail.Read not granted).')
    if (!res.ok) throw new Error(`Microsoft Graph returned HTTP ${res.status}`)
    return await res.json() as T
  }
  throw new Error('Microsoft Graph is busy. Try again in a minute.')
}

export async function whoAmI(token: string, base = MS.graph): Promise<string> {
  const me = await get<{ mail?: string; userPrincipalName?: string }>(`${base}/me?$select=mail,userPrincipalName`, token)
  return me.mail || me.userPrincipalName || ''
}

const header = (m: GMsg, name: string): string => m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? ''

export function graphSource(token: string, base = MS.graph): MailSource {
  const ids = new Map<number, string>() // the pipeline refers to messages by number; Graph ids are long strings
  return {
    async list(since) {
      const out: MailMessage[] = []
      const q = new URLSearchParams({ $select: 'id,internetMessageId,receivedDateTime,subject,from,internetMessageHeaders', $filter: `receivedDateTime ge ${since.toISOString()}`, $orderby: 'receivedDateTime desc', $top: '100' })
      let url: string | undefined = `${base}/me/mailFolders/inbox/messages?${q}`
      for (let page = 0; url && page < 40; page++) {
        const r: { value: GMsg[]; '@odata.nextLink'?: string } = await get(url, token)
        for (const m of r.value) {
          const uid = ids.size + 1
          ids.set(uid, m.id)
          out.push({
            uid, messageId: m.internetMessageId ?? m.id, date: new Date(m.receivedDateTime), fromName: m.from?.emailAddress?.name ?? '', fromAddr: (m.from?.emailAddress?.address ?? '').toLowerCase(),
            subject: m.subject ?? '', hasListUnsub: !!header(m, 'list-unsubscribe'), bulk: /bulk|list|junk/i.test(header(m, 'precedence'))
          })
        }
        url = r['@odata.nextLink']
      }
      return out
    },
    async body(uid) {
      const id = ids.get(uid)
      if (!id) return ''
      const m = await get<{ body?: { content?: string } }>(`${base}/me/messages/${encodeURIComponent(id)}?$select=body`, token, { Prefer: 'outlook.body-content-type="text"' })
      return (m.body?.content ?? '').slice(0, 20_000)
    }
  }
}
