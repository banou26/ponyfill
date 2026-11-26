/**
 * `Element.requestFullscreen()` and `Document.exitFullscreen()`, taking the target element or
 * document first, from `@banou/ponyfill/fullscreen` only. Falls back to WebKit's `<video>`
 * presentation and fullscreen APIs when the Fullscreen API is unavailable or disabled on the
 * document (iPhone iOS Safari).
 *
 * ## What was measured, on what, and when
 *
 * 2026-11-26, headless, across Chrome 156, Firefox 157, and WebKit 26.5 in Playwright's container
 * (`<video playsinline muted>`):
 *
 * | | Chrome 156 | Firefox 157 | WebKit 26.5 (Playwright) |
 * | --- | --- | --- | --- |
 * | `document.fullscreenEnabled` | `true` | `true` | `true` |
 * | `Element.prototype.requestFullscreen` | present | present | present |
 * | `video.webkitSetPresentationMode` | absent | absent | absent |
 * | `video.webkitEnterFullscreen` / `webkitExitFullscreen` | absent | absent | present |
 * | `video.webkitDisplayingFullscreen` / `webkitSupportsFullscreen` | absent | absent | `false` before metadata, `true` support after |
 *
 * Documented by WebKit (`HTMLVideoElement.idl`, `HTMLVideoElement.cpp`) and MDN `browser-compat-data`,
 * not measured on real iPhone hardware here: iPhone iOS Safari leaves `document.fullscreenEnabled` and
 * `document.webkitFullscreenEnabled` `false` for non-video elements while supporting native video
 * fullscreen on `<video>` via `webkitSetPresentationMode('fullscreen')` (where enabled) and
 * `webkitEnterFullscreen()` / `webkitEnterFullScreen()`, and exiting via
 * `webkitSetPresentationMode('inline')` or `webkitExitFullscreen()` / `webkitExitFullScreen()`.
 * Entering video fullscreen via those methods does not populate `document.fullscreenElement`, so
 * `document.exitFullscreen()` rejects instead of leaving fullscreen.
 *
 * ## The pick
 *
 * `requestFullscreen(element, options?)` calls `element.requestFullscreen` (or
 * `webkitRequestFullscreen`) synchronously when the document allows element fullscreen, falling back
 * on `<video>` to `webkitSetPresentationMode('fullscreen')` (when `webkitSupportsPresentationMode`
 * allows it) or `webkitEnterFullscreen()` / `webkitEnterFullScreen()` synchronously inside the user
 * gesture. Non-video elements where document fullscreen is disabled reject loudly with
 * `NotSupportedError`. `exitFullscreen(doc, fallbackElement?)` exits WebKit presentation or video
 * fullscreen before delegating to `doc.exitFullscreen()`, and also tracks videos entered inside
 * shadow roots via a per-document `WeakRef` or `fallbackElement`. `fullscreenEnabled(doc, element?)`
 * checks document support or whether `element` supports WebKit `<video>` fullscreen, and
 * `fullscreenElement(doc, fallbackElement?)` returns the active document or WebKit video fullscreen
 * element.
 */

type WebKitPresentationMode = 'inline' | 'fullscreen' | 'picture-in-picture'

type WebKitDocument = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

type WebKitFullscreenElement = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type WebKitVideoElement = Element & {
  webkitPresentationMode?: WebKitPresentationMode
  webkitSupportsPresentationMode?: (mode: WebKitPresentationMode) => boolean
  webkitSetPresentationMode?: (mode: WebKitPresentationMode) => void
  webkitDisplayingFullscreen?: boolean
  webkitSupportsFullscreen?: boolean
  readyState?: number
  webkitEnterFullscreen?: () => void
  webkitEnterFullScreen?: () => void
  webkitExitFullscreen?: () => void
  webkitExitFullScreen?: () => void
}

