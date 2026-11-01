import { useEffect, useState } from 'react'
import type { WorkMode } from '../../shared/discovery'

export const MODES: WorkMode[] = ['remote', 'hybrid', 'onsite']
export const list = (s: string): string[] => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
/** A comma-separated list field. Shows exactly what is typed (spaces included) and reports the parsed list upward. */
export function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '))
  // Only adopt outside changes (e.g. "Set up for me" filling the field), never our own parsed echo.
  useEffect(() => { if (JSON.stringify(list(text)) !== JSON.stringify(value)) setText(value.join(', ')) }, [value])
  return <input value={text} placeholder={placeholder} onChange={(e) => { setText(e.target.value); onChange(list(e.target.value)) }} />
}
export const clean = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

