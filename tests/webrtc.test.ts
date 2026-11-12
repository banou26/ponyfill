import type { Browser, JSHandle } from 'playwright-core'

import { join } from 'node:path'
import { compileFunction } from 'node:vm'
import { build } from 'vite-plus'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'

import { engines } from './engines'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * The entry as it ships, built in memory by the package's own config. The browsers run this and not the source, and
 * so does one case without a browser, because the bundler is part of what is pinned: it dropped the buffer request
 * while nothing read the buffer.
 */
const built = (async () => {
  const outputs = await build({ root: join(import.meta.dirname, '..'), logLevel: 'silent', build: { write: false } })
  const files = [outputs].flat().flatMap(output => 'output' in output ? output.output : [])
  const code = (fileName: string) => {
    const file = files.find(file => file.fileName === fileName)
    if (file?.type !== 'chunk') throw new Error(`the build made no ${fileName}`)
    return file.code
  }
  return { es: code('webrtc.js'), cjs: code('webrtc.cjs') }
})()

type Module = { RTCPeerConnection: typeof RTCPeerConnection }

/** The module reads the platform's class once, as it loads, so each case loads it again over its own global. */
const fresh = async () => {
  vi.resetModules()
  return (await import('../src/webrtc')).RTCPeerConnection
}

const refusal = () => new DOMException('Failed to construct \'RTCPeerConnection\': Cannot create so many PeerConnections', 'UnknownError')

/** A platform class whose constructor throws whatever `answer` returns for that call, counted from 1. */
const platform = (answer: (call: number) => unknown = () => undefined) => {
  const calls: unknown[][] = []
  class Native {
    static generateCertificate = () => 'a certificate'
    constructor(...args: unknown[]) {
      calls.push(args)
      const error = answer(calls.length)
      if (error) throw error
    }
  }
  vi.stubGlobal('RTCPeerConnection', Native)
  return { Native, calls }
}

/** Records every length asked of `ArrayBuffer`, and refuses one past 16 GiB the way Chromium's allocator does. */
const allocator = () => {
  const asked: number[] = []
  vi.stubGlobal('ArrayBuffer', class extends ArrayBuffer {
    constructor(length: number) {
      asked.push(length)
      if (length > 2 ** 34) throw new RangeError('Array buffer allocation failed')
      super(length)
    }
  })
  return asked
}

const thrownBy = (run: () => unknown) => {
  try { run() } catch (error) { return error }
  throw new Error('expected a throw, and the call returned')
}

describe('RTCPeerConnection over a platform class', () => {
  it('is the platform\'s class under its name: its instances, its statics, its arguments as given', async () => {
    const { Native, calls } = platform()
    const Ponyfill = await fresh()
    const configuration = { iceServers: [] }
    const connection: RTCPeerConnection = new Ponyfill(configuration)
    new Ponyfill()
    expect(connection).toBeInstanceOf(Native)
    expect(Ponyfill.name).toBe('RTCPeerConnection')
    expect(Object.getPrototypeOf(Ponyfill)).toBe(Native)
    expect(Reflect.get(Ponyfill, 'generateCertificate')).toBe(Native.generateCertificate)
    expect(calls).toEqual([[configuration], []])
    expect(calls[0]![0]).toBe(configuration)
  })

  it('adds nothing where nothing is refused: 1,200 constructions ask for no buffer', async () => {
    const { calls } = platform()
    const asked = allocator()
    const Ponyfill = await fresh()
    for (let i = 0; i < 1200; i++) new Ponyfill()
    expect(calls).toHaveLength(1200)
    expect(asked).toEqual([])
  })

  it('on the cap\'s refusal, asks once for a buffer no allocator grants, then constructs again', async () => {
    const { Native, calls } = platform(call => call === 1 && refusal())
    const asked = allocator()
    const Ponyfill = await fresh()
    const configuration = { iceServers: [] }
    expect(new Ponyfill(configuration)).toBeInstanceOf(Native)
    expect(asked).toEqual([2 ** 35 - 1])
    expect(calls).toEqual([[configuration], [configuration]])
  })

  it('the build keeps the buffer request, which a bundler drops while nothing reads the buffer', async () => {
    const { Native, calls } = platform(call => call === 1 && refusal())
    const asked = allocator()
    const exports = {} as Module
    compileFunction((await built).cjs, ['exports'])(exports)
    expect(new exports.RTCPeerConnection()).toBeInstanceOf(Native)
    expect(asked).toEqual([2 ** 35 - 1])
    expect(calls).toHaveLength(2)
  })

  it('an engine that grants the buffer collected nothing: the refusal is thrown as it came, with no second construction', async () => {
    const first = refusal()
    const { calls } = platform(() => first)
    const asked: number[] = []
    vi.stubGlobal('ArrayBuffer', class {
      byteLength: number
      constructor(length: number) {
        asked.push(length)
        this.byteLength = length
      }
    })
    const Ponyfill = await fresh()
    expect(thrownBy(() => new Ponyfill())).toBe(first)
    expect(asked).toEqual([2 ** 35 - 1])
    expect(calls).toHaveLength(1)
  })

  it('a second refusal is the platform\'s own error, thrown as it came', async () => {
    const second = refusal()
    const { calls } = platform(call => call === 1 ? refusal() : second)
    const asked = allocator()
    const Ponyfill = await fresh()
    expect(thrownBy(() => new Ponyfill())).toBe(second)
    expect(asked).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it('any other error is thrown as it came, with no buffer asked for and no second construction', async () => {
    for (const error of [new DOMException('bad ICE server', 'SyntaxError'), new TypeError('not a dictionary')]) {
      const { calls } = platform(() => error)
      const asked = allocator()
      const Ponyfill = await fresh()
      expect(thrownBy(() => new Ponyfill())).toBe(error)
      expect(asked).toEqual([])
      expect(calls).toHaveLength(1)
    }
  })

  it('where the context has no RTCPeerConnection, importing works and constructing throws NotSupportedError', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined)
    const Ponyfill = await fresh()
    const error = thrownBy(() => new Ponyfill())
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('NotSupportedError')
  })

  it('writes nothing to a global, and leaves the platform\'s class as it was', async () => {
    const { Native } = platform(call => call === 1 && refusal())
    allocator()
    const shape = () => [Object.getOwnPropertyNames(globalThis), Object.getOwnPropertyNames(Native), Object.getOwnPropertyNames(Native.prototype)]
    const before = shape()
    const Ponyfill = await fresh()
    new Ponyfill()
    expect(shape()).toEqual(before)
    expect(globalThis.RTCPeerConnection).toBe(Native)
  })
})

