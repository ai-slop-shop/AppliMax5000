import { useEffect, useState } from 'react'
import type { Api } from '../../preload'
import type { Resume } from '../../shared/resume'
import { ResumeWorkbench } from './Resume'
import { flushAll } from './flush'
import { Facts } from './Facts'
import { Answers } from './Answers'
import { Stories } from './Stories'
import { Tracker } from './Tracker'
import { Review } from './Review'
import { Jobs } from './Jobs'
import { Autopilot } from './Autopilot'
import { CriteriaTab } from './Criteria'
import { Scene } from './Scene'
import { Hud } from './Hud'
import { Inbox } from './Inbox'

declare global { interface Window { api: Api } }

const TABS = ['Onboarding', 'Resume', 'Facts', 'Stories', 'Answers', 'Criteria', 'Jobs', 'Autopilot', 'Review', 'Tracker', 'Inbox', 'Settings'] as const
type Tab = (typeof TABS)[number]

const BLURB: Record<Tab, string> = {
  Autopilot: 'Let the app apply for you. Set a fit-score threshold and a daily limit; for each company it picks the single best-matching job over the threshold, fills it from your resume, facts and saved answers, checks every field, and submits. Start in rehearse mode to watch what it would do. Anything it cannot do safely on its own is listed for you.',
  Onboarding: 'Start here. Upload your resume (PDF or DOCX) and Claude turns it into structured fields: contact details, roles, bullets and skills. It copies what your resume says and adds nothing. After that, check the result on the Resume tab.',
  Resume: 'Your master resume as editable fields. Tick "verified" on each bullet you know is true: only verified bullets are ever used when tailoring an application. The green panel shows what an applicant tracking system actually reads, and exports (.docx and .pdf) are single-column and parse-checked.',
  Facts: 'True statements about you that go beyond your bullets: years in a role, people managed, tools used. The tailoring engine may only use confirmed facts, which is what stops it inventing anything. Generate a first batch from your resume, then edit each one until it is exactly true and tick it.',
  Stories: 'Short, true stories in your own words: a hard decision, a project you are proud of. When an application asks an essay question, the app drafts an answer only from these. If no story fits, it leaves the question blank for you instead of making something up.',
  Answers: 'Every application question the app has come across, with one answer per question however it is worded. Years of experience are filled in from your resume dates. Legal questions such as work authorization are only ever answered from what you confirm here. Answer once and it is reused on every application.',
  Criteria: 'What you want, in two parts. First, describe it in your own words (the work, pay, places, what to avoid) and ask Claude to widen your search or improve your facts and resume; it proposes changes and you approve them. Below that are the exact settings: pay floor, work modes, titles, places and companies to skip.',
  Jobs: 'Finds and ranks jobs from employer job boards. Switch between the ranked Queue and the employer boards it reads. Your pay floor and what you are looking for are on the Criteria tab.',
  Review: 'Turns a job into an application. Paste a posting, or press "Draft application" in the Jobs queue, and Claude writes a tailored resume and cover letter from your verified material, flagging anything it cannot source. Approve it, then fill the form, check every value, and submit only when you decide to.',
  Tracker: 'Your application history. Record outcomes (screen, interview, offer), see whether tailoring is actually helping, list applications you made before this app so they are never repeated, and read your weekly digest.',
  Inbox: 'Reads your inbox (read-only) for replies to your applications and updates the Tracker: received, screen, interview, offer, rejection. Everything that is not a hiring reply is filtered out on your computer first and never sent anywhere. Only a short summary of each real reply is kept, never the email itself.',
  Settings: 'Your Anthropic API key. It is stored encrypted in the macOS keychain and never reaches the part of the app you see.'
}

function Onboarding({ onDone }: { onDone: (r: Resume) => void }) {
  const [raw, setRaw] = useState('')
  const [file, setFile] = useState('')
  const [status, setStatus] = useState('')
  // The uploaded resume is saved in the app database, so it is still here after a tab change or restart.
  useEffect(() => { window.api.savedResumeSource().then((r) => { if (r) { setRaw(r.text); setFile(r.path) } }) }, [])
  return (
    <>
      <p>Upload your resume. The text is sent to Claude once to be structured; nothing is added to it.</p>
      <button onClick={async () => {
        try { const r = await window.api.pickResume(); if (r) { setRaw(r.text); setFile(r.path); setStatus('') } }
        catch (e) { setStatus(String((e as Error).message ?? e)) }
      }}>Choose PDF / DOCX</button>
      {file && <span className="status"> Saved: {file.split('/').pop()}</span>}
      {raw && (
        <button disabled={!!status} onClick={async () => {
          setStatus('Structuring…')
          try { onDone(await window.api.saveResume(await window.api.structureResume(raw))) }
          catch (e) { setStatus(String((e as Error).message ?? e)); return }
          setStatus('')
        }}>Structure with Claude</button>
      )}
      <span className="status">{status}</span>
      <h3>Extracted text</h3>
      <pre>{raw || 'No resume loaded.'}</pre>
    </>
  )
}

function Settings() {
  const [key, setKey] = useState('')
  const [has, setHas] = useState(false)
  useEffect(() => { window.api.hasApiKey().then(setHas) }, [])
  return (
    <>
      <p>Anthropic API key {has ? '(saved in OS keychain)' : '(not set)'}</p>
      <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." />
      <button disabled={!key} onClick={async () => { await window.api.setApiKey(key); setKey(''); setHas(true) }}>Save</button>
    </>
  )
}

export function App() {
  const [tab, setTab] = useState<Tab>('Onboarding')
  useEffect(() => {
    window.api.onFlush(flushAll)
    window.api.on('nav:tab', (t) => { if ((TABS as readonly string[]).includes(t)) setTab(t as Tab) })
    // Reopen on the Resume tab if a resume was already structured and saved.
    window.api.loadResume().then((r) => { if (r.contact.name || r.experience.length) setTab('Resume') })
  }, [])
  const [resume, setResume] = useState<Resume | undefined>()

  return (
    <>
    <Scene />
    <div className="app">
      <header className="banner"><h1>AppliMax<i>5000</i></h1><span className="sub">Job Application System</span></header>
      <nav>
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <main>
        <h2>{tab}</h2>
        <p className="blurb">{BLURB[tab]}</p>
        {tab === 'Onboarding' && <Onboarding onDone={(r) => { setResume(r); setTab('Resume') }} />}
        {tab === 'Resume' && <ResumeWorkbench key={resume ? 'new' : 'saved'} initial={resume} />}
        {tab === 'Facts' && <Facts />}
        {tab === 'Stories' && <Stories />}
        {tab === 'Answers' && <Answers />}
        {tab === 'Tracker' && <Tracker />}
        {tab === 'Inbox' && <Inbox />}
        {tab === 'Review' && <Review />}
        {tab === 'Settings' && <Settings />}
        {tab === 'Criteria' && <CriteriaTab />}
        {tab === 'Autopilot' && <Autopilot />}
        {tab === 'Jobs' && <Jobs onDraft={() => setTab('Review')} onNav={(t) => setTab(t as Tab)} />}
      </main>
      <Hud refreshKey={tab} />
    </div>
    </>
  )
}
