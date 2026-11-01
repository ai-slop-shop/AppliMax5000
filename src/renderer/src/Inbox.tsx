import { useEffect, useState } from 'react'
import type { AppChoice, EmailAccount, EmailEvent, Provider, ScanSummary } from '../../shared/email'

const clean = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const HELP: Record<Provider, string> = {
  gmail: 'Gmail needs 2-Step Verification turned on, then an app password from myaccount.google.com/apppasswords. Use that 16-character password here, not your normal one.',
  icloud: 'iCloud needs an app-specific password from appleid.apple.com (Sign-In and Security).',
  yahoo: 'Yahoo needs an app password from your account security settings.',
  fastmail: 'Fastmail needs an app password from Settings, Privacy & Security, Integrations.',
  outlook: 'Outlook.com, Hotmail and Microsoft 365 no longer accept passwords from apps, so you sign in with Microsoft in your browser instead. The app is only given read-only access to your mail (the Mail.Read permission): it cannot send, change or delete anything.',
  custom: 'Any provider that offers IMAP with a password or app password.'
}
const LABEL: Record<string, string> = { received: 'Received', screen: 'Screen', interview: 'Interview', assessment: 'Assessment', offer: 'Offer', rejection: 'Rejection' }
const TONE: Record<string, string> = { interview: 'good', offer: 'good', screen: 'good', assessment: 'good', rejection: 'bad', received: 'meh' }
const OUTCOME = new Set(['screen', 'interview', 'assessment', 'offer', 'rejection'])

