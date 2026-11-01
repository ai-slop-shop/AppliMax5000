import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

// Microsoft sign-in for a desktop app: authorization code with PKCE, redirected to a one-shot server on this computer.
// No client secret exists (a desktop app cannot keep one); the user's own Azure app registration supplies the client id.

export interface OAuthCfg { clientId: string; authority: string; scopes: string[] }
export const MS = {
  authority: 'https://login.microsoftonline.com/common', // "common" accepts both personal Outlook.com and work/school accounts
  graph: 'https://graph.microsoft.com/v1.0',
  scopes: ['offline_access', 'Mail.Read', 'User.Read'] // Mail.Read is read-only: it cannot send, change or delete mail
}
export interface Tokens { access_token: string; refresh_token?: string; expires_in: number }

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authUrl(cfg: OAuthCfg, redirect: string, state: string, challenge: string): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: cfg.scopes.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })
  return `${cfg.authority}/oauth2/v2.0/authorize?${q}`
}

async function tokenRequest(cfg: OAuthCfg, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${cfg.authority}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId, ...params })
  })
  const j = await res.json().catch(() => ({})) as Tokens & { error?: string; error_description?: string }
  if (!res.ok || !j.access_token) throw new Error(explain(j.error, j.error_description))
  return j
}
export const explain = (code?: string, desc?: string): string => {
  // The account is not allowed into the tenant that owns the app. Which tenant matters: it says whose app this is.
  const tenant = (desc ?? '').match(/tenant '([^']+)'/)?.[1]
  if (/AADSTS50020|does not exist in tenant/i.test(desc ?? '')) {
    return /microsoft services/i.test(tenant ?? '')
      ? 'Microsoft says this account has no directory (tenant) of its own, so it cannot use Entra or an app registration yet. Sign up for a free Azure account with the same email (azure.microsoft.com/free) to create one, then register the app. If this appeared while signing in from this app, the Client ID is not from your own registration.'
      : `Your app registration only allows accounts from "${tenant ?? 'one organization'}". In Entra open your app, choose Authentication, and set Supported account types to "Accounts in any organizational directory and personal Microsoft accounts".`
  }
  if (code === 'invalid_client' || /AADSTS700016|AADSTS70001/.test(desc ?? '')) return 'Microsoft does not recognize that Application (client) ID. Check it in your app registration.'
  if (code === 'invalid_grant') return 'The sign-in expired or was revoked. Connect again.'
  if (/AADSTS65001|consent/i.test(desc ?? '')) return 'Your organization needs an administrator to approve this app (Mail.Read). Ask your IT admin, or use a personal Outlook.com account.'
  if (/AADSTS50011|redirect/i.test(desc ?? '')) return 'The redirect address is not registered. In your app registration add the platform "Mobile and desktop applications" with the redirect http://localhost.'
  return (desc ?? code ?? 'Microsoft sign-in failed').split('\r\n')[0].slice(0, 200)
}

export const refreshTokens = (cfg: OAuthCfg, refreshToken: string): Promise<Tokens> =>
  tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: cfg.scopes.join(' ') })

let active: { server: Server; cancel: () => void } | null = null
export const cancelSignIn = (): void => active?.cancel()

/**
 * Open the user's browser to Microsoft and wait for the redirect. The listener accepts exactly one valid callback
 * (state must match), binds to this machine only, and closes itself on success, failure, cancel or timeout.
 */
export function signIn(cfg: OAuthCfg, openUrl: (url: string) => void, timeoutMs = 5 * 60_000): Promise<Tokens> {
  cancelSignIn()
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(16))
  return new Promise<Tokens>((resolve, reject) => {
    let done = false
    const server = createServer()
    const finish = (err: Error | null, tokens?: Tokens): void => {
      if (done) return
      done = true; clearTimeout(timer); active = null; server.close(); server.closeAllConnections?.()
      err ? reject(err) : resolve(tokens!)
    }
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), timeoutMs)
    active = { server, cancel: () => finish(new Error('Sign-in cancelled.')) }
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      if (u.pathname !== '/') { res.writeHead(404).end(); return }
      const page = (msg: string): void => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><body style="font:20px monospace;background:#0b0221;color:#19f0ff;padding:48px"><h2>AppliMax5000</h2><p>${msg}</p>`) }
      if (u.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid state'); return } // not our request: ignore it, keep waiting
      const err = u.searchParams.get('error')
      if (err) { page('Sign-in was not completed. You can close this tab.'); finish(new Error(explain(err, u.searchParams.get('error_description') ?? undefined))); return }
      const code = u.searchParams.get('code')
      if (!code) { res.writeHead(400).end('Missing code'); return }
      page('Signed in. You can close this tab and return to the app.')
      tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: `http://localhost:${(server.address() as { port: number }).port}/`, code_verifier: verifier, scope: cfg.scopes.join(' ') })
        .then((t) => finish(null, t), (e: Error) => finish(e))
    })
    server.on('error', (e) => finish(e as Error))
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      openUrl(authUrl(cfg, `http://localhost:${port}/`, state, challenge))
    })
  })
}
