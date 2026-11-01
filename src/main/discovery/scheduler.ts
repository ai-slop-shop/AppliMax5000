import { Notification } from 'electron'
import type { DiscoveryStatus, RunSummary } from '../../shared/discovery'
import { digestDue } from '../experiments'
import { autoScanDue, scan as scanEmail } from '../email/service'
import { getCriteria, getSchedule } from './criteria'
import { getAutopilot, runAutopilot } from '../autopilot'
import { currentPhase, isRunning, lastRun, runDiscovery } from './run'

let timer: NodeJS.Timeout | null = null

export const status = (): DiscoveryStatus => ({ running: isRunning(), phase: currentPhase(), last: lastRun() })

interface Hooks { onPhase: (p: string) => void; onDone: (s: RunSummary) => void; onOpen: (tab?: string) => void }

/** Run now (manual) or when due (scheduled). Notifies when new strong matches appear. */
export async function runNow(trigger: string, hooks: Hooks): Promise<RunSummary> {
  hooks.onPhase('Starting')
  const s = await runDiscovery(trigger, hooks.onPhase)
  hooks.onPhase('')
  hooks.onDone(s)
  if (s.strong > 0 && Notification.isSupported()) {
    const n = new Notification({
      title: `${s.strong} new strong job match${s.strong > 1 ? 'es' : ''}`,
      body: `Fit ${getCriteria().notifyScore}+ . Open AppliMax5000 to review.`
    })
    n.on('click', () => hooks.onOpen())
    n.show()
  }
  return s
}

function due(): boolean {
  const sch = getSchedule()
  if (!sch.enabled || isRunning()) return false
  const last = lastRun()
  return !last || Date.now() - new Date(last.at.replace(' ', 'T') + 'Z').getTime() >= sch.intervalHours * 3_600_000
}

/** The app lives in the menu bar, so a simple in-process timer is enough. Checks every 10 minutes and shortly after launch. */
export function startScheduler(hooks: Hooks): void {
  const tick = (): void => {
    if (due()) runNow('schedule', hooks).then(() => (getAutopilot().enabled ? runAutopilot('scheduled run') : undefined)).catch(() => {})
    if (autoScanDue()) scanEmail(null, () => hooks.onOpen('Inbox')).catch(() => {}) // quiet failures: the Inbox tab shows errors on a manual scan
    const d = digestDue() // at most once a week, only when there is news
    if (d && Notification.isSupported()) {
      const n = new Notification({ title: 'Your weekly job search digest', body: d.lines.join('\n') })
      n.on('click', () => hooks.onOpen())
      n.show()
    }
  }
  setTimeout(tick, 45_000)
  timer = setInterval(tick, 10 * 60_000)
}
export function stopScheduler(): void { if (timer) clearInterval(timer) }
