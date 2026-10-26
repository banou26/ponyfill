import type { Browser, Frame } from 'playwright-core'

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import { transformWithOxc } from 'vite-plus'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { postMessage } from '../src/web-messaging'

const fakeWindow = () => {
  const calls: unknown[][] = []
  const target = {
    postMessage(...args: unknown[]) {
      calls.push([this, ...args])
      return 'what the platform returned'
    },
  }
  return { target: target as unknown as Window, calls }
}

describe('postMessage', () => {
  it('hands the window exactly what it was given, under either overload', () => {
    const { target, calls } = fakeWindow()
    const port = {} as Transferable
    postMessage(target, 'a', 'https://a.test')
    postMessage(target, 'b', 'https://a.test', [port])
    postMessage(target, 'c', { targetOrigin: '*' })
    postMessage(target, 'd')
    expect(calls).toEqual([[target, 'a', 'https://a.test'], [target, 'b', 'https://a.test', [port]], [target, 'c', { targetOrigin: '*' }], [target, 'd']])
  })

  // node runs no tail calls, so this is where one shows here: a call whose value is returned is in tail position
  it('returns nothing, even where the platform returns something', () => {
    expect(postMessage(fakeWindow().target, 'a', '*')).toBeUndefined()
  })

  it('compiles exactly the calls the platform does, with exactOptionalPropertyTypes off and on', () => {
    const root = join(import.meta.dirname, '..')
    for (const exact of ['false', 'true']) {
      const tsc = spawnSync(join(root, 'node_modules', '.bin', 'tsc'), [
        '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'esnext', '--module', 'esnext',
        '--moduleResolution', 'bundler', '--lib', 'esnext,dom', '--exactOptionalPropertyTypes', exact,
        join(root, 'tests', 'web-messaging.types.ts'),
      ], { encoding: 'utf8' })
      expect(tsc.stdout + tsc.stderr, `exactOptionalPropertyTypes ${exact}`).toBe('')
      expect(tsc.status).toBe(0)
    }
  })
})

const ORIGIN = 'https://rig.test'
// one document on each side: the page frames #other, and each sends to the other and logs whose source it read
const RIG = `
import { postMessage } from '/web-messaging.js'
const other = () => window === parent ? document.getElementById('other').contentWindow : parent
window.log = []
addEventListener('message', e => log.push(e.data + ' ' + (e.source === other() ? 'sender' : e.source === window ? 'receiver' : 'neither')))
const calls = {
  native: (target, tag) => () => target.postMessage(tag, '*'),
  ponyfill: (target, tag) => () => postMessage(target, tag, '*'),
  options: (target, tag) => () => postMessage(target, tag, { targetOrigin: '*' }),
}
const triggers = {
  timeout: fn => setTimeout(fn),
  load: fn => { const frame = document.createElement('iframe'); frame.src = '/blank.html'; frame.addEventListener('load', fn, { once: true }); document.body.append(frame) },
}
window.send = (call, trigger, tag) => triggers[trigger](calls[call](other(), tag))
`
const PAGES: Record<string, string> = {
  '/': '<!doctype html><iframe id="other" src="/frame.html"></iframe><script type="module" src="/rig.js"></script>',
  '/frame.html': '<!doctype html><script type="module" src="/rig.js"></script>',
  '/blank.html': '<!doctype html>',
}

type Rig = { send: (call: string, trigger: string, tag: string) => void, log: string[] }

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

const engines: [string, (() => Promise<Browser>) | undefined][] = [
  ['Chromium', chrome ? () => chromium.launch({ executablePath: chrome, args: ['--mute-audio'] }) : undefined],
  ['Firefox', firefoxPath ? () => firefox.launch({ executablePath: firefoxPath, firefoxUserPrefs: { 'media.volume_scale': '0.0' } }) : undefined],
  ['WebKit', webkitServer ? () => webkit.connect(webkitServer) : undefined],
]

for (const [engine, launch] of engines) {
  describe.skipIf(!launch)(`postMessage in ${engine}`, () => {
    let browser: Browser
    let page: Frame
    let frame: Frame

    beforeAll(async () => {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', 'web-messaging.ts'), 'utf8')
      const { code } = await transformWithOxc(source, 'web-messaging.ts')
      browser = await launch!()
      const tab = await browser.newPage()
      await tab.route('**/*', route => {
        const { origin, pathname } = new URL(route.request().url())
        if (origin !== ORIGIN) return route.abort()
        if (pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: pathname === '/rig.js' ? RIG : code })
        return route.fulfill({ contentType: 'text/html', body: PAGES[pathname] ?? '' })
      })
      await tab.goto(`${ORIGIN}/`)
      page = tab.mainFrame()
      await page.waitForFunction(() => 'send' in window)
      frame = page.childFrames()[0]!
      await frame.waitForFunction(() => 'send' in window)
    }, 60_000)

    afterAll(async () => { await browser?.close() })

    const sourceSeen = async (call: string, trigger: string, from: 'page' | 'frame') => {
      const tag = `${call} ${trigger} ${from}`
      const [sender, receiver] = from === 'page' ? [page, frame] : [frame, page]
      await sender.evaluate(([c, t, g]) => (window as unknown as Rig).send(c!, t!, g!), [call, trigger, tag])
      const seen = await receiver.waitForFunction(g => (window as unknown as Rig).log.find(line => line.startsWith(`${g} `)), tag)
      return (await seen.jsonValue() as string).slice(tag.length + 1)
    }

    it('carries the sender as the source when called last from a callback the browser makes', async () => {
      for (const call of ['ponyfill', 'options']) {
        for (const trigger of ['timeout', 'load']) {
          for (const from of ['page', 'frame'] as const) {
            expect(await sourceSeen(call, trigger, from), `${call} from ${trigger}, ${from} to the other`).toBe('sender')
          }
        }
      }
    }, 60_000)

    // the control: the native call in the same position, so a WebKit that stops dropping the sender shows here
    it(`the native call in that position: ${engine === 'WebKit' ? 'the receiver\'s own window' : 'the sender'}`, async () => {
      for (const trigger of ['timeout', 'load']) {
        for (const from of ['page', 'frame'] as const) {
          expect(await sourceSeen('native', trigger, from), `native from ${trigger}, ${from} to the other`).toBe(engine === 'WebKit' ? 'receiver' : 'sender')
        }
      }
    }, 60_000)
  })
}
