import { app } from 'electron'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'

/** Launch a dedicated, persistent Chromium profile (separate from the user's browser). */
export async function launchAutomationBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(join(app.getPath('userData'), 'browser-profile'), {
    headless: false
  })
}
