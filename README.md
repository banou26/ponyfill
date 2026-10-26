# @banou/ponyfill

Ponyfills for the places browsers disagree, with the measurement behind each one.

```ts
import { storage } from '@banou/ponyfill'

const { usage, quota } = await storage.estimate()
```

## Why this is a package and not a file in an app

**It is a ponyfill, never a polyfill.** Nothing here writes to a global. You import the wrapped API
and call the same method names the platform uses, so a call site reads the same as the native one and
`grep` can still find every place that needed the workaround. A method of an object you already hold
is a function of the same name that takes that object first, exported from its module's own entry
rather than the root, since the root holds the platform's global names: `createWritable(datagrams)`
from `@banou/ponyfill/webtransport`. An attribute the engines name differently is set through `set`
and the platform's name, object first: `setOutgoingMaxBufferedDatagrams(datagrams, 256)` for
`datagrams.outgoingMaxBufferedDatagrams = 256`, so a case-insensitive `grep` for the attribute finds it.

Patching `navigator.storage` would change what every other script on the page sees, including code
that was correct against the real behaviour, and it would hide the difference at exactly the call
sites that most need to show it.

**Every workaround carries its measurement.** What was measured, on what, and when. A workaround with
no measurement behind it is a guess that outlives the bug it was written for, and there is no way to
tell the two apart later.

## What is in it

### `storage`

The same method names as `navigator.storage`, fixing two things.

**`usage` can be six orders of magnitude short.** Measured on Chrome 151: an origin holding a
verified 1,783,407,077 bytes reported `usage: 1,813,502` with `usageDetails.fileSystem: 752`. 752
bytes against 1.78 GB. Anything sizing a write from that decides everything fits, then fails with
`QuotaExceededError` at the real limit. `storage.estimate()` walks the origin and reports the larger
of the two, keeping the parts the browser counts correctly (IndexedDB, caches) rather than replacing
them.

**`quota` means a different thing on each engine.** Measured 2026-09-03, one machine with 2.7 TiB
free, one origin, three 512 MiB sparse writes per engine, same page and same code:

| engine | quota at rest | after 1.615 GB written | `quota - usage` |
| --- | --- | --- | --- |
| Chromium 152 | 10,737,491,968 | rose by exactly what was written | 10,737,418,240 every time, moved **0 bytes** |
| Firefox | 10,737,418,240 | unmoved | fell 536,870,912 per write |

Both cap at 10 GiB; they cap **different quantities**. Chromium's quota is a floating ceiling
(`usage + headroom`), so the headroom is a constant and can never shrink. Firefox's is a fixed
ceiling, so writing consumes it.

Neither is a bug: the Storage Standard calls quota "a conservative estimate" and never says how to
compute it. But it means this very common line is dead on one engine and live on the other:

```ts
if (quota - usage < someFloor) { /* ... */ }   // can never be true on Chromium
```

That is not hypothetical. It is why four of ripple's storage eviction tests sat failing for months:
they filled the origin to provoke that condition, and 3.5 GB of padding left the free figure
identical to the byte.

**The behaviour picked is Firefox's: a ceiling does not rise because you put something under it.**
`quota` is reported as the lowest the platform has stated for this origin, which needs no probe and
no user agent sniffing, and invents nothing: the platform really did say the origin could hold that
much. Two ordinary things are broken by the rising version, and both were seen in ripple:
`usage / quota` as a gauge never fills, and `quota - usage < floor` never fires, so nothing can
detect pressure at all.

The cost is deliberate and in the safe direction. On Chromium, once bytes are written the reported
headroom is smaller than what could really be written, so a caller reclaims cache slightly early.
Cache is the thing that can be fetched again; a caller that never reclaims because it never sees
pressure is the failure this replaces. The ceiling still follows the platform DOWNWARD, and is never
reported below the bytes already held, so `quota - usage` reaches zero and never goes negative.

The ceiling is held per realm and in memory, and it **lets go when the origin's persistence changes**.
A granted `persist()` moved the reported quota from 12 GB to 3.97 TB on Firefox (measured
2026-09-01), so the figure learned before that is worse than useless afterwards. The release is keyed
on the state rather than on the call, because `persist()` only exists on the main thread: a worker
that latched the old ceiling and could never call it would go on deciding what to delete from a
number that no longer exists.