// Tracks the video entered via WebKit fallback per document so `exitFullscreen(doc)` finds videos inside shadow roots.
const webkitFullscreenVideos = new WeakMap<Document, WeakRef<WebKitVideoElement>>()

const trackWebKitVideo = (doc: Document | undefined, video: WebKitVideoElement) => {
  if (doc) webkitFullscreenVideos.set(doc, new WeakRef(video))
}

const isWebKitVideoFullscreen = (video: WebKitVideoElement) =>
  video.webkitPresentationMode === 'fullscreen' || video.webkitDisplayingFullscreen === true

const supportsWebKitVideoFullscreen = (video: WebKitVideoElement): boolean => {
  if (
    typeof video.webkitSetPresentationMode === 'function'
    && (typeof video.webkitSupportsPresentationMode !== 'function' || video.webkitSupportsPresentationMode('fullscreen'))
  ) {
    return true
  }
  const enter = video.webkitEnterFullscreen ?? video.webkitEnterFullScreen
  if (typeof enter !== 'function') return false
  // Before metadata (`readyState === 0`), WebKit leaves `webkitSupportsFullscreen` false even on playable videos.
  if (typeof video.readyState === 'number' && video.readyState > 0 && video.webkitSupportsFullscreen === false) return false
  return true
}

const findWebKitFullscreenVideo = (doc: Document, fallbackElement?: Element | null): WebKitVideoElement | undefined => {
  if (fallbackElement && isWebKitVideoFullscreen(fallbackElement as WebKitVideoElement)) {
    return fallbackElement as WebKitVideoElement
  }
  const tracked = webkitFullscreenVideos.get(doc)?.deref()
  if (tracked && isWebKitVideoFullscreen(tracked)) return tracked
  if (typeof doc.querySelectorAll === 'function') {
    for (const candidate of doc.querySelectorAll('video')) {
      const video = candidate as WebKitVideoElement
      if (isWebKitVideoFullscreen(video)) return video
    }
  }
  return undefined
}

const rejectError = (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error)))

const tryResolve = (fn: () => Promise<void> | void): Promise<void> => {
  try {
    return Promise.resolve(fn())
  } catch (error) {
    return rejectError(error)
  }
}

const tryVideoFallback = (element: Element, doc: Document | undefined): Promise<void> | undefined => {
  const video = element as WebKitVideoElement
  const enter = video.webkitEnterFullscreen ?? video.webkitEnterFullScreen

  if (typeof video.webkitSetPresentationMode === 'function') {
    const supported =
      typeof video.webkitSupportsPresentationMode !== 'function'
      || video.webkitSupportsPresentationMode('fullscreen')
    if (supported) {
      try {
        video.webkitSetPresentationMode('fullscreen')
        trackWebKitVideo(doc, video)
        return Promise.resolve()
      } catch (error) {
        if (typeof enter !== 'function') return rejectError(error)
      }
    }
  }

  if (typeof enter === 'function') {
    return tryResolve(() => {
      enter.call(video)
      trackWebKitVideo(doc, video)
    })
  }

  return undefined
}

const tryElementRequest = (
  invoke: () => Promise<void> | void,
  element: Element,
  doc: Document,
): Promise<void> => {
  try {
    // Asynchronous fallback runs in a microtask, whereas the disabled-fullscreen iPhone path runs synchronously.
    return Promise.resolve(invoke()).catch((error) => tryVideoFallback(element, doc) ?? rejectError(error))
  } catch (error) {
    return tryVideoFallback(element, doc) ?? rejectError(error)
  }
}

/**
 * Reports whether fullscreen is usable on `doc`, falling back to WebKit `<video>` fullscreen only
 * when `element` itself supports it (never probing an offscreen `<video>` and returning `false` for
 * elements without WebKit `<video>` fullscreen APIs when `doc.fullscreenEnabled` is `false`).
 */
