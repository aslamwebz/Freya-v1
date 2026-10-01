// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ContextSurface } from '../../src/ui/surfaces/ContextSurface'
import { resetContextMirror } from '../../src/platform/contextClient'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextProjection,
} from '../../core/protocol/context'

/**
 * The Context view.
 *
 * The properties worth a test here are about *truth*, and this lane adds one
 * the Workforce view cannot make: Workforce at least owns a payloadless read
 * command to show refusal for. Context owns no command at all, so the surface
 * must submit **nothing** — the strongest version of "a window has no write
 * surface" is a window whose mount produces zero `coreSubmit` calls, and that
 * is asserted rather than admired.
 *
 *   - Every value shown is Core's: kind, state, provenance, scope and expiry
 *     print exactly as the projection carried them, including states this lane
 *     has never heard of.
 *   - The absences stay three different sentences: nothing reported, no
 *     Context domain, and a domain reporting empty — none is drawn as a frame
 *     full of quiet awareness.
 *   - An ambiguous reference shows every candidate and resolves none.
 */

let coreSubmit: ReturnType<typeof vi.fn>
let current: ContextProjection | null

function ready(over: Partial<ContextProjection> = {}): ContextProjection {
  return {
    ...ABSENT_CONTEXT_PROJECTION,
    health: 'ready',
    reason: null,
    items: [
      {
        itemId: 'ctx-selection',
        kind: 'explicit-selection',
        label: 'the paragraph in the editor',
        state: 'current',
        provenance: {
          sourceClass: 'owner',
          detail: 'selected deliberately',
          admittedAt: '2026-10-01T09:00:00.000Z',
        },
        scope: { label: 'mission', detail: 'mission-7' },
        expiresAt: '2026-10-01T09:15:00.000Z',
        ttlSeconds: 900,
      },
      {
        itemId: 'ctx-file',
        kind: 'project-file',
        label: 'notes/release-plan.md',
        // A revoked item is drawn *as revoked*: shown, labelled, and not
        // quietly omitted or tidied into the current rows above it.
        state: 'revoked',
        provenance: null,
        scope: null,
        expiresAt: null,
        ttlSeconds: null,
      },
      {
        itemId: 'ctx-media',
        kind: 'tab-media',
        label: null,
        // A state this lane has never seen, reported verbatim: the
        // availability vocabulary belongs to Core's Context domain (#15), and
        // a union written here would be guessing at internals it does not own.
        state: 'between-reads',
        provenance: { sourceClass: 'shared-tab', detail: null, admittedAt: null },
        scope: { label: 'session', detail: null },
        expiresAt: null,
        ttlSeconds: 30,
      },
    ],
    references: [
      { reference: 'this', status: 'resolved', itemIds: ['ctx-selection'], reason: null },
      {
        reference: 'here',
        status: 'ambiguous',
        itemIds: ['ctx-file', 'ctx-media'],
        reason: 'two items match and Core will not choose',
      },
      {
        reference: 'that one',
        status: 'unresolvable',
        itemIds: [],
        reason: 'nothing in scope matches the phrase',
      },
    ],
    counts: {
      items: 3,
      current: 1,
      expired: 0,
      revoked: 1,
      references: 3,
      unresolvedReferences: 2,
    },
    sequence: 12,
    ...over,
  }
}

/**
 * Push a projection.
 *
 * With a `null` value the host is up but Core is reporting nothing — the
 * state every build in this repository is in until #15's domain reaches a
 * Core mirror, and precisely the one the surface must not paper over.
 */
function push(projection: ContextProjection | null): void {
  current = projection
  window.freyaHost!.coreContext = (async () => current) as never
  window.freyaHost!.onCoreContext = ((handler: (p: ContextProjection) => void) => {
    if (current !== null) handler(current)
    return () => {}
  }) as never
}

beforeEach(() => {
  resetContextMirror()
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: false }))
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreContext: (async () => current) as never,
    onCoreContext: (() => () => {}) as never,
  } as never
  push(ready())
})

afterEach(() => {
  cleanup()
  resetContextMirror()
  delete window.freyaHost
})

function renderSurface() {
  return render(<ContextSurface />)
}

