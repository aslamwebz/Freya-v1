// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ContextSurface } from '../../src/ui/surfaces/ContextSurface'
import { contextMirror, resetContextMirror } from '../../src/platform/contextClient'
import { ContextChannel, ElectronCoreHost } from '../../electron/coreHost'
import { FakeModelProvider } from '../../core/model/fake-provider'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextProjection,
} from '../../core/protocol/context'
import { CONTEXT_REFUSAL_TEXT } from '../../core/context/types'
import { explicitSelectionAdmission } from '../../core/context/adapters/explicit-selection'
import { authorizedProjectAdmission } from '../../core/context/adapters/project-file'
import { sharedTabAdmission } from '../../core/context/adapters/tab-media'
import { T0, at, sessionScope } from '../core/context/fixture'
import {
  CHAIN_SECRET,
  admitVia,
  chainReportingCore,
  chainSeam,
  chainStore,
} from '../core/context/chain-harness'

/**
 * THE CHAIN, ACROSS THE ELECTRON BOUNDARY AND INTO THE WINDOW.
 *
 * `chain-acceptance.test.ts` proves the domain half: an explicit source
 * becomes a held item, references resolve or refuse, and a projection is
 * built. This file picks that projection up on the far side of the transport
 * and drives it through the pieces a real window is given:
 *
 *   ContextChannel → window.freyaHost.coreContext / onCoreContext
 *     → contextMirror() → <ContextSurface />
 *
 * The bridge here is wired exactly as `electron/main.ts` wires it — `pull` is
 * the `ipcMain.handle('freya:core:context', …)` answer, `on` is the
 * `webContents.send(...)` push — and the source-reading test below asserts
 * that the preload door a window can reach is these two reads and nothing
 * else. What is *not* wired is #27's Core facade, which has not merged; the
 * channel's reporting half therefore comes from `chain-harness.ts`, the same
 * stand-in `tests/host/contextBridge.test.ts` uses, and the honest production
 * end state (a live Core that reports no Context) is asserted separately with
 * a real `ElectronCoreHost`.
 *
 * Every assertion is on survival or on absence: the window's DOM says what the
 * store said, the private part says nothing at all, and there is no control,
 * no command and no argument anywhere in the lane a renderer can aim.
 */

let channel: ContextChannel
let coreSubmit: ReturnType<typeof vi.fn>
let hosts: ElectronCoreHost[] = []
let dirs: string[] = []

beforeEach(() => {
  resetContextMirror()
  channel = new ContextChannel()
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: false }))
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreContext: (async () => channel.pull()) as never,
    onCoreContext: ((handler: (projection: ContextProjection) => void) =>
      channel.on(handler)) as never,
  } as never
})

afterEach(async () => {
  cleanup()
  channel.close()
  for (const host of hosts) await host.stop('chain-teardown').catch(() => undefined)
  hosts = []
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs = []
  resetContextMirror()
  delete window.freyaHost
})

/** Bind the window's only Context door to a projection, as a reporting Core would. */
function report(projection: ContextProjection): ReturnType<typeof chainReportingCore> {
  const source = chainReportingCore(projection)
  channel.bind(source.core)
  return source
}

/** Admit the three states the surface has to tell apart, in one scope. */
function storeWithStates() {
  const store = chainStore()
  store.setActiveScope(sessionScope())
  const live = admitVia(
    store,
    explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
    T0,
  )
  const taken = admitVia(
    store,
    authorizedProjectAdmission({ scope: sessionScope(), content: 'the cancelled project' }),
    T0,
  )
  const doomed = admitVia(
    store,
    sharedTabAdmission({ scope: sessionScope(), content: 'the stale tab', ttlMs: 1_000 }),
    T0,
  )
  expect(store.revoke(taken.contextId, 'the owner stopped sharing the project', T0)).toBe(true)
  return { store, live, taken, doomed, later: at(2_000) }
}

