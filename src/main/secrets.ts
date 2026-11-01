import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

// Keys are encrypted with the OS keychain via safeStorage and never sent to the renderer.
const file = (name: string): string => join(app.getPath('userData'), `${name}.secret`)

export async function setSecret(name: string, value: string): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('OS encryption unavailable')
  writeFileSync(file(name), await safeStorage.encryptStringAsync(value))
}
export async function getSecret(name: string): Promise<string | null> {
  if (!existsSync(file(name))) return null
  return (await safeStorage.decryptStringAsync(readFileSync(file(name)))).result
}
export const hasSecret = (name: string): boolean => existsSync(file(name))
export function deleteSecret(name: string): void { if (existsSync(file(name))) unlinkSync(file(name)) }
