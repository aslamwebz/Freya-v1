// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ContextSurface } from '../../src/ui/surfaces/ContextSurface'
import { contextMirror, resetContextMirror } from '../../src/platform/contextClient'
import { ElectronCoreHost } from '../../electron/coreHost'
import { FakeModelProvider } from '../../core/model/fake-provider'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextProjection,
} from '../../core/protocol/context'
import { conversation } from '../core/context/fixture'
import type { CoreCommandResult } from '../../core/protocol/core-protocol'
import { CHAIN_SECRET, sendContext } from '../core/context/chain-harness'

/**
 * THE CHAIN, ACROSS THE ELECTRON BOUNDARY AND INTO THE WINDOW.
 *
 * `chain-acceptance.test.ts` proves the Core half. This file picks the answer
 * up on the far side of the transport with a *real* `ElectronCoreHost` and a
 * real Core, wired exactly as `electron/main.ts` wires it:
 *
 *   Core (`ContextIntegration`) → host (`toContextProjection`) →
 *     `window.freyaHost.coreContext` / `onCoreContext` → `contextMirror()`
 *     → `<ContextSurface/>`
 *
 * The one difference from production is where a test needs a door that is
 * closed: the renderer's `coreSubmit` is built from `CORE_COMMANDS` read out
 * of `electron/preload.ts` itself, so a `context.*` attempt through the
 * window's door is refused by the *real* whitelist rather than by something
 * this file decided — and the same attempt straight at the host door is
 * understood by Core. That contrast is the boundary under test.
 *
 * Every assertion is on survival or on absence: the window's DOM says what
 * Core said (including the words `live`, `revoked` and `expired`), the private
 * part says nothing at all, and no control, no command and no argument
 * anywhere in the lane can be aimed at Context from a renderer.
 */

const CONV_9 = conversation('conv-9')

let dir = ''
let host: ElectronCoreHost
let provider: FakeModelProvider
type WindowSubmit = (command: string, payload?: unknown) => Promise<CoreCommandResult>

let allowedCommands: Set<string>
let coreSubmit: Mock<WindowSubmit>
let bridgePresent = true

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-chain-window-'))
  provider = new FakeModelProvider()
  host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, { providers: [provider] })
  allowedCommands = await preloadCommandWhitelist()
  bridgePresent = true
  resetContextMirror()
  wireBridge()
})

afterEach(async () => {
  cleanup()
  await host.stop('chain-teardown').catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
  resetContextMirror()
  delete window.freyaHost
})

/**
 * The renderer's door, built from the whitelist `electron/preload.ts` actually
 * carries — so "a window cannot name a context command" is checked against the
 * production file rather than against a copy of it.
 */
function wireBridge(): void {
  coreSubmit = vi.fn<WindowSubmit>(async (command, payload) =>
    allowedCommands.has(command)
      ? host.submit({ command: command as never, requestId: 'w-1', payload })
      : {
          requestId: 'w-1',
          ok: false,
          refusal: { reason: `unknown command: ${command}` },
        },
  )
  if (!bridgePresent) {
    delete window.freyaHost
    return
  }
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreContext: (async () => host.context()) as never,
    onCoreContext: ((handler: (projection: ContextProjection) => void) =>
      host.onContext(handler)) as never,
  } as never
}

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

async function preloadSource(): Promise<string> {
  const root = resolve(import.meta.dirname, '..', '..')
  return stripCommentLines(await readFile(join(root, 'electron', 'preload.ts'), 'utf8'))
}