describe('what a window renders is what the store holds', () => {
  it('carries kind, state, provenance, scope and expiry through every hop', async () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const item = admitVia(
      store,
      explicitSelectionAdmission({
        scope: sessionScope(),
        content: CHAIN_SECRET,
        label: 'the selected paragraph',
      }),
      T0,
    )
    const projection = chainSeam().project({ store, now: T0 })
    report(projection)

    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${item.contextId}"]`)).not.toBeNull(),
    )

    // Identity at the mirror: the transport forwarded, it did not rebuild.
    expect(contextMirror().projection).toBe(projection)
    // And what crossed the wire is scannable: the whole projection a window
    // now holds, with the private part absent from every field of it.
    expect(JSON.stringify(contextMirror().projection)).not.toContain(CHAIN_SECRET)
    const held = contextMirror().projection?.items[0]
    expect(Object.keys(held ?? {}).sort()).toEqual([
      'expiresAt',
      'itemId',
      'kind',
      'label',
      'provenance',
      'scope',
      'state',
      'ttlSeconds',
    ])
    expect(held?.label).toBeNull()

    const article = container.querySelector(`[data-item-id="${item.contextId}"]`)
    expect(article?.getAttribute('data-kind')).toBe('explicit_selection')
    expect(article?.getAttribute('data-state')).toBe('current')
    expect(article?.textContent).toContain('Kind: explicit_selection')
    expect(article?.textContent).toContain('owner_selection')
    expect(article?.textContent).toContain(`session (session)`)
    expect(article?.textContent).toContain(`admitted ${item.admittedAt}`)
    expect(article?.textContent).toContain(item.contextId)
    expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe('ready')
    expect(container.textContent).toContain('1 item')
    expect(container.textContent).toContain('1 current')

    // The private part never left the store: not the content, and not the
    // label a person typed either — the audit shape has no label field, so the
    // window falls back to the kind word.
    expect(container.textContent).not.toContain(CHAIN_SECRET)
    expect(container.textContent).not.toContain('the selected paragraph')
    expect(article?.textContent).toContain('explicit_selection')
  })

  it('shows a revocation the moment the projection reports it', async () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const item = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    const seam = chainSeam()
    const source = report(seam.project({ store, now: T0 }))

    const { container } = render(<ContextSurface />)
    const article = () => container.querySelector(`[data-item-id="${item.contextId}"]`)
    await waitFor(() => expect(article()?.getAttribute('data-state')).toBe('current'))

    expect(store.revoke(item.contextId, 'the owner took it back', T0)).toBe(true)
    source.emit(seam.project({ store, now: T0 }))

    await waitFor(() => expect(article()?.getAttribute('data-state')).toBe('revoked'))
    expect(article()?.textContent).toContain('revoked')
    expect(container.textContent).toContain('1 revoked')
    // The revocation's free-text reason is a tombstone's, and tombstones do
    // not travel: the window learns *that* it was revoked, never why a person
    // typed.
    expect(container.textContent).not.toContain('the owner took it back')
    expect(container.textContent).not.toContain(CHAIN_SECRET)
  })

  it('shows each state the store assigned, and counts them apart', async () => {
    const { store, live, taken, doomed, later } = storeWithStates()
    report(chainSeam().project({ store, now: later }))

    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelectorAll('.context-item')).toHaveLength(3),
    )
    expect(
      container.querySelector(`[data-item-id="${live.contextId}"]`)?.getAttribute('data-state'),
    ).toBe('current')
    expect(
      container.querySelector(`[data-item-id="${taken.contextId}"]`)?.getAttribute('data-state'),
    ).toBe('revoked')
    expect(
      container.querySelector(`[data-item-id="${doomed.contextId}"]`)?.getAttribute('data-state'),
    ).toBe('expired')
    expect(container.querySelectorAll('[data-state="current"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-state="revoked"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-state="expired"]')).toHaveLength(1)
    expect(container.textContent).toContain('1 expired')
    expect(container.textContent).toContain('1 revoked')
    expect(container.textContent).not.toContain('the cancelled project')
    expect(container.textContent).not.toContain('the stale tab')
    expect(container.textContent).not.toContain(CHAIN_SECRET)
  })
})