describe('the Context view shows only what Core reported', () => {
  it('says Core has not reported when there is no bridge at all', () => {
    // The browser case: no desktop host, so nothing has ever arrived. An empty
    // frame here would read as "Freya has no context", which is a claim about
    // a subsystem this window is in no position to make.
    delete window.freyaHost
    renderSurface()
    expect(screen.getByText(/Core has not reported a Context projection/i)).toBeInTheDocument()
    expect(screen.queryByText('the paragraph in the editor')).toBeNull()
  })

  it('states that no Context domain exists, and that nothing is simulated or captured', () => {
    push({
      ...ABSENT_CONTEXT_PROJECTION,
      reason: NO_CONTEXT_DOMAIN_REASON,
    })
    const { container } = renderSurface()

    expect(screen.getByText('NO CONTEXT DOMAIN')).toBeInTheDocument()
    expect(container.querySelector('[data-domain="absent"]')).not.toBeNull()
    expect(screen.getByText(new RegExp(NO_CONTEXT_DOMAIN_REASON))).toBeInTheDocument()
    expect(screen.getByText(/Nothing on this screen is simulated/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing here is captured by this\s*window/i)).toBeInTheDocument()
    // And no rows: an absent domain is not drawn as a quiet, empty awareness.
    expect(container.querySelectorAll('.context-item')).toHaveLength(0)
    expect(container.querySelectorAll('.context-reference')).toHaveLength(0)
  })

  it('distinguishes "not reported yet" from "no domain"', () => {
    push({ ...ABSENT_CONTEXT_PROJECTION })
    const { container } = renderSurface()
    expect(screen.getByText('CONTEXT UNAVAILABLE')).toBeInTheDocument()
    expect(container.querySelector('[data-domain="unknown"]')).not.toBeNull()
  })

  it('renders items with provenance, scope and TTL exactly as Core words them', () => {
    const { container } = renderSurface()

    const selection = container.querySelector('[data-item-id="ctx-selection"]')
    expect(selection).not.toBeNull()
    expect(selection?.getAttribute('data-kind')).toBe('explicit-selection')
    expect(selection?.getAttribute('data-state')).toBe('current')
    expect(selection?.textContent).toContain('the paragraph in the editor')
    expect(selection?.textContent).toContain('Provenance: owner (selected deliberately)')
    expect(selection?.textContent).toContain('admitted 2026-10-01T09:00:00.000Z')
    expect(selection?.textContent).toContain('Scope: mission (mission-7)')
    expect(selection?.textContent).toContain('Expires: 2026-10-01T09:15:00.000Z · 900s granted')

    // An item Core reported no provenance, no scope and no expiry for is shown
    // as lacking each — three separate nulls, not a frame filled in by the
    // renderer guessing what a file "probably" came from.
    const file = container.querySelector('[data-item-id="ctx-file"]')
    expect(file?.textContent).toContain('Provenance: Core does not report one.')
    expect(file?.textContent).toContain('Scope: Core does not report one.')
    expect(file?.textContent).toContain('No expiry reported by Core.')

    // A revoked row is on screen and labelled revoked, and an unknown state
    // prints verbatim rather than being softened.
    expect(file?.getAttribute('data-state')).toBe('revoked')
    const media = container.querySelector('[data-item-id="ctx-media"]')
    expect(media?.getAttribute('data-state')).toBe('between-reads')
    expect(media?.textContent).toContain('between-reads')
    // `label` null falls back to the kind — Core's word — never an invented one.
    expect(media?.querySelector('h3')?.textContent).toBe('tab-media')
  })

  it('shows an ambiguous reference with every candidate and resolves none', () => {
    const { container } = renderSurface()

    const here = container.querySelector('[data-reference="here"]')
    expect(here?.getAttribute('data-status')).toBe('ambiguous')
    // Both candidates, and the words say Core left it open: a surface that
    // picked one would be this lane guessing at "here", which is the exact
    // failure #15's honest-ambiguity rule prohibits.
    expect(here?.textContent).toContain('All candidates — Core left this open: ctx-file, ctx-media')
    expect(here?.textContent).toContain('two items match and Core will not choose')

    const resolved = container.querySelector('[data-reference="this"]')
    expect(resolved?.textContent).toContain('Resolves to: ctx-selection')

    const unresolvable = container.querySelector('[data-reference="that one"]')
    expect(unresolvable?.textContent).toContain('nothing in scope matches the phrase')
  })

  it('reads Core\'s counts first and in words', () => {
    renderSurface()
    expect(
      screen.getByText(/3 items · 1 current · 1 revoked · 3 references · 2 unresolved/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Provenance, scope, expiry and every state below are Core['’]s own report/i),
    ).toBeInTheDocument()
  })

  it('says so plainly when the domain is reporting and empty', () => {
    push({ ...ready(), items: [], references: [] })
    renderSurface()
    expect(
      screen.getByText(/Core reports no context items and no open references/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/not a paused\s*view/i)).toBeInTheDocument()
  })

  it('offers no control at all, and submits nothing at all', () => {
    const { container } = renderSurface()

    // The structural version of "no renderer mutation commands, no submit of
    // provenance/trust/authority/capabilities": there is nothing here to
    // submit *with*. No button, no input, no form —
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('input, textarea, select, form')).toHaveLength(0)

    // And nothing here *does*: where the Workforce view must submit exactly one
    // payloadless read, the honest Context view mounts and sends zero commands,
    // because this lane has no command to own yet and does not invent one.
    expect(coreSubmit).not.toHaveBeenCalled()
  })

  it('shows an unreachable Core as a sentence next to the view it left behind', async () => {
    // Nothing has pushed, and the pull itself fails: the honest view is the
    // absence plus the failure, and the surface may not fill the gap from the
    // last frame it happened to receive.
    push(null)
    window.freyaHost!.coreContext = (async () => {
      throw new Error('core is resting')
    }) as never
    renderSurface()

    await waitFor(() =>
      expect(
        screen.getByText(/Core could not answer the context read: Freya Core could not be reached/i),
      ).toBeInTheDocument(),
    )
    // The failure is reported *as* a failure: the absent view stays absent
    // rather than holding a stale frame it can no longer corroborate.
    expect(screen.getByText(/Core has not reported a Context projection/i)).toBeInTheDocument()
  })
})
