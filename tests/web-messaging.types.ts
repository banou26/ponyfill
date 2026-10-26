// Compiled by web-messaging.test.ts with exactOptionalPropertyTypes off and on: each call goes to the platform and
// then to the ponyfill the same way, and the two must agree on what compiles.
import { postMessage } from '../src/web-messaging'

declare const w: Window
declare const port: MessagePort
declare const params: Parameters<Window['postMessage']>
declare const maybeOrigin: string | undefined
declare const either: string | WindowPostMessageOptions

w.postMessage('m', '*')
postMessage(w, 'm', '*')
w.postMessage('m', '*', [port])
postMessage(w, 'm', '*', [port])
w.postMessage('m')
postMessage(w, 'm')
w.postMessage('m', { targetOrigin: '*' })
postMessage(w, 'm', { targetOrigin: '*' })
w.postMessage('m', undefined)
postMessage(w, 'm', undefined)
w.postMessage('m', '*', undefined)
postMessage(w, 'm', '*', undefined)
w.postMessage(...params)
postMessage(w, ...params)

// @ts-expect-error no message
w.postMessage()
// @ts-expect-error no message
postMessage(w)
// @ts-expect-error an origin that may be missing
w.postMessage('m', maybeOrigin)
// @ts-expect-error an origin that may be missing
postMessage(w, 'm', maybeOrigin)
// @ts-expect-error an origin or options, not known which
w.postMessage('m', either)
// @ts-expect-error an origin or options, not known which
postMessage(w, 'm', either)
// @ts-expect-error a fourth argument
w.postMessage('m', '*', [port], 1)
// @ts-expect-error a fourth argument
postMessage(w, 'm', '*', [port], 1)
// @ts-expect-error a number as the origin
w.postMessage('m', 1)
// @ts-expect-error a number as the origin
postMessage(w, 'm', 1)