const ORIGIN = 'https://rig.test'
const CAP = 500

for (const [engine, launch] of engines) {
  describe.skipIf(!launch)(`RTCPeerConnection in ${engine}`, () => {
    const capped = engine === 'Chromium'
    let browser: Browser
    let code: string

    beforeAll(async () => {
      code = (await built).es
      browser = await launch!()
    }, 60_000)

    afterAll(async () => { await browser?.close() })

    // A page of its own for each case: Chromium counts its slots per renderer process, so a shared page would start
    // a case with whatever the one before left uncollected. The module is imported by a string, which vitest leaves
    // alone, and reaches the callbacks as a handle, so the rig adds no global either.
    const withPage = async <T>(run: (page: Awaited<ReturnType<Browser['newPage']>>, module: () => Promise<JSHandle<Module>>) => Promise<T>) => {
      const page = await browser.newPage()
      try {
        await page.route('**/*', route => {
          const { origin, pathname } = new URL(route.request().url())
          if (origin !== ORIGIN) return route.abort()
          if (pathname === '/webrtc.js') return route.fulfill({ contentType: 'text/javascript', body: code })
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
        })
        await page.goto(`${ORIGIN}/`)
        return await run(page, () => page.evaluateHandle('import(\'/webrtc.js\')') as Promise<JSHandle<Module>>)
      } finally {
        await page.close()
      }
    }

    it('is the platform\'s class, and a connection made through it works', async () => {
      const seen = await withPage(async (page, module) => page.evaluate(async ({ RTCPeerConnection: Ponyfill }) => {
        const connection = new Ponyfill({ bundlePolicy: 'max-bundle' })
        connection.createDataChannel('x')
        const offer = await connection.createOffer()
        connection.close()
        return {
          instance: connection instanceof RTCPeerConnection,
          name: Ponyfill.name,
          statics: Ponyfill.generateCertificate === RTCPeerConnection.generateCertificate,
          configuration: connection.getConfiguration().bundlePolicy,
          offer: offer.type,
          state: connection.signalingState,
        }
      }, await module()))
      expect(seen).toEqual({ instance: true, name: 'RTCPeerConnection', statics: true, configuration: 'max-bundle', offer: 'offer', state: 'closed' })
    }, 60_000)

    it('writes nothing to a global, and leaves the platform\'s class as it was', async () => {
      // sorted: Firefox moves a global's name as the page first reads it
      const shape = () => {
        const Native = RTCPeerConnection
        return JSON.stringify([Object.getOwnPropertyNames(globalThis).sort(), Object.getOwnPropertyNames(Native), Object.getOwnPropertyNames(Native.prototype)])
      }
      const [before, after] = await withPage(async (page, module) => {
        const before = await page.evaluate(shape)
        await page.evaluate(({ RTCPeerConnection: Ponyfill }) => { new Ponyfill().close() }, await module())
        return [before, await page.evaluate(shape)]
      })
      expect(JSON.parse(before)[0]).toContain('RTCPeerConnection')
      expect(after).toBe(before)
    }, 60_000)

    // The control is the platform's own class in the same page, first, so what it leaves closed is what the ponyfill
    // then has to construct over. The buffers are counted through a subclass the page puts in place of `ArrayBuffer`.
    it(`three times Chromium's cap, closed at once in one loop: the platform ${capped ? 'refuses the 501st' : 'refuses none, so no buffer is asked for'}`, async () => {
      const seen = await withPage(async (page, module) => page.evaluate(({ RTCPeerConnection: Ponyfill }) => {
        const churn = (Class: typeof RTCPeerConnection) => {
          let made = 0
          try {
            for (; made < 1500; made++) {
              const connection = new Class()
              connection.createDataChannel('x')
              connection.close()
            }
          } catch (error) {
            return { made, refused: (error as DOMException).name }
          }
          return { made }
        }
        const platform = churn(RTCPeerConnection)
        const asked: number[] = []
        const NativeBuffer = ArrayBuffer
        globalThis.ArrayBuffer = class extends NativeBuffer {
          constructor(length: number) {
            asked.push(length)
            super(length)
          }
        } as ArrayBufferConstructor
        try {
          return { platform, ponyfill: churn(Ponyfill), asked }
        } finally {
          globalThis.ArrayBuffer = NativeBuffer
        }
      }, await module()))
      expect(seen.platform).toEqual(capped ? { made: CAP, refused: 'UnknownError' } : { made: 1500 })
      expect(seen.ponyfill).toEqual({ made: 1500 })
      expect(new Set(seen.asked)).toEqual(new Set(capped ? [2 ** 35 - 1] : []))
      // one for each refusal: a collection gave back 499 slots of 500 when measured, so 4 refusals in 1,500, or 3 if all come back
      if (capped) expect([3, 4]).toContain(seen.asked.length)
    }, 60_000)

    // without the ponyfill this shape is refused at the 501st, after 3.2 s (measured, see the module)
    it.skipIf(!capped)('750 connections open 2 s each, one every 6 ms, about 300 open at a time', async () => {
      const seen = await withPage(async (page, module) => page.evaluate(async ({ RTCPeerConnection: Ponyfill }) => {
        let made = 0
        let open = 0
        let peak = 0
        try {
          for (; made < 750; made++) {
            const connection = new Ponyfill()
            const channel = connection.createDataChannel('x')
            connection.onicecandidate = () => {}
            channel.onopen = () => {}
            void connection.createOffer().then(offer => connection.setLocalDescription(offer)).catch(() => {})
            peak = Math.max(peak, ++open)
            setTimeout(() => {
              connection.onicecandidate = null
              channel.onopen = null
              connection.close()
              open--
            }, 2000)
            await new Promise(resolve => setTimeout(resolve, 6))
          }
        } catch (error) {
          return { made, peak, refused: (error as DOMException).name }
        }
        return { made, peak }
      }, await module()))
      expect(seen).toEqual({ made: 750, peak: expect.any(Number) })
      expect(seen.peak).toBeGreaterThan(100)
      expect(seen.peak).toBeLessThan(CAP)
    }, 60_000)

    it.skipIf(!capped)('a page holding the cap open gets the platform\'s own refusal, until it closes and drops them', async () => {
      const seen = await withPage(async (page, module) => page.evaluate(({ RTCPeerConnection: Ponyfill }) => {
        const attempt = (Class: typeof RTCPeerConnection) => {
          try {
            new Class().close()
            return 'made'
          } catch (error) {
            return `${error instanceof DOMException} ${(error as DOMException).name}: ${(error as DOMException).message}`
          }
        }
        const held = Array.from({ length: 500 }, () => new Ponyfill())
        const platform = attempt(RTCPeerConnection)
        const ponyfill = attempt(Ponyfill)
        for (const connection of held) connection.close()
        held.length = 0
        return { platform, ponyfill, dropped: attempt(Ponyfill) }
      }, await module()))
      expect(seen.platform).toMatch(/^true UnknownError: /)
      expect(seen.ponyfill).toBe(seen.platform)
      expect(seen.dropped).toBe('made')
    }, 60_000)
  })
}