describe('an ambiguous reference is shown as ambiguity, with every candidate', () => {
  it('lists both candidates and chooses neither', async () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const first = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: 'the first paragraph' }),
      T0,
    )
    const second = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: 'the second paragraph' }),
      T0,
    )
    const resolution = store.resolve({ term: 'this' }, T0)
    if (resolution.ok) throw new Error('expected ambiguity')
    report(
      chainSeam().project({
        store,
        now: T0,
        references: [{ reference: { term: 'this' }, resolution }],
      }),
    )

    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector('[data-status="ambiguous"]')).not.toBeNull(),
    )

    const reference = container.querySelector('[data-status="ambiguous"]')
    expect(reference?.getAttribute('data-reference')).toBe('this')
    expect(reference?.textContent).toContain('All candidates — Core left this open')
    expect(reference?.textContent).toContain(first.contextId)
    expect(reference?.textContent).toContain(second.contextId)
    expect(reference?.textContent).not.toContain('Resolves to')
    expect(container.textContent).toContain('1 unresolved')

    const view = contextMirror().projection?.references[0]
    expect(view).toBeDefined()
    expect(Object.keys(view ?? {}).sort()).toEqual(['itemIds', 'reason', 'reference', 'status'])
    expect(view).not.toHaveProperty('chosenItemId')
    expect(view?.reason).toBe(CONTEXT_REFUSAL_TEXT.ambiguous)
    expect([...(view?.itemIds ?? [])].sort()).toEqual([first.contextId, second.contextId].sort())
  })

  it('shows a resolved reference with exactly one candidate', async () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const first = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: 'the first paragraph' }),
      T0,
    )
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: 'the second paragraph' }),
      T0,
    )
    const both = store.resolve({ term: 'this' }, T0)
    if (both.ok) throw new Error('expected ambiguity')
    const other = both.candidateIds.find((id) => id !== first.contextId) ?? ''
    expect(store.revoke(other, 'the owner took one back', T0)).toBe(true)
    const resolved = store.resolve({ term: 'this' }, T0)
    if (!resolved.ok) throw new Error('expected a unique match')
    report(
      chainSeam().project({
        store,
        now: T0,
        references: [{ reference: { term: 'this' }, resolution: resolved }],
      }),
    )

    const { container } = render(<ContextSurface />)
    await waitFor(() => expect(container.querySelector('[data-status="resolved"]')).not.toBeNull())
    const reference = container.querySelector('[data-status="resolved"]')
    expect(reference?.textContent).toContain('Resolves to')
    expect(reference?.textContent).toContain(first.contextId)
    expect(container.textContent).not.toContain('unresolved')
  })
})

describe('the window says what the transport says, and nothing more', () => {
  it('reports an unbound transport as not-yet-reported, never as an empty frame', async () => {
    // The channel a real window attaches to today: bound to nothing, because
    // no Core reports context. `pull()` answers `null`, which the client turns
    // into the protocol's stated absence.
    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe(
        'unavailable',
      ),
    )
    expect(contextMirror().projection?.reason).toBe(
      'Core has not reported a Context yet',
    )
    expect(container.textContent).toContain('CONTEXT UNAVAILABLE')
    expect(container.querySelectorAll('.context-item')).toHaveLength(0)
    expect(container.textContent).not.toContain(CHAIN_SECRET)
  })

  it('reports a window with no bridge at all as absent, not as empty', async () => {
    delete window.freyaHost
    resetContextMirror()
    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe(
        'absent',
      ),
    )
    expect(container.textContent).toContain('Context is not available')
    // No posture strip, no counts, no rows: an absent mirror is not a frame.
    expect(container.querySelector('.context-posture')).toBeNull()
    expect(container.querySelectorAll('.context-item')).toHaveLength(0)
  })

  it('reports Core’s own “no Context domain” sentence verbatim when that is what arrives', async () => {
    report({ ...ABSENT_CONTEXT_PROJECTION, reason: NO_CONTEXT_DOMAIN_REASON })
    const { container } = render(<ContextSurface />)
    await waitFor(() => expect(heading(container, 'NO CONTEXT DOMAIN')).not.toBeNull())
    expect(container.querySelector('[data-domain="absent"]')).not.toBeNull()
    expect(container.textContent).toContain(NO_CONTEXT_DOMAIN_REASON)
  })
})

function heading(container: Element, text: string): Element | null {
  return [...container.querySelectorAll('b')].find((node) => node.textContent === text) ?? null
}

