import type { Browser, JSHandle } from 'playwright-core'

import { join } from 'node:path'
import { build } from 'vite-plus'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'

import { exitFullscreen, fullscreenElement, fullscreenEnabled, requestFullscreen } from '../src/fullscreen'
import { engines } from './engines'

afterEach(() => { vi.unstubAllGlobals() })

type FakeDocument = Document & {
  fullscreenEnabled: boolean
  fullscreenElement: Element | null
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  exitFullscreen?: () => Promise<void>
  webkitExitFullscreen?: () => Promise<void>
}

const makeDoc = (overrides: Partial<FakeDocument> = {}): FakeDocument => ({
  fullscreenEnabled: false,
  fullscreenElement: null,
  querySelectorAll: () => [] as unknown as NodeListOf<Element>,
  ...overrides,
}) as FakeDocument

describe('requestFullscreen and exitFullscreen', () => {
  it('forwards options to element.requestFullscreen when document fullscreen is enabled', async () => {
    const calls: unknown[][] = []
    const doc = makeDoc({ fullscreenEnabled: true })
    const el = {
      ownerDocument: doc,
      requestFullscreen(options?: FullscreenOptions) {
        calls.push([this, options])
        return Promise.resolve()
      },
    } as unknown as HTMLElement

    await requestFullscreen(el, { navigationUI: 'hide' })
    expect(calls).toEqual([[el, { navigationUI: 'hide' }]])
  })

  it('falls back to webkitRequestFullscreen when unprefixed requestFullscreen is absent', async () => {
    const calls: unknown[] = []
    const doc = makeDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: true })
    const el = {
      ownerDocument: doc,
      webkitRequestFullscreen() {
        calls.push(this)
        return Promise.resolve()
      },
    } as unknown as HTMLElement

    await requestFullscreen(el)
    expect(calls).toEqual([el])
  })

  it('calls video.webkitEnterFullscreen synchronously when document fullscreen is disabled (iPhone Safari)', async () => {
    const doc = makeDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: false })
    const calls: unknown[] = []
    let displaying = false
    const video = {
      ownerDocument: doc,
      get webkitDisplayingFullscreen() { return displaying },
      webkitEnterFullscreen() {
        if (this !== video) throw new TypeError('Illegal invocation')
        calls.push(['enter', this])
        displaying = true
      },
      webkitExitFullscreen() {
        if (this !== video) throw new TypeError('Illegal invocation')
        calls.push(['exit', this])
        displaying = false
      },
    } as unknown as HTMLVideoElement
    ;(doc as unknown as { querySelectorAll: () => unknown[] }).querySelectorAll = () => [video]
    doc.exitFullscreen = () => Promise.reject(new TypeError('Document not active'))

    // Do not await yet: assert webkitEnterFullscreen fired synchronously before any microtask.
    const entering = requestFullscreen(video)
    expect(calls).toEqual([['enter', video]])
    await entering

    // exitFullscreen must exit the video directly rather than letting doc.exitFullscreen reject.
    await exitFullscreen(doc)
    expect(calls).toEqual([['enter', video], ['exit', video]])
  })

  it('uses legacy uppercase webkitEnterFullScreen and webkitExitFullScreen when lowercase aliases are absent', async () => {
    const doc = makeDoc({ fullscreenEnabled: false })
    const calls: string[] = []
    let displaying = false
    const video = {
      ownerDocument: doc,
      get webkitDisplayingFullscreen() { return displaying },
      webkitEnterFullScreen() { calls.push('Enter'); displaying = true },
      webkitExitFullScreen() { calls.push('Exit'); displaying = false },
    } as unknown as HTMLVideoElement

    await requestFullscreen(video)
    await exitFullscreen(doc)
    expect(calls).toEqual(['Enter', 'Exit'])
  })

  it('finds a tracked WebKit fullscreen video inside shadow DOM when querySelectorAll sees nothing', async () => {
    const doc = makeDoc({ fullscreenEnabled: false, querySelectorAll: () => [] as unknown as NodeListOf<Element> })
    let displaying = false
    let exited = false
    const shadowVideo = {
      ownerDocument: doc,
      get webkitDisplayingFullscreen() { return displaying },
      webkitEnterFullscreen() { displaying = true },
      webkitExitFullscreen() { exited = true; displaying = false },
    } as unknown as HTMLVideoElement

    await requestFullscreen(shadowVideo)
    await exitFullscreen(doc)
    expect(exited).toBe(true)
  })

  it('uses webkitSetPresentationMode when fullscreen mode is supported and falls back when unsupported', async () => {
    const doc = makeDoc({ fullscreenEnabled: false })
    const calls: string[] = []
    let mode: 'inline' | 'fullscreen' = 'inline'
    const supportedVideo = {
      ownerDocument: doc,
      get webkitPresentationMode() { return mode },
      webkitSupportsPresentationMode: (m: string) => m === 'fullscreen',
      webkitSetPresentationMode(next: 'inline' | 'fullscreen') {
        calls.push(next)
        mode = next
      },
      webkitEnterFullscreen() { calls.push('enterFullscreen') },
    } as unknown as HTMLVideoElement

    await requestFullscreen(supportedVideo)
    expect(calls).toEqual(['fullscreen'])
    await exitFullscreen(doc)
    expect(calls).toEqual(['fullscreen', 'inline'])

    const fallbackCalls: string[] = []
    const unsupportedVideo = {
      ownerDocument: doc,
      webkitPresentationMode: 'inline',
      webkitSupportsPresentationMode: () => false,
      webkitSetPresentationMode(next: string) { fallbackCalls.push(`pres:${next}`) },
      webkitEnterFullscreen() { fallbackCalls.push('enterFullscreen') },
    } as unknown as HTMLVideoElement

    await requestFullscreen(unsupportedVideo)
    expect(fallbackCalls).toEqual(['enterFullscreen'])
  })

  it('falls back to video native fullscreen when element.requestFullscreen rejects on a video', async () => {
    const doc = makeDoc({ fullscreenEnabled: true })
    const calls: string[] = []
    const video = {
      ownerDocument: doc,
      requestFullscreen() { return Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      webkitEnterFullscreen() { calls.push('fallback') },
    } as unknown as HTMLVideoElement

    await requestFullscreen(video)
    expect(calls).toEqual(['fallback'])
  })

  it('rejects non-video elements loudly with NotSupportedError when document fullscreen is disabled', async () => {
    const doc = makeDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: false })
    const div = { ownerDocument: doc } as unknown as HTMLElement

    await expect(requestFullscreen(div)).rejects.toMatchObject({ name: 'NotSupportedError' })
  })

  it('converts a synchronous InvalidStateError from webkitEnterFullscreen into a rejected promise', async () => {
    const doc = makeDoc({ fullscreenEnabled: false })
    const video = {
      ownerDocument: doc,
      webkitEnterFullscreen() {
        throw new DOMException('InvalidStateError', 'InvalidStateError')
      },
    } as unknown as HTMLVideoElement

    await expect(requestFullscreen(video)).rejects.toMatchObject({ name: 'InvalidStateError' })
  })

  it('prefers doc.exitFullscreen while a container fullscreen element is active', async () => {
    const container = {} as Element
    const calls: string[] = []
    const doc = makeDoc({
      fullscreenElement: container,
      exitFullscreen: () => { calls.push('doc'); return Promise.resolve() },
    })

    await exitFullscreen(doc)
    expect(calls).toEqual(['doc'])
  })

  it('prefers doc.exitFullscreen over webkitSetPresentationMode when fullscreenElement is set on a video', async () => {
    const calls: string[] = []
    const video = {
      webkitPresentationMode: 'fullscreen',
      webkitSetPresentationMode: (mode: string) => { calls.push(`pres:${mode}`) },
    } as unknown as HTMLVideoElement
    const doc = makeDoc({
      fullscreenElement: video,
      querySelectorAll: () => [video] as unknown as NodeListOf<Element>,
      exitFullscreen: () => { calls.push('doc'); return Promise.resolve() },
    })

    await exitFullscreen(doc)
    expect(calls).toEqual(['doc'])
  })

  it('reports fullscreenEnabled accurately for restricted iframes and WebKit video elements', () => {
    const disabledDoc = makeDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: false })
    const restrictedVideo = {
      requestFullscreen: () => Promise.resolve(),
    } as unknown as HTMLVideoElement
    expect(fullscreenEnabled(disabledDoc, restrictedVideo)).toBe(false)
    expect(fullscreenEnabled(disabledDoc, null)).toBe(false)
    expect(fullscreenEnabled(disabledDoc, {} as unknown as Element)).toBe(false)

    const preMetadataWebKitVideo = {
      readyState: 0,
      webkitSupportsFullscreen: false,
      webkitEnterFullscreen: () => {},
    } as unknown as HTMLVideoElement
    expect(fullscreenEnabled(disabledDoc, preMetadataWebKitVideo)).toBe(true)

    const unsupportedLoadedVideo = {
      readyState: 1,
      webkitSupportsFullscreen: false,
      webkitEnterFullscreen: () => {},
    } as unknown as HTMLVideoElement
    expect(fullscreenEnabled(disabledDoc, unsupportedLoadedVideo)).toBe(false)

    const presentationVideo = {
      webkitPresentationMode: 'inline',
      webkitSupportsPresentationMode: (m: string) => m === 'fullscreen',
      webkitSetPresentationMode: () => {},
    } as unknown as HTMLVideoElement
    expect(fullscreenEnabled(disabledDoc, presentationVideo)).toBe(true)

    const presentationUnsupportedVideo = {
      webkitPresentationMode: 'inline',
      webkitSupportsPresentationMode: () => false,
      webkitSetPresentationMode: () => {},
    } as unknown as HTMLVideoElement
    expect(fullscreenEnabled(disabledDoc, presentationUnsupportedVideo)).toBe(false)

    const enabledDoc = makeDoc({ fullscreenEnabled: true })
    expect(fullscreenEnabled(enabledDoc, null)).toBe(true)
  })

  it('finds and exits an untracked shadow-DOM fallbackElement in fullscreenElement and exitFullscreen', async () => {
    const container = {} as Element
    const shadowVideo = {
      webkitDisplayingFullscreen: true,
      webkitExitFullscreen: vi.fn(),
    } as unknown as HTMLVideoElement
    const activeDoc = makeDoc({ fullscreenElement: container })
    expect(fullscreenElement(activeDoc, shadowVideo)).toBe(container)

    const disabledDoc = makeDoc({ fullscreenEnabled: false })
    expect(fullscreenElement(disabledDoc, shadowVideo)).toBe(shadowVideo)
    await exitFullscreen(disabledDoc, shadowVideo)
    expect((shadowVideo as unknown as { webkitExitFullscreen: ReturnType<typeof vi.fn> }).webkitExitFullscreen).toHaveBeenCalledTimes(1)

    const throwingVideo = {
      webkitPresentationMode: 'fullscreen',
      webkitDisplayingFullscreen: true,
      webkitSetPresentationMode: () => { throw new Error('presentation exit failed') },
      webkitExitFullscreen: vi.fn(),
    } as unknown as HTMLVideoElement
    await exitFullscreen(disabledDoc, throwingVideo)
    expect((throwingVideo as unknown as { webkitExitFullscreen: ReturnType<typeof vi.fn> }).webkitExitFullscreen).toHaveBeenCalledTimes(1)
  })
})

