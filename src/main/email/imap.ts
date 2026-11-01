import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { EmailConnect, Provider } from '../../shared/email'
import type { MailMessage, MailSource } from './pipeline'

export const PRESETS: Record<Exclude<Provider, 'outlook'>, { host: string; port: number }> = {
  gmail: { host: 'imap.gmail.com', port: 993 }, icloud: { host: 'imap.mail.me.com', port: 993 },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 }, fastmail: { host: 'imap.fastmail.com', port: 993 }, custom: { host: '', port: 993 }
}

const client = (c: Pick<EmailConnect, 'host' | 'port' | 'user' | 'password'>): ImapFlow =>
  new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.password }, logger: false, tls: { rejectUnauthorized: true } })

/** Log in and straight out again, to prove the credentials work. */
export async function testConnection(c: EmailConnect): Promise<void> {
  const cl = client(c)
  cl.on('error', () => {})
  try { await cl.connect() } catch (e) {
    const msg = (e as Error & { responseText?: string }).responseText || (e as Error).message
    throw new Error(/auth|credential|login|invalid/i.test(msg) ? 'The mail server rejected those credentials. Most providers need an app password, not your normal one.' : `Could not connect: ${msg}`)
  }
  await cl.logout().catch(() => {})
}

const headerOf = (raw: string, name: string): string => (raw.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'))?.[1] ?? '').trim()

/**
 * A READ-ONLY view of the inbox: the mailbox is opened with EXAMINE, bodies are fetched with PEEK, and nothing is ever
 * flagged, moved, deleted or sent. Use `withSource` so the connection is always closed.
 */
export async function withSource<T>(c: EmailConnect, fn: (s: MailSource) => Promise<T>): Promise<T> {
  const cl = client(c)
  cl.on('error', () => {})
  await cl.connect()
  const lock = await cl.getMailboxLock('INBOX', { readOnly: true })
  try {
    const src: MailSource = {
      async list(since, opts) {
        // With afterUid, only look at mail newer than the last poll: polling every few seconds must stay cheap.
        const found = (await cl.search(opts?.afterUid ? { since, uid: `${opts.afterUid + 1}:*` } : { since }, { uid: true })) || []
        const uids = opts?.afterUid ? found.filter((u) => u > opts.afterUid!) : found
        const out: MailMessage[] = []
        for (let k = 0; k < uids.length; k += 200) {
          for await (const m of cl.fetch(uids.slice(k, k + 200), { uid: true, envelope: true, internalDate: true, headers: ['list-unsubscribe', 'precedence', 'message-id'] }, { uid: true })) {
            const raw = m.headers ? m.headers.toString('utf8') : ''
            const from = m.envelope?.from?.[0]
            out.push({
              uid: m.uid, messageId: headerOf(raw, 'message-id') || m.envelope?.messageId || '', date: new Date(m.internalDate ?? m.envelope?.date ?? Date.now()),
              fromName: from?.name ?? '', fromAddr: (from?.address ?? '').toLowerCase(), subject: m.envelope?.subject ?? '',
              hasListUnsub: !!headerOf(raw, 'list-unsubscribe'), bulk: /bulk|list|junk/i.test(headerOf(raw, 'precedence'))
            })
          }
        }
        return out
      },
      async body(uid) {
        const m = await cl.fetchOne(String(uid), { source: { maxLength: 200_000 } }, { uid: true })
        if (!m || !m.source) return ''
        const p = await simpleParser(m.source)
        return (p.text || (p.html ? String(p.html).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ') : '')).slice(0, 20_000)
      }
    }
    return await fn(src)
  } finally {
    lock.release()
    await cl.logout().catch(() => {})
  }
}
