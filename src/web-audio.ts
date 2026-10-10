/**
 * `AudioContext.createMediaElementSource()`, taking the context first, refused where a routed element
 * stops sounding the way it does unrouted. Exported from `@banou/ponyfill/web-audio` only, as a method
 * of an object the caller holds (see the root entry).
 *
 * ## What was measured, on what, and when
 *
 * 2026-10-11, one machine, headless and muted: a `<video>` playing a 440 Hz tone through MSE, routed
 * into an `AudioContext` and read by an `AnalyserNode` behind a zero gain.
 *
 * | | Chromium 153 | Firefox 151 | WebKit 26.5 (GTK) |
 * | --- | --- | --- | --- |
 * | the element's audio reaches the graph | yes | yes | yes |
 * | its `volume` at 0.5, 0.25 and 0.1 | -6, -12 and -20 dB | the same | ignored: 0 dB at each |
 * | its `muted` | silence | silence | ignored: full level |
 * | `navigator.vendor` | `Google Inc.` | empty | `Apple Computer, Inc.` |
 *
 * Read in WebKit's source and NOT measured, since no Safari runs here: Safari's MSE player
 * (`MediaPlayerPrivateMediaSourceAVFObjC`) has no audio source provider at all, so the graph gets
 * silence, and its file player applies `volume` to the tap but not `muted`.
 *
 * ## The pick
 *
 * Refused on WebKit with a `NotSupportedError`, before the element is touched. Routing cannot be
 * undone: Chromium and WebKit refuse a second source for one element, and Chromium stops a playing
 * element whose context is closed. So the refusal has to come first, or the element is left playing
 * at full level through its own mute button, or into a graph that hears nothing.
 *
 * WebKit is told apart by `navigator.vendor`, which HTML restricts to three fixed strings and which
 * every WebKit port answers as `Apple Computer, Inc.`. No probe can stand in for it, because the only
 * way to learn how a routed element behaves is to route it.
 */
export const createMediaElementSource = (
  context: AudioContext,
  mediaElement: HTMLMediaElement,
): MediaElementAudioSourceNode => {
  if ((globalThis.navigator as Navigator | undefined)?.vendor === 'Apple Computer, Inc.') {
    throw new DOMException(
      'A media element routed into Web Audio loses its volume and mute, or its sound, in this engine',
      'NotSupportedError',
    )
  }
  return context.createMediaElementSource(mediaElement)
}