### `permissions`

`query()` has four ways of behaving and only one of them is an answer: the engine may have no
Permissions API, may reject a name it does not implement, may **throw synchronously** for one (which
a `.catch` on the returned promise never sees), or may answer a real state.

All three non-answers collapse to `'prompt'`. Not `'denied'`, because an engine that cannot be asked
has not refused anything, and treating silence as refusal costs the person a control that might have
worked.

### `showOpenFilePicker`, `showDirectoryPicker`, `showSaveFilePicker`

Measured 2026-09-03 across Chromium 149, Firefox 151 and WebKit 26:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| the three pickers | present | **absent** | **absent** |
| `FileSystemHandle` and friends as globals | present | present | **absent** |
| `<input>.webkitdirectory` and its `cancel` event | yes | yes | yes |
| an object holding its methods as own properties, cloned | `DataCloneError` | `DataCloneError` | `DataCloneError` |
| the same object with its methods on a prototype | clones, silently | clones, silently | clones, silently |
| `<input webkitdirectory>` file order, same tree | `a`, `sub/b` | `sub/b`, `a` | `sub/b`, `a` |

**Reading always works, and always answers handles.** Where the platform has a picker it is used and
its handles come back untouched. Where it does not, an `<input type="file">` is opened and what comes
back is wrapped in the same shape, so a caller has one call and one return type instead of a
`FileSystemFileHandle | File` union threaded through everything downstream.

**Writing is refused rather than faked.** `showSaveFilePicker` has no fallback, `showDirectoryPicker`
refuses `mode: 'readwrite'` where there is no native picker, and a wrapped handle's
`createWritable()` throws. There is no way to write to a chosen location without the platform's
picker.

**Refusals happen before the gesture is spent**, and are named `NotAllowedError` so a caller can tell
them from the `AbortError` the platform throws when the person cancels. A caller has one transient
activation, and a picker that rejects at call time has already spent part of it.

**A wrapped handle cannot be persisted, and says so loudly.** This is the one difference that cannot
be absorbed, so what is picked is how it fails. A native handle survives `structuredClone` and comes
back out of IndexedDB still usable; a wrapper around a `File` cannot, because a snapshot is not an
entry on a disk. Left as an ordinary object it would clone *successfully* and come back with its
prototype gone and every method with it, failing after a reload with nothing pointing at the pick. So
every wrapped handle carries its methods as own properties, which makes the store throw
`DataCloneError` at the moment of the mistake: one `.catch` where it matters instead of a capability
probe at every call site.

**That applies to `postMessage` too, which is the part that surprises people.** Structured clone is
also how a message reaches a worker, so a wrapped handle cannot cross that boundary either. Resolve
it to the `File` behind it first:

```ts
const handle = (await showOpenFilePicker())[0]
const canBeReopened = (() => { try { structuredClone(handle); return true } catch { return false } })()
worker.postMessage({ file: canBeReopened ? handle : await handle.getFile() })
```

That `try` is also the honest way to ask whether a pick survives a reload, with no new API and no
user agent sniffing: it is the same operation an IndexedDB `put` performs. Found the hard way in
ripple, where posting the wrapper published a torrent that then never reached one per cent, with
nothing reporting a fault.

### `write`

`FileSystemSyncAccessHandle.write()`, taking the handle as its first argument, from
`@banou/ponyfill/file-system` only, throwing `QuotaExceededError` on every engine when the quota
refuses the write.

```ts
import { write } from '@banou/ponyfill/file-system'

write(handle, bytes, { at: offset })
```

Measured 2026-10-19, headless, a dedicated worker writing into OPFS: on Firefox inside a frame held to
its fixed 10 GiB group limit, on Chrome in a profile held to a 1 GiB tmpfs.

| | Firefox 151, Firefox 157 | Chrome 155 |
| --- | --- | --- |
| a write with no room left for any of it | returns 0, throws nothing | throws a `QuotaExceededError` instance, writes nothing |
| 200 MiB into about 75 MiB of room | returns 78,643,200, throws nothing | not measured |

The specification (whatwg/fs `7df1158`, 2026-10-08) throws `QuotaExceededError` before writing
anything when the write would exceed the quota, and returns a short count only for a write that failed
part way for some other reason. So code that checks only for the throw reads Firefox's refusal as
success. Found in ripple, whose engine took a refused write for a retryable one and retried it for
three seconds before stopping the torrent anyway.

