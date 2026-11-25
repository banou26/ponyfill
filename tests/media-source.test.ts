import type { Browser, JSHandle } from 'playwright-core'

import { join } from 'node:path'
import { compileFunction } from 'node:vm'
import { build } from 'vite-plus'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'

import { MediaSource as RootMediaSource } from '../src/index'
import { MediaSource as EntryMediaSource } from '../src/media-source'
import { engines } from './engines'

afterEach(() => { vi.unstubAllGlobals() })

const bundle = async (minify: boolean) => {
  const outputs = await build({ root: join(import.meta.dirname, '..'), logLevel: 'silent', build: { write: false, minify } })
  const files = [outputs].flat().flatMap(output => 'output' in output ? output.output : [])
  const code = (fileName: string) => {
    const file = files.find(file => file.fileName === fileName)
    if (file?.type !== 'chunk') throw new Error(`the build made no ${fileName}`)
    return file.code
  }
  return { es: code('media-source.js'), cjs: code('media-source.cjs') }
}

const built = bundle(false)

type Module = { MediaSource: typeof globalThis.MediaSource }

const thrownBy = (run: () => unknown) => {
  try { run() } catch (error) { return error }
  throw new Error('expected a throw, and the call returned')
}

describe('MediaSource over platform globals', () => {
  it('prefers native MediaSource when both MediaSource and ManagedMediaSource exist', () => {
    const calls: string[] = []
    class NativeMediaSource {
      static canConstructInDedicatedWorker = true
      static isTypeSupported(mime: string) {
        calls.push(`ms:${mime}`)
        return this === NativeMediaSource && mime === 'video/mp4'
      }
    }
    class NativeManagedMediaSource {
      static isTypeSupported(mime: string) {
        calls.push(`mms:${mime}`)
        return true
      }
    }
    vi.stubGlobal('MediaSource', NativeMediaSource)
    vi.stubGlobal('ManagedMediaSource', NativeManagedMediaSource)

    expect(RootMediaSource).toBe(EntryMediaSource)
    expect(EntryMediaSource.name).toBe('MediaSource')
    expect(EntryMediaSource.canConstructInDedicatedWorker).toBe(true)
    expect(EntryMediaSource.isTypeSupported('video/mp4')).toBe(true)
    expect(EntryMediaSource.isTypeSupported('video/webm')).toBe(false)
    expect(calls).toEqual(['ms:video/mp4', 'ms:video/webm'])

    const instance: EntryMediaSource = new EntryMediaSource()
    expect(instance).toBeInstanceOf(NativeMediaSource)
    expect(instance).toBeInstanceOf(EntryMediaSource)
    expect(instance).not.toBeInstanceOf(NativeManagedMediaSource)
  })

  it('falls back to ManagedMediaSource when MediaSource is absent (iPhone shape)', () => {
    const calls: unknown[] = []
    class NativeManagedMediaSource {
      streaming = true
      static isTypeSupported(mime: string) {
        calls.push([this, mime])
        return this === NativeManagedMediaSource && mime.includes('avc1')
      }
    }
    vi.stubGlobal('MediaSource', undefined)
    vi.stubGlobal('ManagedMediaSource', NativeManagedMediaSource)

    expect(EntryMediaSource.canConstructInDedicatedWorker).toBe(false)
    expect(EntryMediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f"')).toBe(true)
    expect(calls).toEqual([[NativeManagedMediaSource, 'video/mp4; codecs="avc1.64001f"']])

    const instance: EntryMediaSource = new EntryMediaSource()
    expect(instance).toBeInstanceOf(NativeManagedMediaSource)
    expect(instance).toBeInstanceOf(EntryMediaSource)
  })

  it('reads globals dynamically after import so test stubs and codec filters apply', () => {
    vi.stubGlobal('MediaSource', { isTypeSupported: (mime: string) => mime === 'stubbed/mime' })
    vi.stubGlobal('ManagedMediaSource', undefined)

    expect(EntryMediaSource.isTypeSupported('stubbed/mime')).toBe(true)
    expect(EntryMediaSource.isTypeSupported('other/mime')).toBe(false)
    expect({} instanceof EntryMediaSource).toBe(false)
    const error = thrownBy(() => new EntryMediaSource())
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('NotSupportedError')
  })

  it('degrades cleanly when neither MediaSource nor ManagedMediaSource exists', () => {
    vi.stubGlobal('MediaSource', undefined)
    vi.stubGlobal('ManagedMediaSource', undefined)

    expect(EntryMediaSource.canConstructInDedicatedWorker).toBe(false)
    expect(EntryMediaSource.isTypeSupported('video/mp4')).toBe(false)
    expect({} instanceof EntryMediaSource).toBe(false)
    const error = thrownBy(() => new EntryMediaSource())
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('NotSupportedError')
  })

  it('keeps the MediaSource name when minified', async () => {
    const exports = {} as Module
    compileFunction((await bundle(true)).cjs, ['exports'])(exports)
    expect(Object.getOwnPropertyDescriptor(exports.MediaSource, 'name')).toEqual({
      value: 'MediaSource',
      writable: false,
      enumerable: false,
      configurable: true,
    })
  }, 60_000)

  it('writes nothing to globals', () => {
    class NativeMediaSource {
      static isTypeSupported() { return true }
    }
    vi.stubGlobal('MediaSource', NativeMediaSource)
    const before = Object.getOwnPropertyNames(globalThis)
    new EntryMediaSource()
    expect(Object.getOwnPropertyNames(globalThis)).toEqual(before)
    expect(globalThis.MediaSource).toBe(NativeMediaSource)
  })
})

const ORIGIN = 'https://rig.test'

for (const [engine, launch] of engines) {
  describe.skipIf(!launch)(`MediaSource in ${engine}`, () => {
    let browser: Browser
    let code: string

    beforeAll(async () => {
      code = (await built).es
      browser = await launch!()
    }, 60_000)

    afterAll(async () => { await browser?.close() })

    const withPage = async <T>(run: (page: Awaited<ReturnType<Browser['newPage']>>, module: () => Promise<JSHandle<Module>>) => Promise<T>) => {
      const page = await browser.newPage()
      try {
        await page.route('**/*', route => {
          const { origin, pathname } = new URL(route.request().url())
          if (origin !== ORIGIN) return route.abort()
          if (pathname === '/media-source.js') return route.fulfill({ contentType: 'text/javascript', body: code })
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html><video playsinline muted></video>' })
        })
        await page.goto(`${ORIGIN}/`)
        return await run(page, () => page.evaluateHandle('import(\'/media-source.js\')') as Promise<JSHandle<Module>>)
      } finally {
        await page.close()
      }
    }

    it('constructs the native MediaSource and opens sourceopen', async () => {
      const seen = await withPage(async (page, module) => page.evaluate(async ({ MediaSource: Ponyfill }) => {
        const ms = new Ponyfill()
        const video = document.createElement('video')
        const state = await new Promise<string>((resolve) => {
          const timeout = setTimeout(() => resolve('timeout'), 3_000)
          ms.addEventListener('sourceopen', () => { clearTimeout(timeout); resolve(ms.readyState) }, { once: true })
          video.src = URL.createObjectURL(ms)
        })
        return {
          name: Ponyfill.name,
          isInstanceOfNative: ms instanceof MediaSource,
          isInstanceOfPonyfill: ms instanceof Ponyfill,
          state,
        }
      }, await module()))
      expect(seen).toEqual({
        name: 'MediaSource',
        isInstanceOfNative: true,
        isInstanceOfPonyfill: true,
        state: 'open',
      })
    }, 60_000)

    it.skipIf(engine !== 'WebKit')('falls back to ManagedMediaSource and opens sourceopen when MediaSource is removed', async () => {
      const seen = await withPage(async (page, module) => page.evaluate(async ({ MediaSource: Ponyfill }) => {
        // Control: prove bare MediaSource throws ReferenceError after removal.
        delete (globalThis as { MediaSource?: unknown }).MediaSource
        let bareError: string | null = null
        try {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          MediaSource
        } catch (error) {
          bareError = (error as Error).name
        }

        const supported = Ponyfill.isTypeSupported('video/mp4; codecs="avc1.64001f,mp4a.40.2"')
        const ms = new Ponyfill()
        const video = document.createElement('video')
        const state = await new Promise<string>((resolve) => {
          const timeout = setTimeout(() => resolve('timeout'), 3_000)
          ms.addEventListener('sourceopen', () => { clearTimeout(timeout); resolve(ms.readyState) }, { once: true })
          video.src = URL.createObjectURL(ms)
        })
        const Managed = (globalThis as unknown as { ManagedMediaSource: typeof MediaSource }).ManagedMediaSource
        return {
          bareError,
          supported,
          hasStreaming: 'streaming' in ms,
          isInstanceOfManaged: ms instanceof Managed,
          isInstanceOfPonyfill: ms instanceof Ponyfill,
          state,
        }
      }, await module()))
      expect(seen).toEqual({
        bareError: 'ReferenceError',
        supported: true,
        hasStreaming: true,
        isInstanceOfManaged: true,
        isInstanceOfPonyfill: true,
        state: 'open',
      })
    }, 60_000)
  })
}