/** Every command name preload's whitelist actually forwards. */
async function preloadCommandWhitelist(): Promise<Set<string>> {
  const source = await preloadSource()
  const start = source.indexOf('const CORE_COMMANDS')
  if (start < 0) throw new Error('preload no longer declares CORE_COMMANDS')
  const end = source.indexOf('])', start)
  const region = source.slice(start, end)
  return new Set(
    [...region.matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  )
}

async function startHost(): Promise<ElectronCoreHost> {
  await host.start()
  return host
}

async function activateConv9(): Promise<void> {
  const activated = await sendContext(host, 'context.scope.activate', { scope: CONV_9 })
  expect(activated.outcome.operation).toBe('scope-activated')
}

async function admit(
  payload: Record<string, unknown>,
): Promise<{ contextId: string; admittedAt: string }> {
  const admitted = await sendContext(host, 'context.admit', {
    kind: 'explicit_selection',
    channel: 'owner_selection',
    scope: CONV_9,
    ...payload,
  })
  if (!admitted.outcome.ok || admitted.outcome.contextId === undefined) {
    throw new Error(`admission refused (${admitted.outcome.operation})`)
  }
  const row = host.context()?.items.find((item) => item.itemId === admitted.outcome.contextId)
  if (row === undefined) throw new Error('the admitted item was not reported')
  return { contextId: admitted.outcome.contextId, admittedAt: row.provenance?.admittedAt ?? '' }
}

/** Hand a projection to the window without a host, for the protocol contract. */
function push(projection: ContextProjection): void {
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreContext: (async () => projection) as never,
    onCoreContext: ((handler: (projection: ContextProjection) => void) => {
      handler(projection)
      return () => {}
    }) as never,
  } as never
  resetContextMirror()
}

describe('what a window renders is what Core reported', () => {
  it('carries an admitted selection through every hop and into the DOM', async () => {
    await startHost()
    await activateConv9()
    const { contextId, admittedAt } = await admit({
      content: CHAIN_SECRET,
      label: 'the selected paragraph',
    })

    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${contextId}"]`)).not.toBeNull(),
    )

    // The mirror holds exactly what the door answers, field for field.
    expect(contextMirror().projection).toEqual(host.context())
    const article = container.querySelector(`[data-item-id="${contextId}"]`)
    expect(article?.getAttribute('data-kind')).toBe('explicit_selection')
    // Core's own availability word, printed as Core said it.
    expect(article?.getAttribute('data-state')).toBe('live')
    expect(article?.textContent).toContain('Kind: explicit_selection')
    expect(article?.textContent).toContain('owner_selection')
    expect(article?.textContent).toContain('conversation (conv-9)')
    expect(article?.textContent).toContain(`admitted ${admittedAt}`)
    expect(article?.textContent).toContain(contextId)
    expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe('ready')
    expect(container.textContent).toContain('1 item')
    expect(container.textContent).toContain('1 current')

    // The private part never left Core: not the content, and not the label a
    // person typed either — the audit row has no label field, so the window
    // heads the row with the kind word.
    expect(container.textContent).not.toContain(CHAIN_SECRET)
    expect(container.textContent).not.toContain('the selected paragraph')
    expect(article?.querySelector('h3')?.textContent).toBe('explicit_selection')

    // And the item the mirror holds is metadata and nothing more.
    expect(Object.keys(contextMirror().projection?.items[0] ?? {}).sort()).toEqual([
      'expiresAt',
      'itemId',
      'kind',
      'label',
      'provenance',
      'scope',
      'state',
      'ttlSeconds',
    ])
    expect(JSON.stringify(contextMirror().projection)).not.toContain(CHAIN_SECRET)
  })

  it('shows a revocation the moment Core reports it, and never the reason', async () => {
    await startHost()
    await activateConv9()
    const { contextId } = await admit({ content: CHAIN_SECRET })

    const { container } = render(<ContextSurface />)
    const article = () => container.querySelector(`[data-item-id="${contextId}"]`)
    await waitFor(() => expect(article()?.getAttribute('data-state')).toBe('live'))

    const revoked = await sendContext(host, 'context.revoke', {
      contextId,
      reason: 'the owner took it back',
    })
    expect(revoked.outcome.operation).toBe('revoked')

    await waitFor(() => expect(article()?.getAttribute('data-state')).toBe('revoked'))
    expect(article()?.textContent).toContain('revoked')
    // The counts line is built from Core's numbers: one revoked item, and no
    // "current" count at all — `describeCounts` reports a zero current by
    // saying nothing rather than dressing it up as a positive.
    expect(container.textContent).toContain('1 item · 1 revoked')
    expect(container.textContent).not.toMatch(/\d+ current/)
    // The revocation's free-text reason is a tombstone's, and tombstones do
    // not travel: the window learns *that* it was revoked, never why a person
    // typed.
    expect(container.textContent).not.toContain('the owner took it back')
    expect(container.textContent).not.toContain(CHAIN_SECRET)
  })

  it('shows expiry as expiry, never as live, from the first report it sees', async () => {
    await startHost()
    await activateConv9()
    await admit({ content: 'shortlived words', ttlMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The door tells the truth before the window asks: a fresh pull is
    // expired, and `current` counts nothing.
    const fresh = host.context()
    expect(fresh?.items[0]?.state).toBe('expired')
    expect(fresh?.counts.current).toBe(0)
    expect(fresh?.counts.expired).toBe(1)

    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelectorAll('.context-item')).toHaveLength(1),
    )
    expect(container.querySelectorAll('[data-state="expired"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-state="live"]')).toHaveLength(0)
    expect(container.textContent).toContain('1 item · 1 expired')
    expect(container.textContent).not.toMatch(/\d+ current/)
    expect(container.textContent).not.toContain('shortlived words')
  })
})

