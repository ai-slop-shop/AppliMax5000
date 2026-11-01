export type Outcome = 'no_response' | 'screen' | 'interview' | 'rejection' | 'offer'
export const OUTCOMES: Outcome[] = ['no_response', 'screen', 'interview', 'rejection', 'offer']

export interface ExperimentSettings { enabled: boolean; controlShare: number } // controlShare 0..1
export interface Arm { variant: 'tailored' | 'control'; n: number; positive: number; interviews: number; rejected: number; rate: number; lo: number; hi: number }
export interface Breakdown { key: string; tailored: Arm; control: Arm }
export interface ExperimentStats {
  settings: ExperimentSettings
  arms: { tailored: Arm; control: Arm }
  verdict: string
  breakdowns: { ats: Breakdown[]; fit: Breakdown[]; role: Breakdown[] }
  excluded: number
}
export interface Digest { since: string; discovered: number; strong: number; submitted: number; responses: number; pending: number; lines: string[] }
