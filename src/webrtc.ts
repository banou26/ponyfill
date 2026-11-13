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
 * connections the page has already closed and dropped, as far as a garbage collection gives their slots back: the
 * ones it does not are listed under "What it does not do".
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
 * time follows the heap: 60 ms with 51 MiB of objects, 150 ms with 126 MiB, 1.3 to 2.1 s with 1.25 GiB.
 *
 * ## The pick
 *
 * The native constructor runs first. If it throws `UnknownError`, one `ArrayBuffer` of 32 GiB - 1 is asked for and,
 * once that is refused, the native constructor runs once more. An engine that grants the buffer has collected
 * nothing, so the refusal is thrown as it came. There is no count, no timer and no engine check, so where nothing is
 * refused (Firefox, WebKit) the native constructor is all that runs.
 *
 * ## What a handled refusal costs
 *
 * The page waits for the collection, for the times above. V8 runs it as its last resort before an out-of-memory
 * error (`HeapAllocator::RetryCustomAllocate` ends in `CollectAllAvailableGarbage` at V8 15.6.75), which brings two
 * more costs, measured on Chrome 156:
 *
 * - With the debugger attached, as it is while DevTools is open, the page pauses in this constructor at every handled
 *   refusal (reason `OOM`, the pause before a potential out-of-memory crash) until it is resumed: 3 pauses for the 3
 *   refusals of 1,600 constructions in 4 of 4 runs, none with the platform's class, none with the debugger off.
 * - On a page whose JS heap is above 95% of V8's limit, collections run back to back count as ineffective, and V8
 *   ends the page at the fourth in a row (`Heap::CheckIneffectiveMarkCompact`). With the limit lowered to 512 MiB and
 *   491 MiB of objects held, one loop of connections closed at once ended the page at its third refusal in 7 of 7
 *   runs, where the platform's class throws at the 501st and the page lives. With a task between constructions no
 *   page ended in 6 runs, and with 471 MiB held one loop made 2,600.
 *
 * ## What it does not do
 *
 * It does not help a page that holds 500 connections: the second refusal is the platform's own error, thrown as it
 * came (8 ms after the first, measured with 500 open). A connection holds its slot while it is open and while the
 * page still references it, and in these cases as well, measured on Chrome 156:
 *
 * - Dropped without `close()`: the 501st is refused, in one loop and 10 ms apart.
 * - Closed while its own `createOffer()` or `setLocalDescription()` is pending: until a task has run. In one loop the
 *   501st is refused, and with a task between constructions 1,500 were made.
 * - Closed in the one task between Chromium scheduling a state change event and dispatching it: while its frame
 *   lives, as read (`ScheduleDispatchEvent` holds the connection for an `icegatheringstatechange` or a
 *   `connectionstatechange`, `close()` leaves the event scheduled, and `DispatchScheduledEvents` then returns before
 *   it; `rtc_peer_connection.cc:2976`, `:3111`, `:2557` and `:3231`). A lone connection closed after its
 *   `setLocalDescription(offer)` resolved kept its slot 9.5 s later in 0 of 40 when closed in the same task, 40 and
 *   36 of 40 one task later, 36 of 40 a `setTimeout` of 0 ms later, 1 of 40 two tasks later, and none 3 tasks or 1 ms
 *   later, or closed inside its `icegatheringstatechange` handler. Made by a child frame's own class and closed one
 *   task later, 39 and 40 of 40 kept theirs, and 0 of 40 once that frame was removed. Between two ends in one page,
 *   an answerer closed in the task that ended its signalling, candidates still passing: 30 and 36 of 40, and with
 *   both ends closed then, 10 and 33 of 80 connections after 5 minutes with a collection every 20 s. Closed 5 ms
 *   later, none.
 * - At times the collection gives no slot back although every connection was closed and dropped, and the next ones
 *   give none either. The platform's class to its refusal, then 1,500 through this one closed at once in one loop:
 *   the retry was refused in 7 of 826 runs where the page had a subclass of its own in the platform class's place,
 *   and in 0 of 60 where it had none. Connections open 2 s each met it in 2 of 16 runs on a busy machine. In three
 *   such pages, two more buffer requests over 2 s freed nothing, and one collection asked for through the debugger
 *   protocol (`HeapProfiler.collectGarbage`) then freed all 500. With V8's heap limit lowered to 512 MiB and 376 MiB
 *   of objects held it was 10 of 356 runs, one still refused 21 s and four requests later, and 0 of 31 with Chrome's
 *   own limit. The cause was not found.
 *
 * Not measured: Safari, Chromium on Android, and a 32 bit Chromium, where V8's longest buffer is 2 ** 31 - 1 bytes,
 * so this length is refused before the allocator sees it and nothing is collected.
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
