import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

// vite-plus bundles its own vitest and ships vite as vite-plus-core, and its docs require a project to
// pin both to the same release ("Updating the Vitest Pin" at viteplus.dev). A pin left behind on a
// vite-plus bump keeps installing the previous runner. Until 2026-09-25 this repo had no overrides at
// all, so vitest's own vite dependency installed upstream vite 8.2.2, with its own rolldown, next to
// vite-plus-core. Reads only the manifest and the lockfile, so it holds from a bare checkout.
const ROOT = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))

type LockEntry = { name?: string; version: string; dependencies?: Record<string, string> }

const installed = (pattern: RegExp): [string, LockEntry][] =>
  Object.entries(lock.packages as Record<string, LockEntry>).filter(([path]) => pattern.test(path))

describe('the vite-plus toolchain is pinned as one release', () => {
  const vitePlus = lock.packages['node_modules/vite-plus'] as LockEntry
  const core = `npm:@voidzero-dev/vite-plus-core@${vitePlus.version}`

  it('the vite alias names the core of the installed vite-plus, everywhere npm reads it', () => {
    expect(manifest.devDependencies['vite-plus']).toBe(vitePlus.version)
    expect(manifest.devDependencies.vite).toBe(core)
    expect(manifest.overrides?.vite).toBe(core)
    const vites = installed(/(^|\/)node_modules\/vite$/).map(([, e]) => `${e.name}@${e.version}`)
    expect(vites).toEqual([`@voidzero-dev/vite-plus-core@${vitePlus.version}`])
  })

  it('the vitest pin is the vitest vite-plus itself depends on, and so is the direct one', () => {
    expect(vitePlus.dependencies?.vitest).toBeDefined()
    expect(manifest.overrides?.vitest).toBe(vitePlus.dependencies?.vitest)
    expect(manifest.devDependencies.vitest).toBe(manifest.overrides?.vitest)
  })

  it('one vitest is installed, and every @vitest package is at the pinned version', () => {
    const copies = installed(/(^|\/)node_modules\/(vitest|@vitest\/[^/]+)$/)
    const vacuous = 'the scan found no vitest at all, so it proves nothing'
    expect(copies.length, vacuous).toBeGreaterThan(1)
    const off = copies
      .filter(([, entry]) => entry.version !== manifest.overrides?.vitest)
      .map(([path, entry]) => `${path}@${entry.version}`)
    expect(off).toEqual([])
    expect(copies.filter(([path]) => path.endsWith('node_modules/vitest'))).toHaveLength(1)
  })
})