**A short count throws `QuotaExceededError`**, built from the platform's `QuotaExceededError` class where
there is one, as Chrome's is. Bytes a partial write put down stay written and charged, and the
specification's other short count is reported the same way, since either way the write did not land.

### `createWritable`

`WebTransportDatagramDuplexStream.createWritable()`, taking the duplex as its first argument, from
`@banou/ponyfill/webtransport` only. Not from the root: `FileSystemFileHandle.createWritable` has the
same name.

```ts
import { createWritable } from '@banou/ponyfill/webtransport'

const writer = createWritable(webtransport.datagrams).getWriter()
```

Measured 2026-10-10, headless, on the duplex prototype in a page and in both kinds of worker, then on a
real `new WebTransport(url).datagrams`:

| | Chromium 149, Chrome 153 | Firefox 151 | Firefox 157 | WebKit 26.0 (Playwright) |
| --- | --- | --- | --- | --- |
| `createWritable()` | absent | absent | present | present |
| `writable` | present | present | present | **absent**, so `writable.getWriter()` throws |

The same day, a real webvpn relay counted what each engine sent through both calls, in a page and in
both workers: 3 of 3 every time on Chromium 149, Chrome 153, Firefox 151 and Firefox 157. Playwright's
WebKit never opened a QUIC session to it on either call, so on WebKit the shape is measured and the
traffic is not, and Safari itself was not run. MDN's compat data (mdn/browser-compat-data `87af662`,
2026-08-26) agrees with the table: `createWritable` from Firefox 155 and Safari 26.4, `writable` never
in Safari. TypeScript's DOM types still declare only
`writable`, which is how the old call compiles everywhere and throws on Safari. fkn.app's WebVPN client
made that call, so every Safari dial failed its WebTransport setup and fell back to the WebSocket.

The native method is used wherever it exists, and the duplex's `writable` otherwise. **The fallback
refuses what it cannot do, at the call**, with `NotSupportedError`: a second writable from the same
duplex, since there is only one stream and two callers would share it, and a `sendGroup` or non-zero
`sendOrder`, since that stream has no priority of its own.

**Firefox 155 and later take the native method**, since they have both: a stream of their own rather
than the shared `writable`. On Firefox 157 a 2000 datagram burst from a shared worker showed no loss
against `writable` in one run (1995 against 1970; Firefox 151 gave 1972 and 2000 on the same `writable`
path).

Two differences the fallback cannot refuse at the call: on a closed or failed transport it returns the
`writable` as it is where the native method throws `InvalidStateError`, since the duplex cannot see
the transport's state, and the stream it returns has no `sendGroup` or `sendOrder` attribute to set
later (the return type does not declare one either).

### `setOutgoingMaxBufferedDatagrams`

`datagrams.outgoingMaxBufferedDatagrams = value`, under whichever name the engine has, from
`@banou/ponyfill/webtransport`. The spec renamed `outgoingHighWaterMark` to it (w3c/webtransport
`5e10b91e`, 2026-02-25): how many datagrams may wait in the sink before a write stops resolving at once.

```ts
import { setOutgoingMaxBufferedDatagrams } from '@banou/ponyfill/webtransport'

setOutgoingMaxBufferedDatagrams(webtransport.datagrams, 256)
```

Measured 2026-10-11, headless, in a page and a shared worker: 2,000 datagrams of 1,009 bytes from a
`createWritable` writer, each write awaited, counted at a local webvpn relay. "Busy" adds a chain of
1 ms tasks on the same event loop.

| | Chromium 149 | Chrome 153 | Firefox 151, 157 | WebKit (Playwright build 2311) |
| --- | --- | --- | --- | --- |
| `outgoingHighWaterMark` | 1 | 1, one field with the new name | 5 | 1 |
| `outgoingMaxBufferedDatagrams` | absent | 1 | absent | absent |
| busy, 2,000 writes at the default / at 256 | 2.0 s / 32 to 39 ms | 2.0 s / 36 to 40 ms | 2.0 s at both | first write pending after 2 s at both |

Chrome 153 files a deprecation report for the old name and none for the new. Firefox never passes the
value to its sink, and Safari 26.4's network process ignores it. WebKit main renamed it (`2db431710a`)
and acts on the new name only (`fc590f3281`), read in source and not run; MDN's compat data has the new
name from Chrome 151 and Safari Technology Preview, which removed the old one.

