import type { Browser } from 'playwright-core'

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'

const which = (bin: string) => {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}
const chrome = process.env.CHROME_PATH ?? which('google-chrome-stable')
const builds = process.env.PLAYWRIGHT_BROWSERS_PATH
const firefoxBuild = builds && existsSync(builds) ? readdirSync(builds).find(name => name.startsWith('firefox-')) : undefined
const firefoxPath = process.env.FIREFOX_PATH ?? (firefoxBuild && join(builds!, firefoxBuild, 'firefox', 'firefox'))
// WebKit through Playwright's own run-server (`playwright run-server` in its Docker image, the same version as here)
const webkitServer = process.env.PW_WEBKIT_WS

/** Each engine a suite can drive, headless and muted, with no launcher where this machine has no such browser. */
export const engines: [string, (() => Promise<Browser>) | undefined][] = [
  ['Chromium', chrome ? () => chromium.launch({ executablePath: chrome, args: ['--mute-audio'] }) : undefined],
  ['Firefox', firefoxPath ? () => firefox.launch({ executablePath: firefoxPath, firefoxUserPrefs: { 'media.volume_scale': '0.0' } }) : undefined],
  ['WebKit', webkitServer ? () => webkit.connect(webkitServer) : undefined],
]
