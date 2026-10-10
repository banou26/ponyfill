import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { createMediaElementSource } from '../src/web-audio'

afterEach(() => { vi.unstubAllGlobals() })

const fakeContext = () => {
  const routed: unknown[] = []
  const node = { kind: 'source' }
  const context = {
    createMediaElementSource: (element: unknown) => { routed.push(element); return node },
  } as unknown as AudioContext
  return { context, routed, node }
}

const element = {} as HTMLMediaElement

describe('createMediaElementSource', () => {
  it('hands the platform its own node where a routed element keeps its volume and mute', () => {
    for (const vendor of ['Google Inc.', '']) {
      vi.stubGlobal('navigator', { vendor })
      const { context, routed, node } = fakeContext()
      expect(createMediaElementSource(context, element)).toBe(node)
      expect(routed).toEqual([element])
    }
  })

  it('refuses WebKit before the element is touched, since routing cannot be undone', () => {
    vi.stubGlobal('navigator', { vendor: 'Apple Computer, Inc.' })
    const { context, routed } = fakeContext()
    expect(() => createMediaElementSource(context, element)).toThrow(expect.objectContaining({ name: 'NotSupportedError' }))
    expect(routed).toEqual([])
  })

  it('delegates where there is no navigator to ask', () => {
    vi.stubGlobal('navigator', undefined)
    const { context, routed } = fakeContext()
    createMediaElementSource(context, element)
    expect(routed).toEqual([element])
  })
})
