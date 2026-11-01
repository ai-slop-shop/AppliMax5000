import { companyKey } from './history'
import { getSetting, setSetting } from './settings'

/** A consent box the person has read and approved for one company, with the exact wording they saw. Never matches different wording. */
export interface ConsentApproval { company: string; label: string; value: string; at: string }

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
export const listConsents = (): ConsentApproval[] => JSON.parse(getSetting('consent_approvals') ?? '[]') as ConsentApproval[]

export function approveConsent(company: string, label: string, value: string): ConsentApproval[] {
  if (!company.trim() || !label.trim() || !value.trim()) throw new Error('Nothing to approve.')
  const rest = listConsents().filter((c) => !(companyKey(c.company) === companyKey(company) && norm(c.label) === norm(label)))
  setSetting('consent_approvals', JSON.stringify([...rest, { company: company.trim(), label: label.trim(), value: value.trim(), at: new Date().toISOString() }]))
  return listConsents()
}
export function revokeConsent(company: string, label: string): ConsentApproval[] {
  setSetting('consent_approvals', JSON.stringify(listConsents().filter((c) => !(companyKey(c.company) === companyKey(company) && norm(c.label) === norm(label)))))
  return listConsents()
}
export const consentFor = (company: string, label: string): string | null =>
  listConsents().find((c) => companyKey(c.company) === companyKey(company) && norm(c.label) === norm(label))?.value ?? null
