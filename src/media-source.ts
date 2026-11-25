type NativeMediaSource = globalThis.MediaSource
type NativeMediaSourceConstructor = typeof globalThis.MediaSource
type ManagedMediaSourceConstructor = NativeMediaSourceConstructor & {
  readonly prototype: NativeMediaSource & { readonly streaming: boolean }
}
type MediaSourceGlobal = typeof globalThis & {
  MediaSource?: NativeMediaSourceConstructor
  ManagedMediaSource?: ManagedMediaSourceConstructor
}

const native = (): NativeMediaSourceConstructor | undefined => {
  const scope = globalThis as MediaSourceGlobal
  return scope.MediaSource ?? scope.ManagedMediaSource
}

class MediaSourcePonyfill {
  // set, and not left to a declaration: a consumer's minifier renames the class, and `name` went with it
  static { Object.defineProperty(this, 'name', { value: 'MediaSource' }) }

  static isTypeSupported(type: string): boolean {
    const Ctor = native()
    return typeof Ctor?.isTypeSupported === 'function' ? Ctor.isTypeSupported(type) : false
  }

  static get canConstructInDedicatedWorker(): boolean {
    const Ctor = native() as (NativeMediaSourceConstructor & { canConstructInDedicatedWorker?: boolean }) | undefined
    return Boolean(Ctor?.canConstructInDedicatedWorker)
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    const scope = globalThis as MediaSourceGlobal
    return (
      (typeof scope.MediaSource === 'function' && value instanceof scope.MediaSource) ||
      (typeof scope.ManagedMediaSource === 'function' && value instanceof scope.ManagedMediaSource)
    )
  }

  constructor() {
    const Ctor = native()
    if (typeof Ctor !== 'function') {
      throw new DOMException('this browser has no MediaSource or ManagedMediaSource', 'NotSupportedError')
    }
    return new Ctor() as unknown as MediaSourcePonyfill
  }
}

/**
 * `MediaSource`, the platform's class under the platform's name, falling back to
 * `ManagedMediaSource` where `MediaSource` is absent (iPhone WebKit since iOS 17.1). Exported from
 * the root or from `@banou/ponyfill/media-source`.
 *
 * ## What was measured, on what, and when
 *
 * 2026-11-25, one Linux machine, headless and muted: Chrome 156, Firefox 157.0, and WebKit
 * 26.5 in Playwright's container (`https://rig.test/` origin):
 *
 * | | Chrome 156 | Firefox 157 | WebKit 26.5 (Playwright) |
 * | --- | --- | --- | --- |
 * | `MediaSource` | present | present | present |
 * | `ManagedMediaSource` | absent | absent | present (`instanceof MediaSource` true) |
 * | `MediaSource.canConstructInDedicatedWorker` | `true` | absent | absent |
 * | `URL.createObjectURL(source)` opens `sourceopen` | yes | yes | yes (with HTTPS origin; fails with error code 4 on `null` origin) |
 * | `video.srcObject = source` | throws `TypeError` | throws `TypeError` | opens `sourceopen` |
 * | `video.disableRemotePlayback` | `true` (`boolean`) | absent | absent |
 *
 * Documented by WebKit and not run here (no iOS device on this bench): iOS Safari 17.1+ on iPhone
 * omits `MediaSource` and exposes only `ManagedMediaSource`. Attaching a `ManagedMediaSource` on
 * iOS Safari also requires `video.disableRemotePlayback = true` (or a secondary AirPlay `<source>`)
 * before assigning the source, or `sourceopen` does not fire; that stays on the caller that owns
 * the media element, and `'streaming' in source` detects when a `ManagedMediaSource` was returned.
 *
 * ## The pick
 *
 * Reads `globalThis.MediaSource ?? globalThis.ManagedMediaSource` dynamically on each static call
 * and construction (never cached at module load so test stubs and runtime codec filters still apply),
 * returning a native `MediaSource` or `ManagedMediaSource` instance. `isTypeSupported` returns
 * `false` when neither exists, and `new MediaSource()` throws `NotSupportedError` (a worker without
 * MSE, Node).
 *
 * What it does not do: because the constructor resolves globals on each call, `MediaSource.prototype`
 * is not the platform prototype, and subclassing `class Custom extends MediaSource {}` returns a
 * native instance without subclass methods.
 */
export type MediaSource = NativeMediaSource
export const MediaSource: NativeMediaSourceConstructor = MediaSourcePonyfill as unknown as NativeMediaSourceConstructor