describe('the renderer has no Context mutation or authority path', () => {
  it('submits nothing while the Context surface is on screen', async () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    report(chainSeam().project({ store, now: T0 }))

    const { container } = render(<ContextSurface />)
    await waitFor(() => expect(container.querySelectorAll('.context-item')).toHaveLength(1))
    await contextMirror().read()
    // Not "refused": zero. This lane has no command to own, so a window that
    // has been mounted, pushed to and pulled from has sent nothing at all.
    expect(coreSubmit).not.toHaveBeenCalled()

    const mirror = contextMirror()
    expect(Object.keys(mirror).sort()).toEqual(['attach', 'projection', 'read', 'reset', 'subscribe'])
    expect(mirror.read.length).toBe(0)
    expect(
      container.querySelectorAll('button, input, textarea, select, form, a[href]'),
    ).toHaveLength(0)
  })

  it('finds no verb in the doors this chain walked through', async () => {
    const root = resolve(import.meta.dirname, '..', '..')
    const preload = stripCommentLines(await readFile(join(root, 'electron', 'preload.ts'), 'utf8'))
    const api = preload.slice(
      preload.indexOf('const api = {'),
      preload.indexOf('contextBridge.exposeInMainWorld'),
    )
    const contextKeys = [...api.matchAll(/^\s{2}(\w*[Cc]ontext\w*):\s/gm)].map((match) => match[1])
    expect([...contextKeys].sort()).toEqual(['coreContext', 'onCoreContext'])
    expect(api).not.toMatch(/context\w*(Submit|Write|Create|Revoke|Capture|Resolve|Select)/i)
    // The pull has no parameter slot, so a window cannot attach a payload to it.
    expect(preload).toMatch(
      /coreContext: \(\): Promise<ContextProjection \| null> =>\s*\n?\s*ipcRenderer\.invoke\('freya:core:context'\)/,
    )
    const commands = preload.slice(preload.indexOf('const CORE_COMMANDS'), preload.indexOf('function readString'))
    expect(commands.toLowerCase()).not.toMatch(/context/)

    const main = stripCommentLines(await readFile(join(root, 'electron', 'main.ts'), 'utf8'))
    expect([...main.matchAll(/'freya:core:context'/g)]).toHaveLength(2)
    expect(main).not.toMatch(/context:(write|submit|update|revoke)/i)

    // And the client this chain walks through: no submit call exists in it.
    const client = await readFile(join(root, 'src', 'platform', 'contextClient.ts'), 'utf8')
    expect(stripCommentLines(client)).not.toMatch(/coreSubmit/)
  })
})

/**
 * The honest production end state, with a live Core in the window: the host
 * answers `null` because no facade exists, the mirror publishes the stated
 * absence, and the whole session — mount, pull, read — spends nothing.
 */
describe('a window over a live Core tells the truth and spends nothing', () => {
  it('shows no Context domain and makes zero model calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-chain-window-'))
    dirs.push(dir)
    const provider = new FakeModelProvider()
    const host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, { providers: [provider] })
    hosts.push(host)
    await host.start()

    // Exactly what `electron/main.ts` wires: the handler's answer, the push,
    // and the one command door a window has.
    const submit = vi.fn((command: string, payload?: unknown) =>
      host.submit({ command: command as never, requestId: 'r-window', payload }),
    )
    window.freyaHost = {
      isDesktop: true,
      coreSubmit: submit as never,
      coreContext: (async () => host.context()) as never,
      onCoreContext: ((handler: (projection: ContextProjection) => void) =>
        host.onContext(handler)) as never,
    } as never
    resetContextMirror()

    expect(host.context()).toBeNull()
    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe(
        'unavailable',
      ),
    )
    const outcome = await contextMirror().read()
    expect(outcome).toEqual({ operation: 'status', ok: true })

    expect(submit).not.toHaveBeenCalled()
    expect(provider.calls).toBe(0)
    expect(host.status().activeProviderCalls).toBe(0)
    expect(host.status().sessionUsage.calls).toBe(0)
    expect(container.textContent).not.toContain(CHAIN_SECRET)
  })
})

/** Comments are stripped so prose cannot satisfy — or fail — a code assertion. */
function stripCommentLines(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}