export function Inbox() {
  const [acct, setAcct] = useState<EmailAccount | null>(null)
  const [events, setEvents] = useState<EmailEvent[]>([])
  const [apps, setApps] = useState<AppChoice[]>([])
  const [sum, setSum] = useState<ScanSummary | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [days, setDays] = useState(30)
  const [clientId, setClientId] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [f, setF] = useState({ provider: 'gmail' as Provider, host: '', port: 993, user: '', password: '' })

  const load = (): void => { window.api.emailAccount().then(setAcct); window.api.emailEvents().then((r) => { setEvents(r.events); setApps(r.apps) }) }
  useEffect(load, [])
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setMsg(label + '…')
    try { await fn(); setMsg('') } catch (e) { setMsg(clean(e)) }
    setBusy(false)
  }

  if (!acct) return <p>Loading…</p>

  if (!acct.connected) return (
    <>
      <div className="issues">
        <b>What this does, and does not do</b>
        <ul className="tight">
          <li><b>Read-only.</b> The app can look at your inbox but never changes it: nothing is marked read, moved, deleted or sent.</li>
          <li><b>Filtered on your computer first.</b> It reads only senders and subjects, and drops anything that does not look like a hiring reply: newsletters, job alerts, banks, shopping, personal mail. Those are never opened and never leave your machine.</li>
          <li><b>Only the survivors reach Claude.</b> A short excerpt of each likely job-response email is sent to Claude to classify (received, interview, rejection, offer).</li>
          <li><b>Almost nothing is kept.</b> For each real job response it stores the date, sender, subject, company and a one-line quote. Never the message body. Your password is encrypted in the macOS keychain.</li>
        </ul>
      </div>
      <h3>Connect your email</h3>
      <label className="row"><span>Provider</span>
        <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as Provider })}>
          <option value="gmail">Gmail</option><option value="outlook">Outlook / Microsoft 365</option><option value="icloud">iCloud</option><option value="yahoo">Yahoo</option><option value="fastmail">Fastmail</option><option value="custom">Other (IMAP)</option></select></label>
      {f.provider === 'outlook' ? (
        <>
          <p><small>{HELP.outlook}</small></p>
          <div className="issues">
            <b>One-time setup (about 3 minutes, free)</b>
            <p><small>Microsoft asks every app to be registered, so you register this one yourself. That also means nobody else is involved: the sign-in goes straight between you and Microsoft.</small></p>
            <ol className="tight">
              <li>Open the <a href="#" onClick={(e) => { e.preventDefault(); window.api.openExternal('https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade') }}>Azure portal, App registrations</a> and sign in with your Outlook account, then press <b>New registration</b>.
                <br /><small><b>Error "…does not exist in tenant 'Microsoft Services'"?</b> A personal account that has never used Azure has no directory yet, so Microsoft refuses it. Fix: sign up for a free Azure account with the same email at <a href="#" onClick={(e) => { e.preventDefault(); window.api.openExternal('https://azure.microsoft.com/free') }}>azure.microsoft.com/free</a>. It asks for a card and phone number only to verify you, and registering an app costs nothing. That creates the directory. Then return to the link above.</small></li>
              <li>Name it <b>AppliMax5000</b>. Under <b>Supported account types</b> choose <b>Accounts in any organizational directory and personal Microsoft accounts</b>.</li>
              <li>Under <b>Redirect URI</b> choose <b>Public client/native (mobile &amp; desktop)</b> and enter <code>http://localhost</code>. Press Register.</li>
              <li>Go to <b>API permissions → Add a permission → Microsoft Graph → Delegated permissions</b> and add <b>Mail.Read</b> (only that one; <code>offline_access</code> and <code>User.Read</code> are fine too).</li>
              <li>On the <b>Overview</b> page copy the <b>Application (client) ID</b> and paste it below.</li>
            </ol>
            <p><small><b>Check the ID:</b> it must come from the app <i>you</i> just created, on its Overview page.</small></p>
            <p><small><b>Would rather not use Azure at all?</b> In Outlook, add a forwarding rule that sends hiring replies to a Gmail or iCloud address, then connect that mailbox here with an app password. No registration needed.</small></p>
            <p><small>Work or school accounts: if your organization blocks users from approving apps, an administrator has to approve Mail.Read. A personal Outlook.com account does not have that limit.</small></p>
          </div>
          <label className="row"><span>Client ID</span><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1a2b3c4d-1234-5678-9abc-def012345678" /></label>
          <button disabled={busy || waiting || !clientId.trim()} onClick={async () => {
            setWaiting(true); setMsg('')
            try { setAcct(await window.api.connectOutlook(clientId)); load() } catch (e) { setMsg(clean(e)) }
            setWaiting(false)
          }}>Sign in with Microsoft</button>
          {waiting && <> <span className="status">Finish signing in in your browser…</span> <button onClick={() => window.api.cancelOutlook()}>Cancel</button>
            <div className="issues">
              <b>If Microsoft shows an error page instead</b>
              <p><small>Microsoft's error pages appear only in your browser, so the app cannot see them. Press Cancel and check:</small></p>
              <ul className="tight">
                <li><small><b>"…does not exist in tenant 'Microsoft Services'…"</b>: your account has no Azure directory yet (see setup step 1), or the Client ID is not from your own registration. "App not found": the Client ID has a typo.</small></li>
                <li><small><b>"…does not exist in tenant '(your name)'…"</b>: set Supported account types to include personal Microsoft accounts (app → Authentication).</small></li>
                <li><small><b>"Redirect URI mismatch"</b>: the redirect must be <code>http://localhost</code> under the platform "Mobile and desktop applications".</small></li>
                <li><small><b>"Need admin approval"</b>: a work or school account whose organization blocks apps. Use a personal Outlook.com account or ask your admin.</small></li>
              </ul>
            </div></>}
          {msg && !waiting && <p className="error">{msg}</p>}
        </>
      ) : (
        <>
      {f.provider === 'custom' && <label className="row"><span>IMAP server</span><input value={f.host} placeholder="imap.example.com" onChange={(e) => setF({ ...f, host: e.target.value })} /><input style={{ maxWidth: 90 }} type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></label>}
      <label className="row"><span>Email address</span><input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="you@gmail.com" /></label>
      <label className="row"><span>App password</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="not your normal password" /></label>
      <p><small>{HELP[f.provider]}</small></p>
      <button disabled={busy || !f.user || !f.password} onClick={() => run('Checking the login', async () => { setAcct(await window.api.connectEmail(f)); setF({ ...f, password: '' }); load() })}>Connect</button>
      {msg && <p className={busy ? 'status' : 'error'}>{msg}</p>}
        </>
      )}
    </>
  )

  const attention = events.filter((e) => !e.ignored && (e.applicationId == null && e.category !== 'received' || (e.applicationId != null && !e.applied && OUTCOME.has(e.category))))
  const rest = events.filter((e) => !attention.includes(e))

  const row = (e: EmailEvent): React.ReactNode => (
    <div key={e.id} className={`mail ${e.ignored ? 'ignored' : ''}`}>
      <span className={`tag ${TONE[e.category] ?? ''}`}>{LABEL[e.category] ?? e.category}</span>
      <div className="mbody">
        <div><b>{e.company || 'Unknown company'}</b>{e.role && ` · ${e.role}`} <small>({e.date}{e.confidence === 'low' ? ', low confidence' : ''})</small></div>
        <small>{e.from} — {e.subject}</small>
        {e.evidence && <small className="quote">“{e.evidence}”</small>}
        <div className="row">
          <select value={e.applicationId ?? ''} onChange={async (ev) => setEvents(await window.api.assignEmail(e.id, ev.target.value ? Number(ev.target.value) : null))}>
            <option value="">{e.applicationId == null ? 'Not matched to an application' : 'Unlink'}</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {e.applicationId != null && !e.applied && !e.ignored && OUTCOME.has(e.category) && <button onClick={async () => setEvents(await window.api.applyEmail(e.id))}>Apply to tracker</button>}
          {e.category === 'received' && e.applicationId == null && e.company && !e.addedPast && <button onClick={async () => setEvents(await window.api.addEmailToPast(e.id))} title="You applied somewhere the app did not know about. Remember it so it is never repeated.">Add to past list</button>}
          {!e.ignored && (e.applied || e.applicationId != null || e.category !== 'received') && <button onClick={async () => { setEvents(await window.api.undoEmail(e.id)); load() }}>{e.applied ? 'Undo' : 'Dismiss'}</button>}
          {e.applied && <small className="ok">Tracker updated</small>}{e.addedPast && <small className="ok">Added to past list</small>}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div className="bar">
        <button disabled={busy} onClick={() => run('Scanning your inbox (read-only)', async () => { setSum(await window.api.scanEmail(days)); load() })}>Scan now</button>
        <label className="row" style={{ margin: 0 }}><span style={{ width: 'auto' }}>last</span><input type="number" min={1} max={365} style={{ width: 64, flex: 'none' }} value={days} onChange={(e) => setDays(Number(e.target.value))} /><span style={{ width: 'auto' }}>days</span></label>
        <span className="status">{busy ? msg : `Connected: ${acct.user}${acct.lastScan ? ` · last scan ${acct.lastScan.slice(0, 16).replace('T', ' ')} UTC` : ''}`}</span>
      </div>
      {!busy && msg && <p className="error">{msg}</p>}

      <div className="row">
        <label><input type="checkbox" checked={acct.autoApply} onChange={async (e) => setAcct(await window.api.setEmailOptions({ autoApply: e.target.checked }))} /> Update the tracker automatically from clear matches (every change can be undone)</label>
      </div>
      <div className="row">
        <label><input type="checkbox" checked={acct.autoCode} onChange={async (e) => setAcct(await window.api.setEmailOptions({ autoCode: e.target.checked }))} /> When a job site emails me a security code after I press Submit, find it and enter it for me</label>
      </div>
      <p><small>Only after you press Submit, and only when the page itself asks for a code. It looks only at mail that arrived since then, from the site's own mail domain (Greenhouse), reads that one message, and types the code. No AI is involved, and nothing about the code is saved.</small></p>
      <div className="row">
        <label><input type="checkbox" checked={acct.autoScan} onChange={async (e) => setAcct(await window.api.setEmailOptions({ autoScan: e.target.checked }))} /> Scan every few hours while the app is open, and notify me about interviews and offers</label>
      </div>

      {sum && (
        <div className="issues">
          <b>Last scan</b>
          <ul className="tight">
            <li>{sum.examined} new email(s) looked at (senders and subjects only).</li>
            <li>{sum.ignored} were not hiring emails and were ignored on your computer: never opened, never sent anywhere.</li>
            <li>{sum.sentForReview} looked like hiring replies; an excerpt of each went to Claude. {sum.kept} were confirmed as real responses.</li>
            <li>{sum.matched} matched an application, {sum.applied} updated your tracker, {sum.unmatched} still need you.</li>
            {sum.errors.map((x, i) => <li key={i} className="warn">{x}</li>)}
          </ul>
        </div>
      )}

      {attention.length > 0 && <><h3>Needs you ({attention.length})</h3>{attention.map(row)}</>}
      {rest.length > 0 && <><h3>Recognized job emails ({rest.length})</h3>{rest.map(row)}</>}
      {events.length === 0 && <p>Nothing recognized yet. Press "Scan now".</p>}

      <h3>Disconnect</h3>
      <p><small>Forgetting the login stops all scanning. You can also delete everything the app recognized from email.</small></p>
      <button onClick={() => { if (window.confirm('Disconnect your email and delete everything recognized from it? Tracker outcomes you already have stay.')) run('Disconnecting', async () => { setAcct(await window.api.disconnectEmail(true)); setEvents([]); setSum(null) }) }}>Disconnect &amp; delete email data</button>
    </>
  )
}
