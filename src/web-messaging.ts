/**
 * `Window.postMessage()`, taking the target window first, so the message carries the sender's window as its
 * `source` on every engine, wherever the caller puts the call. Exported from `@banou/ponyfill/web-messaging` only,
 * as a method of an object the caller holds (see the root entry): the root's `postMessage` would be the global one.
 *
 * ## What was measured, on what, and when
 *
 * 2026-10-26, headless, a page framing one document on its own origin and one on another, the calls in a module
 * (strict code) and made from a callback the browser itself calls: `setTimeout`, a `MessagePort`'s `onmessage`, a
 * promise reaction, an iframe's `load` listener. What the receiver read as `event.source`, page to frame and frame
 * to page alike:
 *
 * | how the sender calls `target.postMessage(message, origin)` | Chromium 155, Firefox 157 | WebKit 26.4, 26.5 (Playwright) |
 * | --- | --- | --- |
 * | a tail call: `() => target.postMessage(...)`, `() => target?.postMessage(...)`, `return target.postMessage(...)` | the sender | **the receiver's own window** |
 * | the same, to a target on another origin | the sender | the sender |
 * | a tail call of a helper that tail-calls it | the sender | **the receiver** |
 * | a statement: `{ target.postMessage(...) }`, `void target.postMessage(...)`, or a statement calling a helper that tail-calls it | the sender | the sender |
 * | `return target.postMessage(...)` in an async function, before any `await` / after one | the sender | the sender / **the receiver** |
 * | a tail call in sloppy code, or from the listener of an event a script dispatched | the sender | the sender |
 * | this function, in any of the positions above | the sender | the sender |
 *
 * JavaScriptCore runs proper tail calls in strict code, so a tail call takes the caller's frame off the stack before
 * the platform reads it for the incumbent realm, and with no frame of the sender's left WebKit lands on the realm of
 * the `postMessage` function itself. That is the target's for a target on the same origin, and the caller's for one
 * on another, since a cross-origin window hands out its methods in the caller's realm (read with `instanceof
 * Function`, the same on all three engines). So a receiver checking `event.source` against the window it expects
 * drops the message.
 *
 * ## The pick
 *
 * The call is a statement here, so this function's frame, in the realm that imported it, is on the stack when the
 * platform reads it, however the caller reaches this function. Nothing is detected and every engine runs the same
 * line.
 */
export const postMessage = (target: Window, ...args: PostMessageArguments): void => {
  // a statement, never `return` or an arrow's bare body: either makes it a tail call again
  target.postMessage(...(args as [unknown, string]))
}

// `Window.postMessage()`'s two overloads
type PostMessageArguments =
  | [message: unknown, targetOrigin: string, transfer?: Transferable[]]
  | [message: unknown, options?: WindowPostMessageOptions]
