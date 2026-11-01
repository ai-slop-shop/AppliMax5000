# AppliMax5000
USE AT YOUR OWN RISK.  I built this tool in a day, and I'm not even sure it works.  
Upload your resume, plug in your Claude API key, and it will try to help you find a job, tailoring your cover letter and resume to the job that you are applying for. 

Did it get me a job when I tried it?  No.  Will it get you a job?  Probably not.  Either way, I figured they are using AI to gatekeep us; we might as well use it to try to pick the lock.

## Requirements

- macOS
- Node.js 20+ and npm
- An Anthropic account with API access

## Install and run

```bash
git clone https://github.com/ai-slop-shop/AppliMax5000.git
cd AppliMax5000
npm install        # also rebuilds better-sqlite3 for Electron (postinstall)
npm run dev        # start the app in development mode
```

Other scripts:

| Command             | What it does                     |
| ------------------- | -------------------------------- |
| `npm run build`     | Build main, preload and renderer |
| `npm start`         | Preview the built app            |
| `npm run typecheck` | Type-check the project           |
| `npm run package`   | Build a macOS `.dmg` / `.app`    |

## Setting up Claude

AppliMax5000 calls the Claude API directly using your own Anthropic API key. There is no `.env` file to edit.

1. **Create an API key.** Sign in at <https://console.anthropic.com>, add billing or credits under *Billing*, then go to *Settings → API Keys* and click *Create Key*. Copy the key (it starts with `sk-ant-`). You will only see it once.
2. **Launch the app** with `npm run dev`.
3. **Open the Settings tab** (the last tab in the app).
4. **Paste your key** into the Anthropic API key field and save. The status line changes from "(not set)" to "(saved in OS keychain)".

The key is encrypted with the macOS keychain through Electron's `safeStorage`, stored in the app's user data folder as `anthropic.secret`, and never sent to the UI layer. To replace it, paste a new key in Settings. To remove it, delete `anthropic.secret` from the app's user data directory (`~/Library/Application Support/applimax5000/`).

If you see **"Add your Anthropic API key in Settings first."**, the key is missing or was not saved.

### Models used

| Task                           | Model               |
| ------------------------------ | ------------------- |
| Drafting resumes and answers   | `claude-opus-5-5`   |
| Checking, structuring, scoring | `claude-sonnet-5-5` |
| Triage                         | `claude-haiku-5-5`  |

Model IDs are set in `src/main/llm.ts` if you want to change them. Usage is billed to your Anthropic account.

## Optional: email inbox

The Inbox tab can read application replies over IMAP (Gmail, iCloud) or Microsoft Graph (Outlook). Microsoft sign-in needs your own Entra app registration with supported account types set to "Accounts in any organizational directory and personal Microsoft accounts". For Gmail and iCloud, use an app-specific password rather than your normal one.

## Project layout

```
src/main        Electron main process: database, Claude calls, discovery, automation, email
src/preload     Bridge between main and renderer
src/renderer    React UI
src/shared      Types and schemas shared by both sides
resources       Tray icons
```

## Privacy

Your data stays on your machine in a local SQLite database. The only network calls are to the Anthropic API, job boards and ATS sites you target, and your email provider if you connect one.
