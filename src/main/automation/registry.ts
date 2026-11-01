import type { AtsAdapter } from './adapter'
import { ashby } from './ashby'
import { greenhouse } from './greenhouse'
import { lever } from './lever'

export const ADAPTERS: AtsAdapter[] = [greenhouse, lever, ashby]
export const adapterFor = (url: string): AtsAdapter | null => ADAPTERS.find((a) => a.detect(url)) ?? null
export const adapterByName = (name: string | null): AtsAdapter | null => ADAPTERS.find((a) => a.name === name) ?? null
