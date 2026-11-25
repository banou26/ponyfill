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
 * `NotSupportedError`. `exitFullscreen(doc)` exits WebKit presentation or video fullscreen before
 * delegating to `doc.exitFullscreen()`, and also tracks videos entered inside shadow roots via a
 * per-document `WeakRef`.
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

const findWebKitFullscreenVideo = (doc: Document): WebKitVideoElement | undefined => {
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
        if (typeof enter !== 'function') return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  if (typeof enter === 'function') {
    try {
      enter.call(video)
      trackWebKitVideo(doc, video)
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return undefined
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
      try {
        const result = options === undefined ? el.requestFullscreen() : el.requestFullscreen(options)
        // Asynchronous fallback runs in a microtask, whereas the disabled-fullscreen iPhone path runs synchronously above.
        return Promise.resolve(result).catch((error) => tryVideoFallback(element, doc) ?? Promise.reject(error))
      } catch (error) {
        return tryVideoFallback(element, doc) ?? Promise.reject(error)
      }
    }
    if (typeof el.webkitRequestFullscreen === 'function') {
      try {
        const result = el.webkitRequestFullscreen()
        return Promise.resolve(result).catch((error) => tryVideoFallback(element, doc) ?? Promise.reject(error))
      } catch (error) {
        return tryVideoFallback(element, doc) ?? Promise.reject(error)
      }
    }
  }

  return (
    tryVideoFallback(element, doc)
    ?? Promise.reject(new DOMException('Fullscreen is not supported on this element.', 'NotSupportedError'))
  )
}

const rejectError = (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error)))

/**
 * Exits active fullscreen on `doc`, exiting active element fullscreen via the document first and
 * handling WebKit's `<video>` presentation/fullscreen state when `document.fullscreenElement` is null
 * so `document.exitFullscreen()` is not called on an inactive document.
 */
export const exitFullscreen = (doc: Document): Promise<void> => {
  const webkitDoc = doc as WebKitDocument

  if (webkitDoc.fullscreenElement && typeof webkitDoc.exitFullscreen === 'function') {
    try {
      return Promise.resolve(webkitDoc.exitFullscreen())
    } catch (error) {
      return rejectError(error)
    }
  }

  if (webkitDoc.webkitFullscreenElement && typeof webkitDoc.webkitExitFullscreen === 'function') {
    try {
      return Promise.resolve(webkitDoc.webkitExitFullscreen())
    } catch (error) {
      return rejectError(error)
    }
  }

  const video = findWebKitFullscreenVideo(doc)

  if (video && video.webkitPresentationMode === 'fullscreen' && typeof video.webkitSetPresentationMode === 'function') {
    try {
      video.webkitSetPresentationMode('inline')
      return Promise.resolve()
    } catch (error) {
      const exitVideo = video.webkitExitFullscreen ?? video.webkitExitFullScreen
      if (video.webkitDisplayingFullscreen && typeof exitVideo === 'function') {
        try {
          exitVideo.call(video)
          return Promise.resolve()
        } catch (fallbackError) {
          return rejectError(fallbackError)
        }
      }
      return rejectError(error)
    }
  }

  if (video && video.webkitDisplayingFullscreen) {
    const exitVideo = video.webkitExitFullscreen ?? video.webkitExitFullScreen
    if (typeof exitVideo === 'function') {
      try {
        exitVideo.call(video)
        return Promise.resolve()
      } catch (error) {
        return rejectError(error)
      }
    }
  }

  if (typeof webkitDoc.exitFullscreen === 'function') {
    try {
      return Promise.resolve(webkitDoc.exitFullscreen())
    } catch (error) {
      return rejectError(error)
    }
  }

  if (typeof webkitDoc.webkitExitFullscreen === 'function') {
    try {
      return Promise.resolve(webkitDoc.webkitExitFullscreen())
    } catch (error) {
      return rejectError(error)
    }
  }

  return Promise.reject(new DOMException('Exiting fullscreen is not supported on this document.', 'NotSupportedError'))
}
