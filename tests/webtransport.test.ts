import { describe, expect, it } from 'vite-plus/test'

import { createWritable, type WebTransportSendOptions } from '../src/webtransport'

/**
 * Fakes in the shapes measured on 2026-10-10 (see the module). Methods and getters sit on a class
 * prototype and check their receiver, as the platform's WebIDL members do, so a call that loses
 * `this` fails here the way it would in a browser.
 */
class SafariDuplex {
  seen: (WebTransportSendOptions | undefined)[] = []
  createWritable(options?: WebTransportSendOptions) {
    if (!(this instanceof SafariDuplex)) throw new TypeError('Illegal invocation')
    this.seen.push(options)
    return new WritableStream<Uint8Array>()
  }
}

class ChromeDuplex {
  #writable = new WritableStream<Uint8Array>()
  get writable() { return this.#writable }
}

class Firefox157Duplex extends ChromeDuplex {
  createWritable() { return new WritableStream<Uint8Array>() }
}

const refusal = (run: () => unknown) => {
  try { run() } catch (error) { return error }
  throw new Error('expected a refusal, and the call returned')
}

describe('createWritable on the engine shapes measured', () => {
  it('the call it replaces throws on Safari\'s shape, so the fake reproduces the failure', () => {
    const safari = new SafariDuplex() as unknown as { writable: WritableStream }
    expect(() => safari.writable.getWriter()).toThrow(TypeError)
  })

  it('Safari: answers the native createWritable, on the duplex itself, with the options untouched', () => {
    const safari = new SafariDuplex()
    const options = { sendOrder: 3 }
    const writable = createWritable(safari, options)
    expect(writable).toBeInstanceOf(WritableStream)
    expect(safari.seen).toEqual([options])
    expect(safari.seen[0]).toBe(options)
  })

  it('Safari: a new writable on every call, each with its own writer', () => {
    const safari = new SafariDuplex()
    const first = createWritable(safari)
    const second = createWritable(safari)
    expect(second).not.toBe(first)
    expect(() => { first.getWriter(); second.getWriter() }).not.toThrow()
  })

  it('Chrome: answers the duplex\'s writable, and a writer takes a datagram', async () => {
    const chrome = new ChromeDuplex()
    const writable = createWritable(chrome)
    expect(writable).toBe(chrome.writable)
    const writer = writable.getWriter()
    await expect(writer.write(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined()
  })

  it('Firefox 157, which has both: the native createWritable wins', () => {
    const firefox = new Firefox157Duplex()
    const writable = createWritable(firefox)
    expect(writable).toBeInstanceOf(WritableStream)
    expect(writable).not.toBe(firefox.writable)
  })
})

/**
 * The duplex as a DOM lib that follows the specification would declare it: `createWritable` a
 * method, and its `sendGroup` a `WebTransportSendGroup`, which has a member `object` lacks. Checked
 * by `vp lint` (type aware), not by vitest.
 */
type SpecSendGroup = { getStats(): Promise<unknown> }
type SpecDuplex = {
  readonly writable?: WritableStream
  createWritable(options?: { sendGroup?: SpecSendGroup | null, sendOrder?: number }): WritableStream<Uint8Array>
}

describe('the types', () => {
  it('a duplex typed like the spec IDL compiles as the argument, so a newer DOM lib cannot break callers', () => {
    const spec: SpecDuplex = new SafariDuplex()
    expect(createWritable(spec)).toBeInstanceOf(WritableStream)
  })
})

describe('what the fallback cannot do is refused at the call', () => {
  it('a second writable from one duplex, which would share the only stream', () => {
    const chrome = new ChromeDuplex()
    createWritable(chrome)
    const error = refusal(() => createWritable(chrome))
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('NotSupportedError')
  })

  it('the one writable is per duplex, so another session still gets its own', () => {
    createWritable(new ChromeDuplex())
    expect(() => createWritable(new ChromeDuplex())).not.toThrow()
  })

  it('a send group or a send order, before anything is handed out', () => {
    const chrome = new ChromeDuplex()
    for (const options of [{ sendOrder: 1 }, { sendGroup: {} }]) {
      expect((refusal(() => createWritable(chrome, options)) as DOMException).name).toBe('NotSupportedError')
    }
    expect(createWritable(chrome, { sendOrder: 0, sendGroup: null })).toBe(chrome.writable)
  })

  it('a duplex with neither member', () => {
    expect((refusal(() => createWritable({})) as DOMException).name).toBe('NotSupportedError')
  })
})