describe('an ambiguous reference is never a choice the window gets to make', () => {
  it('leaves no standing reference in the projection the window holds', async () => {
    await startHost()
    await activateConv9()
    await admit({ content: 'the first paragraph' })
    await admit({ content: 'the second paragraph' })

    // Core answers the question with ids and a verdict...
    const answered = await sendContext(host, 'context.reference.read', { term: 'this' })
    expect(answered.outcome.operation).toBe('unresolved-ambiguous')
    expect(answered.outcome.candidateIds).toHaveLength(2)

    // ...and the projection the window mirrors holds no reference row at all,
    // so there is nothing in the DOM that could resolve it either.
    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelectorAll('.context-item')).toHaveLength(2),
    )
    expect(contextMirror().projection?.references).toEqual([])
    expect(container.querySelectorAll('.context-reference')).toHaveLength(0)
    expect(container.textContent).not.toContain('Resolves to')
  })

  it('renders a reference row as ambiguity, with every candidate, if one ever arrives', () => {
    // The protocol allows a reference row even though nothing today produces
    // one, so the window's half of the contract is pinned here: all the
    // candidates, and no field that picks.
    push({
      ...ABSENT_CONTEXT_PROJECTION,
      health: 'ready',
      reason: null,
      references: [
        {
          reference: 'this',
          status: 'ambiguous',
          itemIds: ['ctx-1', 'ctx-2'],
          reason: 'more than one live context item matches, so naming one would be a guess',
        },
      ],
      counts: {
        items: 0,
        current: 0,
        expired: 0,
        revoked: 0,
        references: 1,
        unresolvedReferences: 1,
      },
      sequence: 7,
    })
    const { container } = render(<ContextSurface />)
    const reference = container.querySelector('[data-status="ambiguous"]')
    expect(reference).not.toBeNull()
    expect(reference?.textContent).toContain('All candidates — Core left this open')
    expect(reference?.textContent).toContain('ctx-1')
    expect(reference?.textContent).toContain('ctx-2')
    expect(reference?.textContent).not.toContain('Resolves to')
    expect(container.textContent).toContain('1 unresolved')

    const view = contextMirror().projection?.references[0]
    expect(Object.keys(view ?? {}).sort()).toEqual(['itemIds', 'reason', 'reference', 'status'])
    expect(view).not.toHaveProperty('chosenItemId')
    expect(view?.itemIds).toEqual(['ctx-1', 'ctx-2'])
  })
})

describe('the window says what the transport says, and nothing more', () => {
  it('reports a Core that has not started as not-yet-reported, never as an empty frame', async () => {
    // The host is constructed but not started: `context()` answers `null`
    // because no Core has reported anything, and the client turns that into
    // the protocol's stated absence rather than a quiet empty list.
    expect(host.context()).toBeNull()
    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe(
        'unavailable',
      ),
    )
    expect(contextMirror().projection?.reason).toBe('Core has not reported a Context yet')
    expect(container.textContent).toContain('CONTEXT UNAVAILABLE')
    expect(container.querySelectorAll('.context-item')).toHaveLength(0)
    expect(container.querySelector('.context-none')).toBeNull()
  })

  it('reports a window with no bridge at all as absent, not as empty', async () => {
    bridgePresent = false
    wireBridge()
    resetContextMirror()
    const { container } = render(<ContextSurface />)
    await waitFor(() =>
      expect(container.querySelector('.context-surface')?.getAttribute('data-health')).toBe(
        'absent',
      ),
    )
    expect(container.textContent).toContain('Context is not available')
    expect(container.querySelector('.context-posture')).toBeNull()
    expect(container.querySelectorAll('.context-item')).toHaveLength(0)
  })

  it('reports Core’s own “no Context domain” sentence verbatim when that is what arrives', async () => {
    push({ ...ABSENT_CONTEXT_PROJECTION, reason: NO_CONTEXT_DOMAIN_REASON })
    const { container } = render(<ContextSurface />)
    await waitFor(() => expect(container.querySelector('[data-domain="absent"]')).not.toBeNull())
    expect(container.textContent).toContain(NO_CONTEXT_DOMAIN_REASON)
    expect(container.querySelectorAll('.context-item')).toHaveLength(0)
  })
})

