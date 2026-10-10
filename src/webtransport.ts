/**
 * `WebTransportDatagramDuplexStream.createWritable()`, as a function of the duplex, on every engine.
 *
 *     import { createWritable } from '@banou/ponyfill'
 *     const writer = createWritable(webtransport.datagrams).getWriter()
 *
 * ## What was measured, on what, and when
 *
 * 2026-10-10, one machine, headless: the duplex prototype read in a page, a dedicated worker and a
 * shared worker, then a real `new WebTransport(url).datagrams` asked for a writer both ways.
 *
 * | | Chromium 149, Chrome 153 | Firefox 151 | Firefox 157 | WebKit 26.0 (Playwright) |
 * | --- | --- | --- | --- | --- |
 * | `createWritable()` | absent | absent | present | present |
 * | `writable` | present | present | present | ABSENT, so `writable.getWriter()` throws `TypeError` |
 *
 * Firefox 157 was read in a page only. Safari was not run; MDN's compat data (`e0aae4c`) agrees with
 * the WebKit column, with `createWritable` from Safari 26.4 and `writable` never shipped.
 *
 * ## The divergence
 *
 * The specification replaced the one `writable` with `createWritable(options)`, which hands out a new
 * writable on every call, each with its own `sendGroup` and `sendOrder`. Chrome has only the old
 * member, Safari only the new one, and TypeScript's DOM types still declare only `writable`, so the
 * old call compiles everywhere and throws on Safari.
 *
 * ## The pick
 *
 * The native `createWritable` wherever it exists, and the duplex's `writable` otherwise. The fallback
 * cannot do two things the native method does, and both refuse with `NotSupportedError` at the call
 * rather than misbehave later: a second writable from the same duplex (there is only one stream, so
 * two callers would share it and closing either would close both), and a `sendGroup` or non-zero
 * `sendOrder` (that stream has no priority of its own).
 */

/** The platform's `WebTransportSendOptions`. TypeScript's DOM types still lack `sendGroup`. */
export type WebTransportSendOptions = { sendGroup?: object | null, sendOrder?: number }

/** The two members read, both optional because no engine is certain to have either. */
type DatagramDuplex = {
  readonly writable?: WritableStream<Uint8Array>
  createWritable?: (options?: WebTransportSendOptions) => WritableStream<Uint8Array>
}

const handedOut = new WeakSet<object>()

const refuse = (message: string) => new DOMException(message, 'NotSupportedError')

/** Same as `datagrams.createWritable(options)`, with the duplex as the first argument. */
export const createWritable = (datagrams: DatagramDuplex, options?: WebTransportSendOptions): WritableStream<Uint8Array> => {
  if (typeof datagrams.createWritable === 'function') return datagrams.createWritable(options)
  if (options?.sendGroup != null || (options?.sendOrder ?? 0) !== 0) {
    throw refuse('this browser cannot give a datagram writable its own send group or send order')
  }
  const { writable } = datagrams
  if (!writable) throw refuse('this browser has no way to write datagrams')
  if (handedOut.has(datagrams)) throw refuse('this browser has one datagram writable per session, and it is already in use')
  handedOut.add(datagrams)
  return writable
}
