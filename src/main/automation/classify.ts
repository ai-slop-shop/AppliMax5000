import type { FieldKind, FormField, Sensitivity } from '../../shared/apply'

const RE = {
  consent: /agree|arbitrat|consent|\bnda\b|non-?disclosure|acknowledg|polic(y|ies)|certif/i,
  demographic: /sexual orientation|gender|transgender|disabilit|\brace\b|ethnic|hispanic|latino|veteran|pronoun/i,
  legal: /sponsor|authori[sz]ed|work authori|visa|legally|right to work|years.*manag|manag.*years/i,
  pay: /salary|compensation|\bpay\b|expected|desired/i
}

/** Which questions need extra care. Shared by every ATS adapter. */
export function classify(label: string, kind: FieldKind, required: boolean, section: FormField['section'], core: boolean): Sensitivity {
  if ((kind === 'select' || kind === 'multiselect') && RE.consent.test(label)) return 'consent'
  if (section === 'eeoc' || RE.demographic.test(label)) return 'demographic'
  if (RE.legal.test(label)) return 'legal'
  if (RE.pay.test(label)) return 'pay'
  if (kind === 'textarea' && required && !core) return 'essay'
  return 'none'
}