**The new name wherever the duplex has it, the old one otherwise, never both**: on Chrome 153 they are
one field and the old one files the report. A duplex with neither is refused with `NotSupportedError`,
since the write would only add a plain property. Through this function the busy run took 34 to 41 ms on
Chromium 149 and Chrome 153, 2,000 of 2,000 arrived, and Chrome 153 filed no report.

### `createMediaElementSource`

`AudioContext.createMediaElementSource()`, taking the context as its first argument, from
`@banou/ponyfill/web-audio` only, refused where a routed element stops sounding the way it does
unrouted.

```ts
import { createMediaElementSource } from '@banou/ponyfill/web-audio'

const source = createMediaElementSource(context, video)
```

Measured 2026-10-11, a `<video>` playing a tone through MSE into an `AnalyserNode`, headless and
muted:

| | Chromium 153 | Firefox 151 | WebKit 26.5 (GTK) |
| --- | --- | --- | --- |
| the element's audio reaches the graph | yes | yes | yes |
| its `volume` at 0.5, 0.25 and 0.1 | -6, -12 and -20 dB | the same | ignored |
| its `muted` | silence | silence | ignored |

Safari was not measured. Its MSE player has no audio source provider in WebKit's source, so the graph
would get silence.

**WebKit is refused with a `NotSupportedError`, before the element is touched**, because routing
cannot be undone: Chromium and WebKit refuse a second source for one element, and Chromium stops a
playing element whose context is closed. It is told apart by `navigator.vendor`, which every WebKit
port answers as `Apple Computer, Inc.`; no probe can stand in for it, since the only way to learn how
a routed element behaves is to route it.

### `postMessage`

`Window.postMessage()`, taking the target window as its first argument, from
`@banou/ponyfill/web-messaging` only, so the message carries the sender's window as its `source` on
every engine, wherever the call sits.

```ts
import { postMessage } from '@banou/ponyfill/web-messaging'

iframe.addEventListener('load', () => postMessage(iframe.contentWindow!, { type: 'ask' }, location.origin))
```

Measured 2026-10-26, headless, a page framing one document on its own origin and one on another, the
calls in a module (strict code) and made from a callback the browser itself calls: `setTimeout`, a
`MessagePort`'s `onmessage`, a promise reaction, an iframe's `load` listener. What the receiver read
as `event.source`, page to frame and frame to page alike:

| how the sender calls `target.postMessage(message, origin)` | Chromium 155, Firefox 157 | WebKit 26.4, 26.5 (Playwright) |
| --- | --- | --- |
| a tail call: `() => target.postMessage(...)`, `() => target?.postMessage(...)`, `return target.postMessage(...)` | the sender | **the receiver's own window** |
| the same, to a target on another origin | the sender | the sender |
| a tail call of a helper that tail-calls it | the sender | **the receiver** |
| a statement: `{ target.postMessage(...) }`, `void target.postMessage(...)`, or a statement calling a helper that tail-calls it | the sender | the sender |
| `return target.postMessage(...)` in an async function, before any `await` / after one | the sender | the sender / **the receiver** |
| a tail call in sloppy code, or from the listener of an event a script dispatched | the sender | the sender |
| this function, in any of the positions above | the sender | the sender |

JavaScriptCore runs proper tail calls in strict code, so a tail call takes the caller's frame off the
stack before the platform reads it for the incumbent realm. With no frame of the sender's left, WebKit
lands on the realm of the `postMessage` function itself: the target's for a target on the same
origin, the caller's for one on another, since a cross-origin window hands out its methods in the
caller's realm. A receiver checking `event.source` against the window it expects then drops the
message. Found in stub, whose watch page told its own embed the page was fullscreen from a
`fullscreenchange` listener written `() => iframe.contentWindow?.postMessage(...)`, which the embed
never heard.

**The call is a statement inside this function**, so its frame is on the stack when the platform
reads it, however the caller reaches the function, tail call included. Nothing is detected and every
engine runs the same line.

## Adding to it

If you hit something that behaves differently between engines, or differently from its own
specification, it goes here rather than into the app that found it. State what you measured, on what,
and when, and pin it with a test that fails when the workaround is removed.
