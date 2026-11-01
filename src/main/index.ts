import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { getDb } from './db'
import { getSetting, setSetting } from './settings'
import { extractResumeText } from './resume'
import { launchAutomationBrowser } from './automation/browser'
import { writeFile } from 'node:fs/promises'
import { structureResume } from './llm'
import { loadResume, saveResume } from './resumeStore'
import { renderDocx, renderPdf, renderPlainText } from './export'
import { parseCheck } from './parseCheck'
import { hasSecret, setSecret } from './secrets'
import { ResumeSchema, type ExportFormat } from '../shared/resume'
import type { PostingInput, TailoredDraft } from '../shared/tailor'
import { enterCodeFromEmail, acceptChanges, buildPlan, checkConfirmation, confirmSuggested, closeSession, fillForm, reverify, submitForm } from './automation/runner'
import { answerQuestion, consolidateQuestions, mergeObviousDuplicates, pruneExcludedQuestions, dismissQuestion, listQuestions, scanPostings, suggestAnswers } from './questions'
import { addAnswer, listAnswers, removeAnswer } from './answers'
import type { ApplicationRow } from '../shared/apply'
import { addBoard, listBoards, listJobs, removeBoard, restoreJob, resetAutoSkips, seedDraft, skipJob, toggleBoard } from './discovery/store'
import { getCriteria, getSchedule, setCriteria, setSchedule } from './discovery/criteria'
import { addToPast, appChoices, applyNow as applyEmail, assign as assignEmail, connect as connectEmail, connectOutlook, cancelOutlook, disconnect as disconnectEmail, getAccount, listEvents, scan as scanEmail, setOptions as setEmailOptions, undo as undoEmail } from './email/service'
import type { EmailConnect } from '../shared/email'
import { applyBrief, getBrief, hasResumeUndo, proposeFromBrief, setBrief, undoResumeRewrite } from './discovery/brief'
import { revertFact } from './facts'
import type { BriefSelection } from '../shared/discovery'
import { setupFromResume } from './discovery/setup'
import { getSearch, searchSites, setAdzunaKey, setSearch } from './discovery/search'
import { recheckBlockers } from './discovery/run'
import { pendingApprovals, resolveApproval } from './approvals'
import { autopilotStatus, releaseHolds, runAutopilot, setAutopilot } from './autopilot'
import { runNow, startScheduler, status as discoveryStatus } from './discovery/scheduler'
import type { AutopilotSettings, Criteria, Schedule, SearchSettings } from '../shared/discovery'
import { draftEssay, listStories, removeStory, saveStory } from './stories'
import { markJobApplied, unmarkJobApplied, addPast, applyHistoryToQueue, findPrior, previousEmployers, importPast, listPast, removePast } from './history'
import { assignVariant, buildDigest, controlDraft, getExperiment, getExperimentStats, setExperiment, setOutcome } from './experiments'
import type { ExperimentSettings, Outcome } from '../shared/experiment'
import { addFact, confirmAllFacts, listConfirmedFacts, listFacts, removeFact, updateFact } from './facts'
import { generateFacts } from './factsGen'
import { generateDraft } from './tailor'
import { approveDraft, deleteDraft, getDraft, listDrafts, saveNewDraft, updateDraft } from './drafts'