export const fullscreenEnabled = (doc: Document, element?: Element | null): boolean => {
  const webkitDoc = doc as WebKitDocument
  if (webkitDoc.fullscreenEnabled || webkitDoc.webkitFullscreenEnabled) return true
  return element ? supportsWebKitVideoFullscreen(element as WebKitVideoElement) : false
}

/**
 * Returns the active fullscreen element on `doc`, including a WebKit native `<video>` fullscreen
 * element (and an optional `fallbackElement` inside a shadow root when `doc.fullscreenElement` is null).
 */
export const fullscreenElement = (doc: Document, fallbackElement?: Element | null): Element | null => {
  const webkitDoc = doc as WebKitDocument
  return (
    webkitDoc.fullscreenElement
    ?? webkitDoc.webkitFullscreenElement
    ?? findWebKitFullscreenVideo(doc, fallbackElement)
    ?? null
  )
}

/**
 * Requests fullscreen for `element`, falling back to WebKit's `<video>` presentation/fullscreen APIs
 * when document fullscreen is disabled (iPhone Safari) or the container request is rejected on a video.
 * Not marked `async` so WebKit fallback methods run synchronously inside the user's activation turn.
 */
export const requestFullscreen = (element: Element, options?: FullscreenOptions): Promise<void> => {
  const doc = (element.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined)) as WebKitDocument | undefined

  if (doc && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
    const el = element as WebKitFullscreenElement
    if (typeof el.requestFullscreen === 'function') {
      return tryElementRequest(() => (options === undefined ? el.requestFullscreen!() : el.requestFullscreen!(options)), element, doc)
    }
    if (typeof el.webkitRequestFullscreen === 'function') {
      return tryElementRequest(() => el.webkitRequestFullscreen!(), element, doc)
    }
  }

  return (
    tryVideoFallback(element, doc)
    ?? Promise.reject(new DOMException('Fullscreen is not supported on this element.', 'NotSupportedError'))
  )
}

/**
 * Exits active fullscreen on `doc`, exiting active element fullscreen via the document first and
 * handling WebKit's `<video>` presentation/fullscreen state (including an optional shadow-DOM
 * `fallbackElement`) when `document.fullscreenElement` is null so `document.exitFullscreen()` is
 * not called on an inactive document.
 */
export const exitFullscreen = (doc: Document, fallbackElement?: Element | null): Promise<void> => {
  const webkitDoc = doc as WebKitDocument

  if (webkitDoc.fullscreenElement && typeof webkitDoc.exitFullscreen === 'function') {
    return tryResolve(() => webkitDoc.exitFullscreen!())
  }

  if (webkitDoc.webkitFullscreenElement && typeof webkitDoc.webkitExitFullscreen === 'function') {
    return tryResolve(() => webkitDoc.webkitExitFullscreen!())
  }

  const video = findWebKitFullscreenVideo(doc, fallbackElement)
  if (video) {
    const exitVideo = video.webkitExitFullscreen ?? video.webkitExitFullScreen
    if (video.webkitPresentationMode === 'fullscreen' && typeof video.webkitSetPresentationMode === 'function') {
      try {
        video.webkitSetPresentationMode('inline')
        return Promise.resolve()
      } catch (error) {
        if (video.webkitDisplayingFullscreen && typeof exitVideo === 'function') {
          return tryResolve(() => exitVideo.call(video))
        }
        return rejectError(error)
      }
    }
    if (video.webkitDisplayingFullscreen && typeof exitVideo === 'function') {
      return tryResolve(() => exitVideo.call(video))
    }
  }

  if (typeof webkitDoc.exitFullscreen === 'function') {
    return tryResolve(() => webkitDoc.exitFullscreen!())
  }

  if (typeof webkitDoc.webkitExitFullscreen === 'function') {
    return tryResolve(() => webkitDoc.webkitExitFullscreen!())
  }

  return Promise.reject(new DOMException('Exiting fullscreen is not supported on this document.', 'NotSupportedError'))
}
