// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ContextIntegration } from '../../core/context/coreIntegration'
import {
  createOwnWindowProvider,
  createSystemWindowProvider,
  OWN_WINDOW_PROVIDER_ID,
  SYSTEM_WINDOW_OBSERVATION_GAP,
} from '../../electron/context/windowProviders'
import {
  createWindowObservationRuntime,
} from '../../electron/context/windowObservationRuntime'
import { T0, conversation, sequencedStore } from '../core/context/fixture'
import { FakeActiveWindowProvider } from '../core/context/window/fakeProvider'

/**
 * THE HOST LANE — providers, opt-in runtime, and the bounds that make the
 * safety claims checkable rather than courteous.
 *
 * The second half of this file does what `contextBridge.test.ts` does for the
 * transport: it reads the lane's own source text and asserts what the files
 * cannot contain. A comment-then-code distinction matters here — several arms
 * *explain in prose* exactly which capture abilities they refuse, and prose
 * must not be able to satisfy or fail an assertion about the code, so
 * comments are stripped before the scan.
 */

const LANE_ROOT = new URL('../../core/context/sources/window/', import.meta.url)
const LANE_ELECTRON = new URL('../../electron/context/', import.meta.url)

function listTs(dir: URL): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
}

// Mirror `contextBridge.test.ts`: comments are removed line-wise because
// several lane arms explain in prose exactly which capture APIs they refuse,
// and prose must not be able to satisfy or fail an assertion about the code.
function stripComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

const FORBIDDEN_CAPTURE = [
  /desktopCapturer/,
  /capturePage/,
  /nativeImage/,
  /toDataURL/,
  /toPNG/,
  /screenshot/i,
  /screencapture/i,
  /\bOCR\b/,
  /accessibility/i,
  /globalShortcut/,
  /uiohook/i,
  /robotjs/i,
  /clipboard/i,
  /keyboard/i,
  /mouse/i,
  /SetWinEventHook/,
  /GetForegroundWindow/,
  /CGSGetFrontmostApplication/,
  /NSWorkspace/,
  /osascript/,
  /getMediaSourceId/,
  /getDisplayMedia/,
]

const FORBIDDEN_RENDERER_AUTHORITY = [
  /ipcMain/,
  /ipcRenderer/,
  /contextBridge/,
  /exposeInMainWorld/,
  /webContents/,
]

function laneFiles(): { path: string; code: string; raw: string }[] {
  const files: { path: string; code: string; raw: string }[] = []
  for (const dir of [LANE_ROOT, LANE_ELECTRON]) {
    for (const name of listTs(dir)) {
      const url = new URL(name, dir)
      const raw = readFileSync(url, 'utf8')
      files.push({ path: `${dir.href}${name}`, code: stripComments(raw), raw })
    }
  }
  return files
}