// Keep userData at ~/Library/Application Support/applimax5000 (dev + packaged share one DB)
app.setName('applimax5000')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow()
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 840, backgroundColor: '#0b0221', title: 'AppliMax5000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  // Closing the window hides it to the menu bar; use Quit (tray menu or Cmd+Q) to exit.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide() } })
  win.on('hide', () => win?.webContents.send('app:flush')) // save edits whenever the window goes away
  win.on('closed', () => { win = null })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('AppliMax5000')
  const menu = Menu.buildFromTemplate([
    { label: 'Open AppliMax5000', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.on('click', () => { if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide(); else showWindow() })
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
}

// On quit, ask the renderer to save anything pending (up to 2s), close any automation browser, then exit.
let flushed = false
app.on('before-quit', (e) => {
  quitting = true
  if (flushed) return
  flushed = true
  e.preventDefault()
  const finish = (): void => { closeSession().catch(() => {}).finally(() => app.quit()) }
  if (!win || win.isDestroyed()) return finish()
  const timer = setTimeout(finish, 2000)
  ipcMain.once('flush:done', () => { clearTimeout(timer); finish() })
  win.webContents.send('app:flush')
})

app.whenReady().then(() => {
  getDb()
  try { pruneExcludedQuestions(); mergeObviousDuplicates() } catch { /* the Answers list just stays as it was */ }

  ipcMain.handle('resume:pick', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Resume', extensions: ['pdf', 'docx'] }]
    })
    if (r.canceled) return null
    const src = { path: r.filePaths[0], text: await extractResumeText(r.filePaths[0]) }
    setSetting('resume_source', JSON.stringify(src)) // survives restarts and tab changes
    return src
  })
  ipcMain.handle('resume:source', () => {
    const v = getSetting('resume_source')
    return v ? JSON.parse(v) as { path: string; text: string } : null
  })

  ipcMain.handle('resume:structure', (_e, text: string) => structureResume(text))
  ipcMain.handle('resume:load', () => loadResume())
  ipcMain.handle('resume:save', (_e, r: unknown) => saveResume(r))
  ipcMain.handle('resume:plainText', (_e, r: unknown) => renderPlainText(ResumeSchema.parse(r)))
  ipcMain.handle('resume:export', async (_e, format: ExportFormat, draftId?: number) => {
    const resume = draftId != null ? getDraft(draftId).resume : loadResume()
    const r = await dialog.showSaveDialog({
      defaultPath: `${(resume.contact.name || 'resume').replace(/\s+/g, '_')}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, format === 'docx' ? await renderDocx(resume) : await renderPdf(resume))
    // Re-parse what we just wrote and diff against the structured profile.
    const issues = parseCheck(await extractResumeText(r.filePath), resume)
    return { path: r.filePath, issues }
  })
  ipcMain.handle('facts:list', () => listFacts())
  ipcMain.handle('facts:add', (_e, t: string) => addFact(t))
  ipcMain.handle('facts:update', (_e, id: number, text: string, confirmed: boolean) => updateFact(id, text, confirmed))
  ipcMain.handle('facts:confirmAll', () => confirmAllFacts())
  ipcMain.handle('facts:generate', () => generateFacts())
  ipcMain.handle('facts:remove', (_e, id: number) => removeFact(id))
  ipcMain.handle('tailor:generate', async (_e, posting: PostingInput, opts?: { forceTailored?: boolean }) => {
    // Blind random assignment when the experiment is on. "Tailor anyway" leaves the experiment for that posting.
    const prior = findPrior({ url: posting.url, company: posting.company, title: posting.title })
    if (prior) throw new Error(prior.message)
    const excluded = !!opts?.forceTailored
    const variant = excluded ? 'tailored' : assignVariant()
    const gen = variant === 'control' ? controlDraft(loadResume(), posting) : await generateDraft(loadResume(), listConfirmedFacts(), posting)
    return saveNewDraft({ ...gen, variant, excludedFromExperiment: excluded })
  })
  ipcMain.handle('employers:list', () => previousEmployers())
  ipcMain.handle('past:list', () => listPast())
  ipcMain.handle('past:add', (_e, p: { company: string; title: string; url: string; applied_at?: string; note?: string }) => addPast(p))
  ipcMain.handle('past:import', (_e, text: string) => importPast(text))
  ipcMain.handle('past:remove', (_e, id: number) => removePast(id))
  ipcMain.handle('experiment:get', () => getExperiment())
  ipcMain.handle('experiment:set', (_e, s: ExperimentSettings) => setExperiment(s))
  ipcMain.handle('experiment:stats', () => getExperimentStats())
  ipcMain.handle('digest:get', () => buildDigest())
  ipcMain.handle('applications:outcome', (_e, id: number, o: Outcome) => setOutcome(id, o))
  ipcMain.handle('tailor:list', () => listDrafts())
  ipcMain.handle('tailor:get', (_e, id: number) => getDraft(id))
  ipcMain.handle('tailor:update', (_e, d: TailoredDraft) => updateDraft(d))
  ipcMain.handle('tailor:delete', async (_e, id: number) => { await closeSession().catch(() => {}); return deleteDraft(id) })
  ipcMain.handle('tailor:approve', (_e, id: number) => approveDraft(id))
  ipcMain.handle('answers:list', () => listAnswers())
  ipcMain.handle('answers:add', (_e, p: string, a: string) => addAnswer(p, a))
  ipcMain.handle('answers:remove', (_e, id: number) => removeAnswer(id))
  ipcMain.handle('questions:list', (_e, inc: boolean) => listQuestions(inc))
  ipcMain.handle('questions:answer', (_e, id: number, v: string) => answerQuestion(id, v))
  ipcMain.handle('questions:dismiss', (_e, id: number, d: boolean) => dismissQuestion(id, d))
  ipcMain.handle('questions:consolidate', async () => {
    const free = mergeObviousDuplicates() // no AI needed for these
    try { const r = await consolidateQuestions(); return { ...r, merged: r.merged + free, note: '' } }
    catch (e) { return { merged: free, years: 0, analyzed: 0, note: (e as Error).message } } // the AI step needs a key; the free merges already happened
  })
  ipcMain.handle('questions:scan', () => scanPostings())
  ipcMain.handle('questions:suggest', () => suggestAnswers())
  ipcMain.handle('stories:list', () => listStories())
  ipcMain.handle('stories:save', (_e, s: { id?: number; title: string; body: string; tags: string }) => saveStory(s))
  ipcMain.handle('stories:remove', (_e, id: number) => removeStory(id))
  ipcMain.handle('essay:draft', (_e, draftId: number, field: string) => draftEssay(draftId, field))
  ipcMain.handle('apply:plan', (_e, id: number, overrides: Record<string, string>, remember: string[]) => buildPlan(id, overrides, remember))
  ipcMain.handle('apply:confirmSuggested', (_e, id: number, names: string[], overrides: Record<string, string>) => confirmSuggested(id, names, overrides))
  ipcMain.handle('apply:fill', (_e, id: number, overrides: Record<string, string>, approvals: Record<string, boolean>, allowCooldown: boolean, remember: string[]) =>
    fillForm(id, overrides, approvals, allowCooldown, remember ?? []))
  ipcMain.handle('apply:reverify', () => reverify())
  ipcMain.handle('apply:code', () => enterCodeFromEmail())
  ipcMain.handle('apply:accept', (_e, names: string[], save: string[]) => acceptChanges(names, save))
  ipcMain.handle('apply:submit', (_e, ack?: boolean) => submitForm(!!ack))
  ipcMain.handle('apply:check', () => checkConfirmation())
  ipcMain.handle('apply:close', () => closeSession())
  ipcMain.handle('applications:list', () => getDb().prepare(`SELECT a.id, j.company, j.title, j.url, a.attempt_status, a.submitted_at,
    a.confirmation_url, a.variant, a.response_status, a.notes FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.id DESC`).all() as ApplicationRow[])
  const hooks = {
    onPhase: (p: string) => win?.webContents.send('discovery:phase', p),
    onDone: () => win?.webContents.send('discovery:done'),
    onOpen: (tab?: string) => { showWindow(); win?.webContents.send('nav:tab', tab ?? 'Jobs') }
  }
  ipcMain.handle('boards:list', () => listBoards())
  ipcMain.handle('boards:add', (_e, url: string, source?: 'manual' | 'suggested') => addBoard(url, source))
  ipcMain.handle('email:account', () => getAccount())
  ipcMain.handle('email:connect', (_e, c: EmailConnect) => connectEmail(c))
  ipcMain.handle('email:outlook', (_e, clientId: string) => connectOutlook(clientId))
  ipcMain.handle('email:outlookCancel', () => cancelOutlook())
  ipcMain.handle('email:disconnect', (_e, purge: boolean) => disconnectEmail(purge))
  ipcMain.handle('email:options', (_e, o: { autoScan?: boolean; autoApply?: boolean; autoCode?: boolean }) => setEmailOptions(o))
  ipcMain.handle('email:scan', (_e, days: number | null) => scanEmail(days, () => { showWindow(); win?.webContents.send('nav:tab', 'Inbox') }))
  ipcMain.handle('email:events', () => ({ events: listEvents(), apps: appChoices() }))
  ipcMain.handle('email:assign', (_e, id: number, appId: number | null) => assignEmail(id, appId))
  ipcMain.handle('email:apply', (_e, id: number) => applyEmail(id))
  ipcMain.handle('email:undo', (_e, id: number) => undoEmail(id))
  ipcMain.handle('email:addPast', (_e, id: number) => addToPast(id))
  ipcMain.handle('brief:get', () => getBrief())
  ipcMain.handle('brief:set', (_e, t: string) => setBrief(t))
  ipcMain.handle('brief:propose', (_e, request: string | null) => proposeFromBrief(request))
  ipcMain.handle('brief:apply', (_e, sel: BriefSelection) => applyBrief(sel))
  ipcMain.handle('resume:hasUndo', () => hasResumeUndo())
  ipcMain.handle('resume:undoRewrite', () => undoResumeRewrite())
  ipcMain.handle('facts:revert', (_e, id: number) => revertFact(id))
  ipcMain.handle('setup:run', () => setupFromResume((p) => win?.webContents.send('setup:phase', p)))
  ipcMain.handle('search:get', () => getSearch())
  ipcMain.handle('search:set', (_e, s: Partial<SearchSettings>) => setSearch(s))
  ipcMain.handle('search:adzuna', (_e, id: string, key: string) => setAdzunaKey(id, key))
  ipcMain.handle('search:run', () => searchSites((p) => win?.webContents.send('setup:phase', p)))
  ipcMain.handle('boards:remove', (_e, id: number) => removeBoard(id))
  ipcMain.handle('boards:toggle', (_e, id: number, on: boolean) => toggleBoard(id, on))
  ipcMain.handle('criteria:get', () => getCriteria())
  ipcMain.handle('criteria:set', (_e, c: Criteria) => { const saved = setCriteria(c); resetAutoSkips(); applyHistoryToQueue(); return saved })
  ipcMain.handle('schedule:get', () => getSchedule())
  ipcMain.handle('schedule:set', (_e, s: Schedule) => setSchedule(s))
  ipcMain.handle('discovery:run', () => runNow('manual', hooks))
  ipcMain.handle('discovery:status', () => discoveryStatus())
  ipcMain.handle('jobs:list', (_e, f: 'active' | 'applied' | 'skipped' | 'all') => listJobs(f))
  ipcMain.handle('jobs:markApplied', (_e, id: number, date?: string) => markJobApplied(id, date))
  ipcMain.handle('jobs:unmarkApplied', (_e, id: number) => unmarkJobApplied(id))
  ipcMain.handle('jobs:skip', (_e, id: number, reason: string) => skipJob(id, reason))
  ipcMain.handle('jobs:restore', (_e, id: number) => restoreJob(id))
  ipcMain.handle('jobs:draft', (_e, id: number) => seedDraft(id))
  ipcMain.handle('jobs:recheck', () => recheckBlockers())
  ipcMain.handle('shell:open', (_e, url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url) })
  ipcMain.handle('approvals:list', () => pendingApprovals())
  ipcMain.handle('approvals:resolve', (_e, a: { kind: 'consent' | 'answer'; company: string; question: string; value: string }) => resolveApproval(a))
  ipcMain.handle('autopilot:status', () => autopilotStatus())
  ipcMain.handle('autopilot:set', (_e, s: AutopilotSettings) => { setAutopilot(s); return autopilotStatus() })
  ipcMain.handle('autopilot:run', async () => { const r = await runAutopilot('manual'); return { ...r, status: autopilotStatus() } })
  ipcMain.handle('autopilot:release', () => { releaseHolds(); return autopilotStatus() })
  startScheduler(hooks)

  ipcMain.handle('secret:set', (_e, v: string) => setSecret('anthropic', v))
  ipcMain.handle('secret:has', () => hasSecret('anthropic'))

  ipcMain.handle('browser:open', async (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Invalid URL')
    const ctx = await launchAutomationBrowser()
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(url)
  })

  createTray()
  createWindow()
  app.on('activate', showWindow)
})

// The app lives in the menu bar: closing the window never quits it.
app.on('window-all-closed', () => {})