describe('the renderer has no Context mutation or authority path', () => {
  it('submits nothing while the Context surface is on screen', async () => {
    await startHost()
    await activateConv9()
    await admit({ content: CHAIN_SECRET })
    const { container } = render(<ContextSurface />)
    await waitFor(() => expect(container.querySelectorAll('.context-item')).toHaveLength(1))
    await contextMirror().read()

    // Not "refused": zero. The surface mounted, was pushed to, and pulled —
    // and sent no command at all, because this lane gives it none to own.
    expect(coreSubmit).not.toHaveBeenCalled()

    const mirror = contextMirror()
    expect(Object.keys(mirror).sort()).toEqual(['attach', 'projection', 'read', 'reset', 'subscribe'])
    expect(mirror.read.length).toBe(0)
    expect(
      container.querySelectorAll('button, input, textarea, select, form, a[href]'),
    ).toHaveLength(0)
  })

  it('refuses every context name at the window’s own door, and only there', async () => {
    await startHost()
    await activateConv9()

    // The whitelist, read out of preload: no `context.*` name is in it, so
    // the window's door does not forward one — whatever Core understands.
    expect([...allowedCommands].filter((command) => command.startsWith('context.'))).toEqual([])
    expect(allowedCommands.has('context.admit')).toBe(false)

    const refused = await coreSubmit('context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: CONV_9,
      content: CHAIN_SECRET,
    })
    expect(refused.ok).toBe(false)
    expect(refused.refusal?.reason).toMatch(/unknown command/)

    // The same attempt at the host door — the door production puts behind the
    // renderer's command channel — is understood by Core. The boundary is the
    // window's whitelist, not a vocabulary Core is missing.
    const direct = await sendContext(host, 'context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: CONV_9,
      content: CHAIN_SECRET,
    })
    expect(direct.outcome.operation).toBe('admitted')

    // And the api a window reaches has exactly two Context reads, the pull
    // with no parameter slot to fill.
    const source = await preloadSource()
    const api = source.slice(
      source.indexOf('const api = {'),
      source.indexOf('contextBridge.exposeInMainWorld'),
    )
    const contextKeys = [...api.matchAll(/^\s{2}(\w*[Cc]ontext\w*):\s/gm)].map(
      (match) => match[1],
    )
    expect([...contextKeys].sort()).toEqual(['coreContext', 'onCoreContext'])
    expect(api).not.toMatch(/context\w*(Submit|Write|Create|Revoke|Capture|Resolve|Select)/i)
    expect(source).toMatch(
      /coreContext: \(\): Promise<ContextProjection \| null> =>\s*\n?\s*ipcRenderer\.invoke\('freya:core:context'\)/,
    )
  })
})

describe('a window over a live Core tells the truth and spends nothing', () => {
  it('mirrors a live Core’s context and makes zero model calls', async () => {
    await startHost()
    await activateConv9()
    await admit({ content: CHAIN_SECRET })

    const { container } = render(<ContextSurface />)
    await waitFor(() => expect(container.querySelectorAll('.context-item')).toHaveLength(1))
    const outcome = await contextMirror().read()
    expect(outcome).toEqual({ operation: 'status', ok: true })

    // The whole session — mount, push, pull — submitted nothing and reached
    // no provider.
    expect(coreSubmit).not.toHaveBeenCalled()
    expect(provider.calls).toBe(0)
    expect(host.status().activeProviderCalls).toBe(0)
    expect(host.status().sessionUsage.calls).toBe(0)
    expect(container.textContent).not.toContain(CHAIN_SECRET)
  })
})