describe('the lane contains no capture and no hands', () => {
  const files = laneFiles()

  it('covers every source file under the two lane directories', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)
  })

  for (const file of files) {
    it(`${file.path.slice(file.path.lastIndexOf('/') + 1)} names no capture API, no input device, no native hook`, () => {
      for (const pattern of FORBIDDEN_CAPTURE) {
        expect(file.code, `${file.path} matches ${pattern}`).not.toMatch(pattern)
      }
    })

    it(`${file.path.slice(file.path.lastIndexOf('/') + 1)} reaches no renderer and registers no IPC`, () => {
      for (const pattern of FORBIDDEN_RENDERER_AUTHORITY) {
        expect(file.code, `${file.path} matches ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('the core lane imports nothing but its own relative files', () => {
    for (const file of files) {
      if (!file.path.includes('/sources/window/')) continue
      for (const match of file.code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? ''
        expect(specifier.startsWith('.'), `${file.path} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('the whole lane is synchronous — a lane that cannot await cannot call a model', () => {
    for (const file of files) {
      expect(file.code, `${file.path} contains async`).not.toMatch(/\basync\b|\bawait\b|\bthen\(/)
    }
  })

  it('only the injected timer factory mentions setInterval, and only once', () => {
    const mentions = files
      .map((f) => (f.code.match(/setInterval/g) ?? []).length)
      .reduce((total, n) => total + n, 0)
    expect(mentions).toBe(1)
  })

  it('no lane file imports Electron except the read-only window source', () => {
    for (const file of files) {
      if (file.path.endsWith('electronWindowSource.ts')) continue
      expect(file.code, `${file.path} imports electron`).not.toMatch(/from ['"]electron['"]/)
    }
  })

  it('the Electron glue touches exactly the two read-only own-window facts', () => {
    const glue = files.find((f) => f.path.endsWith('electronWindowSource.ts'))
    if (glue === undefined) throw new Error('the glue file must exist')
    const names = [...glue.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]electron['"]/g)]
    expect(names.map((m) => (m[1] ?? '').split(',').map((p) => p.trim()).sort().join(','))).toEqual([
      'BrowserWindow,app',
    ])
    expect(glue.code).toMatch(/BrowserWindow\.getFocusedWindow\(\)/)
    expect(glue.code).toMatch(/app\.getName\(\)/)
  })

  it('the transport lane and the renderer were not touched by this capture lane', () => {
    const untouched = ['../../electron/preload.ts', '../../electron/main.ts', '../../electron/coreHost.ts']
    for (const rel of untouched) {
      const source = stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
      expect(source, rel).not.toMatch(
        /windowObservation|windowProviders|WindowObservation|active_window|sources\/window/i,
      )
    }
    const walk = (dir: URL): URL[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) return walk(new URL(`${entry.name}/`, dir))
        return /\.(ts|tsx)$/.test(entry.name) ? [new URL(entry.name, dir)] : []
      })
    for (const url of walk(new URL('../../src/', import.meta.url))) {
      const source = readFileSync(url, 'utf8')
      expect(source, url.pathname).not.toMatch(/active_window|WindowObservationService|sources\/window/)
    }
  })
})

describe('the own-window provider states what plain Electron can honestly see', () => {
  function source(focused: string | null, name = 'Freya') {
    const reads: string[] = []
    return {
      reads,
      displayName: () => {
        reads.push('name')
        return name
      },
      focusedWindowTitle: () => {
        reads.push('title')
        return focused
      },
    }
  }

  it('reports a focused Freya window with bounded own-app identity', () => {
    const provider = createOwnWindowProvider(source('notes.md — Freya'), {
      newObservationId: () => 'own-fixed',
    })
    expect(provider.providerId).toBe(OWN_WINDOW_PROVIDER_ID)
    expect(provider.reach).toBe('own-app')
    expect(provider.availability()).toBe('ready')
    const reading = provider.read(T0)
    expect(reading.availability).toBe('ready')
    expect(reading.window).toMatchObject({
      providerId: OWN_WINDOW_PROVIDER_ID,
      observationId: 'own-fixed',
      observedAt: T0.toISOString(),
      reach: 'own-app',
      appName: 'Freya',
      windowTitle: 'notes.md — Freya',
    })
  })

  it('says there is nothing when no Freya window is focused, and never reaches further', () => {
    const provider = createOwnWindowProvider(source(null))
    const reading = provider.read(T0)
    expect(reading.availability).toBe('unavailable')
    expect(reading.window).toBeNull()
    expect(reading.reason).toMatch(/no Freya window is focused/)
  })

  it('mints a fresh observation id per reading by default', () => {
    const provider = createOwnWindowProvider(source('a'))
    const first = provider.read(T0).window?.observationId
    const second = provider.read(T0).window?.observationId
    expect(first).not.toBe(second)
  })

  it('the system provider says it cannot, in its exact stated words', () => {
    const provider = createSystemWindowProvider()
    expect(provider.reach).toBe('system')
    expect(provider.availability()).toBe('unsupported')
    expect(provider.read(T0)).toEqual({
      availability: 'unsupported',
      window: null,
      reason: SYSTEM_WINDOW_OBSERVATION_GAP,
    })
    expect(provider.subscribe).toBeUndefined()
  })
})

describe('the opt-in runtime', () => {
  it('does nothing at all when disabled — the provider is never even asked', () => {
    const provider = new FakeActiveWindowProvider()
    provider.queue(provider.info('Editor', 'notes.md', T0.toISOString()))
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const runtime = createWindowObservationRuntime({
      enabled: false,
      provider,
      sink: store,
      scope: conversation('c1'),
      clock: () => T0,
      timer: null,
    })
    expect(runtime.enabled).toBe(false)
    expect(runtime.start()).toBe('disabled')
    runtime.poll()
    expect(runtime.status()).toBe('disabled')
    expect(runtime.current()).toBeNull()
    expect(runtime.stats()).toMatchObject({ started: false, polls: 0, readings: 0 })
    expect(provider.calls).toEqual({ availability: 0, reads: 0, subscribe: 0, unsubscribe: 0 })
    expect(store.retained).toBe(0)
    expect(store.list(T0)).toEqual([])
  })

  it('observes, admits, supersedes, and expires across the whole chain when enabled', () => {
    const provider = new FakeActiveWindowProvider({ providerId: 'host-observer' })
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const runtime = createWindowObservationRuntime({
      enabled: true,
      provider,
      sink: store,
      scope: conversation('c1'),
      clock: () => T0,
      timer: null,
    })

    provider.queue(provider.info('Code Editor', 'notes.md', T0.toISOString()))
    expect(runtime.start()).toBe('observed')
    const first = store.list(T0).find((item) => item.kind === 'active_window')
    expect(first?.provenance.originId).toBe('host-observer:obs-0001')

    provider.queue(provider.info('Browser', 'Search', T0.toISOString()))
    runtime.poll()
    const live = store.list(T0).filter((item) => item.kind === 'active_window')
    expect(live).toHaveLength(1)
    expect(live[0]?.label).toMatch(/Browser/)
    expect(runtime.current()?.appName).toBe('Browser')
    expect(runtime.stats().emitted).toBe(2)
    expect(store.tombstones(T0).some((row) => row.state === 'revoked')).toBe(true)
  })

  it('admits through the merged Core facade lane when that door is the one wired', () => {
    const provider = new FakeActiveWindowProvider({ providerId: 'host-observer' })
    let next = 0
    const core = new ContextIntegration({
      now: () => T0,
      newId: () => {
        next += 1
        return `x-${String(next)}`
      },
    })
    core.activateScope(conversation('c1'))
    const runtime = createWindowObservationRuntime({
      enabled: true,
      provider,
      lane: core,
      scope: conversation('c1'),
      clock: () => T0,
      timer: null,
    })

    provider.queue(provider.info('Code Editor', 'notes.md', T0.toISOString()))
    expect(runtime.start()).toBe('observed')
    const view = core.read()
    expect(view.counts.live).toBe(1)
    const row = view.items.find((item) => item.kind === 'active_window')
    expect(row?.source).toBe('host_report')
    expect(row?.originId).toBe('host-observer:obs-0001')

    provider.queue(provider.info('Browser', 'Search', T0.toISOString()))
    runtime.poll()
    expect(core.read().counts.live).toBe(1)
    expect(core.read().counts.retained).toBe(2)
    expect(core.read().items.find((item) => item.state === 'revoked')?.contextId).toBeDefined()
  })
})
