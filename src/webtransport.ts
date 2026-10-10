/**
 * `WebTransportDatagramDuplexStream.createWritable()`, as a function of the duplex, on every engine.
 *
 *     import { createWritable } from '@banou/ponyfill/webtransport'
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
 * The same day, a real webvpn relay counted the datagrams each engine sent through both calls, in a
 * page and in both workers: 3 of 3 every time on Chromium 149, Chrome 153, Firefox 151 and Firefox
 * 157. Playwright's WebKit never opened a QUIC session to it on either call, so on WebKit the shape
 * is measured and the traffic is not, and Safari itself was not run. MDN's compat data
 * (mdn/browser-compat-data `87af662`, 2026-08-26) agrees with the table: `createWritable` from
 * Firefox 155 and Safari 26.4, `writable` never in Safari.
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
 *
 * Firefox 155 and later have both members, so they take the native method and get a stream of their
 * own rather than the shared `writable`. On Firefox 157 a 2000 datagram burst from a shared worker
 * showed no loss against `writable` in one run (1995 against 1970; Firefox 151 gave 1972 and 2000 on
 * the same `writable` path).
 *
 * Two differences the fallback cannot refuse at the call. On a transport that is already closed or
 * failed it returns the `writable` as it is, where the native method throws `InvalidStateError`: the
 * duplex alone cannot see the transport's state. And the stream it returns has no `sendGroup` or
 * `sendOrder` attribute to set later, which the return type does not declare either.
 */

/** The platform's `WebTransportSendOptions`. TypeScript's DOM types still lack `sendGroup`. */
export type WebTransportSendOptions = { sendGroup?: object | null, sendOrder?: number }

/**
 * The two members read, both optional because no engine is certain to have either. `createWritable`
 * is a method signature on purpose: a property of function type has its parameter checked
 * contravariantly, so a DOM lib declaring the spec's `WebTransportSendGroup` would fail every call
 * with TS2345.
 */
type DatagramDuplex = {
  readonly writable?: WritableStream<Uint8Array>
  createWritable?(options?: WebTransportSendOptions): WritableStream<Uint8Array>
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
