import type { Criteria, Schedule } from '../../shared/discovery'
import { getSetting, setSetting } from '../settings'
import { loadResume } from '../resumeStore'

export function getCriteria(): Criteria {
  const saved = getSetting('criteria')
  const c = saved ? JSON.parse(saved) as Partial<Criteria> : {}
  const contact = loadResume().contact
  return {
    payFloor: 0, workModes: ['remote', 'hybrid'], city: contact.city, state: contact.state, nearby: [],
    targetTitles: [], excludeTitles: [], excludeCompanies: [], includeCompanies: [], maxAgeDays: 60, minTriage: 40, notifyScore: 70, maxScorePerRun: 25,
    ...c
  }
}
export const setCriteria = (c: Criteria): Criteria => { setSetting('criteria', JSON.stringify(c)); return getCriteria() }

export const getSchedule = (): Schedule => ({ enabled: false, intervalHours: 6, ...(JSON.parse(getSetting('schedule') ?? '{}') as Partial<Schedule>) })
export const setSchedule = (s: Schedule): Schedule => {
  setSetting('schedule', JSON.stringify({ enabled: !!s.enabled, intervalHours: Math.max(1, Math.min(72, Math.round(s.intervalHours) || 6)) }))
  return getSchedule()
}