const built = build({
  root: join(import.meta.dirname, '..'),
  logLevel: 'silent',
  build: { write: false },
}).then(outputs => {
  const files = [outputs].flat().flatMap(output => 'output' in output ? output.output : [])
  const file = files.find(entry => entry.fileName === 'fullscreen.js')
  if (file?.type !== 'chunk') throw new Error('the build made no fullscreen.js')
  return file.code
})

const ORIGIN = 'https://rig.test'
type Module = {
  requestFullscreen: typeof requestFullscreen
  exitFullscreen: typeof exitFullscreen
}

for (const [engine, launch] of engines) {
  describe.skipIf(!launch)(`fullscreen in ${engine}`, () => {
    let browser: Browser
    let code: string

    beforeAll(async () => {
      code = await built
      browser = await launch!()
    }, 60_000)

    afterAll(async () => { await browser?.close() })

    it('requests and exits fullscreen on a container element from a user click', async () => {
      const page = await browser.newPage()
      try {
        await page.route('**/*', route => {
          const { origin, pathname } = new URL(route.request().url())
          if (origin !== ORIGIN) return route.abort()
          if (pathname === '/fullscreen.js') return route.fulfill({ contentType: 'text/javascript', body: code })
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><div id="box"><button id="go">go</button></div>',
          })
        })
        await page.goto(`${ORIGIN}/`)
        const mod = await page.evaluateHandle('import(\'/fullscreen.js\')') as JSHandle<Module>
        await page.evaluate(({ requestFullscreen: req, exitFullscreen: exit }) => {
          const box = document.getElementById('box')!
          const button = document.getElementById('go')!
          const state = { active: null as Element | null, error: '' }
          ;(window as unknown as { __fsState: typeof state, __exitFs: () => Promise<void> }).__fsState = state
          ;(window as unknown as { __exitFs: () => Promise<void> }).__exitFs = () => exit(document)
          button.addEventListener('click', () => {
            void req(box).then(
              () => { state.active = document.fullscreenElement },
              (err) => { state.error = (err as Error).message },
            )
          })
        }, mod)

        await page.click('#go')
        await page.waitForFunction(() => {
          const state = (window as unknown as { __fsState: { active: Element | null, error: string } }).__fsState
          return state.active !== null || state.error !== ''
        })
        const entered = await page.evaluate(() => {
          const state = (window as unknown as { __fsState: { active: Element | null, error: string } }).__fsState
          return { isBox: state.active === document.getElementById('box'), error: state.error }
        })
        expect(entered).toEqual({ isBox: true, error: '' })

        await page.evaluate(() => (window as unknown as { __exitFs: () => Promise<void> }).__exitFs())
        expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
      } finally {
        await page.close()
      }
    }, 60_000)

    it.skipIf(engine !== 'WebKit')('falls back cleanly on a real WebKit video when Element.requestFullscreen is absent', async () => {
      const page = await browser.newPage()
      try {
        await page.route('**/*', route => {
          const { origin, pathname } = new URL(route.request().url())
          if (origin !== ORIGIN) return route.abort()
          if (pathname === '/fullscreen.js') return route.fulfill({ contentType: 'text/javascript', body: code })
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html><video playsinline muted></video><div></div>' })
        })
        await page.goto(`${ORIGIN}/`)
        const mod = await page.evaluateHandle('import(\'/fullscreen.js\')') as JSHandle<Module>
        const seen = await page.evaluate(async ({ requestFullscreen: req, exitFullscreen: exit }) => {
          Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true })
          Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false, configurable: true })
          delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen
          delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen

          const div = document.querySelector('div')!
          let divError = ''
          try { await req(div) } catch (err) { divError = (err as Error).name }

          type WebKitVideo = HTMLVideoElement & {
            webkitEnterFullscreen: () => void
            webkitExitFullscreen: () => void
          }
          const video = document.querySelector('video')! as WebKitVideo
          const origEnter = video.webkitEnterFullscreen
          let enterCalls = 0
          let exitCalls = 0
          let displaying = false
          video.webkitEnterFullscreen = function () {
            enterCalls++
            displaying = true
            try { origEnter.call(this) } catch (err) {
              // Expect InvalidStateError on an empty <video>; assert real WebKit method ran synchronously.
              if ((err as Error).name !== 'InvalidStateError') throw err
            }
          }
          Object.defineProperty(video, 'webkitDisplayingFullscreen', { get: () => displaying, configurable: true })
          video.webkitExitFullscreen = function () {
            exitCalls++
            displaying = false
          }

          await req(video)
          await exit(document)
          return { divError, enterCalls, exitCalls, displaying }
        }, mod)

        expect(seen).toEqual({
          divError: 'NotSupportedError',
          enterCalls: 1,
          exitCalls: 1,
          displaying: false,
        })
      } finally {
        await page.close()
      }
    }, 60_000)
  })
}
