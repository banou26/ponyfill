type NativeConstructor = typeof globalThis.RTCPeerConnection

const Native = globalThis.RTCPeerConnection as NativeConstructor | undefined

// The buffer is read, and the answer used, because a bundler drops an allocation nobody reads: this package's own did.
const allocates = (length: number): boolean => {
  try {
    return new ArrayBuffer(length).byteLength === length
  } catch {
    return false
  }
}

/**
 * `RTCPeerConnection`, the platform's class under the platform's name, whose constructor is not refused for
 * connections the page has already closed and dropped.
 *
 * ## What was measured, on what, and when
 *
 * 2026-11-13, one Linux machine, headless, a fresh profile per run: Chrome 156.0.8078.47 (V8 15.6.75.19, and the same
 * on Chromium 156.0.8078.4), Firefox 157.0, and WebKit 26.5 in Playwright's image. A page constructs connections, each
 * with one data channel, and keeps no reference to one it has closed.
 *
 * | | Chrome 156 | Firefox 157 | WebKit 26.5 (Playwright) |
 * | --- | --- | --- | --- |
 * | closed at once, in one loop | the 501st throws `UnknownError` | 1,500 made, none refused | 1,500 made, none refused |
 * | closed at once, one every 10 ms | the 501st, after 5.2 s | 1,200 made, none refused (one every 5 ms) | not measured |
 * | open 2 s each, one every 6 ms, 313 open at a time | the 501st, after 3.2 s | not measured | not measured |
 * | open 20 s each, one every 400 ms, 50 open at a time, the page allocating as an app does | the 528th, after 211 s | not measured | not measured |
 * | all kept open | the 501st | 1,500 made, none refused | 1,500 made, none refused |
 *
 * Chromium counts a connection against 500 per renderer process in its constructor and gives the slot back in its
 * destructor (`rtc_peer_connection.cc:211`, `:779` and `:850` at 156.0.8078.47, where that refusal is the file's only
 * `UnknownError`). So `close()` frees nothing: the slot comes back when a full garbage collection destroys the object.
 *
 * What brings the slots back at the refusal, within the same task, on Chrome 156:
 *
 * | | a blank page | a page holding 376 MiB of objects |
 * | --- | --- | --- |
 * | 512 buffers of 1 MiB, dropped | the next construction works; in one loop the 1,001st is refused | refused, also after 4,096 buffers |
 * | 64 buffers of 1 MiB, dropped every 200 constructions | 1,500 made 20 ms apart; the 501st refused in one loop, or 10 ms apart on an idle page | the 528th refused 20 ms apart; 800 made 400 ms apart |
 * | buffers of 1 MiB kept until a construction works | 32 to 464 MiB | 352 MiB, then 1.1 to 2.5 GiB, more each round |
 * | one `new ArrayBuffer(2 ** 35 - 1)` | every closed connection's slot back, in 6 to 34 ms | the same, in 386 to 437 ms |
 *
 * The first three lean on V8's allocation limits, which grow with the heap. The last one does not. V8 takes a length
 * up to 32 GiB - 1, Chromium's allocator refuses one over 16 GiB - 2 MiB before it reserves anything, and V8 answers
 * a refused backing store with full collections before it throws `RangeError` (`Heap::AllocateExternalBackingStore`
 * at V8 15.6.75, `MaxGigaAllocationSize` in PartitionAlloc). Measured around those bounds: a length of 2 ** 34 did the
 * same, 2 ** 34 - 2 MiB and 2 ** 33 were allocated, and 2 ** 35 is refused as a length with nothing collected. The
 * time follows the heap: 60 ms with 51 MiB of objects, 150 ms with 126 MiB.
 *
 * ## The pick
 *
 * The native constructor runs first. If it throws `UnknownError`, one `ArrayBuffer` of 32 GiB - 1 is asked for and,
 * once that is refused, the native constructor runs once more. An engine that grants the buffer has collected
 * nothing, so the refusal is thrown as it came. There is no count, no timer and no engine check, so where nothing is
 * refused (Firefox, WebKit) the native constructor is all that runs.
 *
 * It does not help a page that holds 500 connections open, or closed and still referenced: the second refusal is the
 * platform's own error, thrown as it came (8 ms after the first, measured with 500 open). The page waits for the
 * collection, for the times above. Not measured: Safari, Chromium on Android, and a 32 bit Chromium, where V8's
 * longest buffer is 2 ** 31 - 1 bytes, so this length is refused before the allocator sees it and nothing is collected.
 *
 * Where the context has no `RTCPeerConnection` (a worker, node) a construction throws `NotSupportedError`.
 */
export const RTCPeerConnection: NativeConstructor = class extends ((Native ?? Object) as NativeConstructor) {
  // set, and not left to a declaration: a consumer's minifier renames the class, and `name` went with it
  static { Object.defineProperty(this, 'name', { value: 'RTCPeerConnection' }) }

  constructor(...args: ConstructorParameters<NativeConstructor>) {
    if (!Native) throw new DOMException('this context has no RTCPeerConnection', 'NotSupportedError')
    try {
      super(...args)
    } catch (error) {
      if ((error as DOMException | undefined)?.name !== 'UnknownError' || allocates(2 ** 35 - 1)) throw error
      super(...args)
    }
  }
}
