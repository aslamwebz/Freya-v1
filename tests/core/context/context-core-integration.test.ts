// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ContextIntegration } from '../../../core/context/coreIntegration'
import type { ContextCommandOutcome } from '../../../core/protocol/context'
import type { ContextReference } from '../../../core/context/types'
import type { MissionStatus } from '../../../core/missions/types'
import { T0, at, conversation, sessionScope, surface } from './fixture'

/**
 * THE CORE INTEGRATION: the operations Core owns.
 *
 * The foundation (#15) proved the store would hold and refuse correctly. What is
 * tested here is the layer that makes it *Core's*: the five operations a caller
 * reaches — admit, revoke, revokeScope, resolve, read — and the two properties
 * that only exist at this level and not in the store:
 *
 *  - **Truthful outcomes.** The store's boolean answers "did something change",
 *    which is the wrong question at a boundary. Here `revoked`,
 *    `revoke-not-found`, `revoke-already-settled` and `scope-revoke-empty` are four
 *    different facts, and a resolution distinguishes `ambiguous` from `expired`
 *    from `revoked` from `no_candidates` from `no_active_scope` rather than
 *    collapsing them into one failure.
 *  - **A read that is metadata and scoped.** No content, no label, no URI, no
 *    revocation reason — and, less obviously, no *counts* belonging to a
 *    conversation that is not the current one.
 *
 * The Mission adapter is tested through the same public surface rather than
 * separately, because "Core points here at the current Mission" is only true if it
 * holds through the same door everything else does.
 */

function ready(options: { maxScopes?: number; limits?: Record<string, number> } = {}): ContextIntegration {
  let next = 0
  const integration = new ContextIntegration({
    now: () => T0,
    newId: () => {
      next += 1
      return `x-${next}`
    },
    ...options,
  })
  integration.activateScope(conversation('c1'))
  return integration
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'explicit_selection',
    channel: 'owner_selection',
    scope: conversation('c1'),
    content: 'the second paragraph of the lease',
    label: 'lease.md',
    ...overrides,
  }
}

function admitted(outcome: ContextCommandOutcome): string {
  if (!outcome.ok) throw new Error(`expected an admission, refused: ${outcome.reason}`)
  if (outcome.contextId === undefined) throw new Error('an admission reported no id')
  return outcome.contextId
}

describe('admission through the Core boundary', () => {
  it('holds a well-formed request and reports the id it minted', () => {
    const outcome = ready().admit(request())
    expect(outcome.operation).toBe('admitted')
    expect(outcome.ok).toBe(true)
    expect(outcome.contextId).toBe('x-1')
    expect(outcome.scope).toEqual(conversation('c1'))
  })

  it('derives the provenance from the door rather than the payload', () => {
    // The point of the whole lane, asserted once end to end: what a caller said about
    // where content came from is never what Core recorded, because the payload had no
    // such field to say it with.
    const integration = ready()
    admitted(integration.admit(request({ channel: 'owner_share', kind: 'shared_tab', uri: 'https://example.test' })))
    expect(integration.read().items[0]?.source).toBe('owner_share')
  })

  it('passes the store its own refusals, in the store\'s words', () => {
    // Not restated here. Two copies of one rule is one rule too many the day one of
    // them is edited, and the boundary has nothing to add to "that is not a context
    // kind this Core knows".
    const integration = ready()
    const empty = integration.admit(request({ content: '   ' }))
    expect(empty.operation).toBe('refused')
    expect(empty.ok).toBe(false)
    expect(empty.reason).toBe('there is no content in this context item')
    expect(empty.refusal).toBeUndefined()
  })

  it('reports bounded forgetting rather than dropping it silently', () => {
    // Eviction is how the retention bound holds, and it is exactly the moment a
    // person would otherwise find out their context vanished.
    const integration = ready({ limits: { maxLivePerScope: 2 } })
    admitted(integration.admit(request({ content: 'one' })))
    admitted(integration.admit(request({ content: 'two' })))
    const third = integration.admit(request({ content: 'three' }))
    expect(third.evictedIds).toEqual(['x-1'])
    expect(integration.read().counts.live).toBe(2)
  })

  it('moves its sequence on every change and not on a read', () => {
    const integration = ready()
    const start = integration.read().sequence
    integration.read()
    integration.read()
    expect(integration.read().sequence).toBe(start)
    admitted(integration.admit(request()))
    expect(integration.read().sequence).toBe(start + 1)
    integration.revoke('x-1', 'the owner took it back')
    expect(integration.read().sequence).toBe(start + 2)
  })
})

describe('revocation is named, not boolean', () => {
  it('tells a revoked item from one that was never there', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request()))

    const taken = integration.revoke(contextId, 'the owner took it back')
    expect(taken).toEqual({ operation: 'revoked', ok: true, contextId })

    const missing = integration.revoke('x-999', 'the owner took it back')
    expect(missing.operation).toBe('revoke-not-found')
    expect(missing.ok).toBe(false)
  })

  it('tells already-revoked from never-held', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request()))
    integration.revoke(contextId, 'the owner took it back')

    const again = integration.revoke(contextId, 'the owner took it back again')
    expect(again.operation).toBe('revoke-already-settled')
    expect(again.reason).toContain('already revoked')
  })

  it('refuses to stamp an expired item as revoked, which would lose the truth', () => {
    // The store puts revocation ahead of the clock in its state rule, so revoking an
    // expired item would turn a truthful `expired` into a `revoked` and erase the fact
    // that the words had simply run out of time. No gain — the content is already
    // destroyed — and one real loss, so the facade refuses and says why.
    let clock = T0
    const integration = new ContextIntegration({
      now: () => clock,
      newId: (() => {
        let next = 0
        return () => `x-${(next += 1)}`
      })(),
    })
    integration.activateScope(conversation('c1'))
    const contextId = admitted(integration.admit(request({ ttlMs: 1_000 })))

    clock = at(5_000)
    const outcome = integration.revoke(contextId, 'the owner took it back')
    expect(outcome.operation).toBe('revoke-already-settled')
    expect(outcome.reason).toContain('already expired')
    // And the resolution still says `expired`, which is the fact being protected.
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-expired')
  })

  it('refuses a reason that is not a sentence', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request()))
    expect(integration.revoke(contextId, '   ').refusal).toBe('invalid_reason')
    expect(integration.revoke(contextId, 'x'.repeat(500)).refusal).toBe('invalid_reason')
    expect(integration.revoke(contextId, 'the owner closed the conversation').operation).toBe('revoked')
  })

  it('reports scope revocation as the live count, not the settled one', () => {
    // The store counts everything not yet revoked, which includes items that had
    // already expired. Reporting those as revoked would put a number in front of a
    // person saying work was done on content that had already been destroyed.
    let clock = T0
    const integration = new ContextIntegration({
      now: () => clock,
      newId: (() => {
        let next = 0
        return () => `x-${(next += 1)}`
      })(),
    })
    integration.activateScope(conversation('c1'))
    admitted(integration.admit(request({ content: 'expires', ttlMs: 1_000 })))
    admitted(integration.admit(request({ content: 'lives', ttlMs: 60_000 })))

    clock = at(5_000)
    const outcome = integration.revokeScope(conversation('c1'), 'the owner closed the conversation')
    expect(outcome.operation).toBe('scope-revoked')
    expect(outcome.revokedCount).toBe(1)
  })

  it('says so when a scope holds nothing live, rather than reporting a number', () => {
    const integration = ready()
    const empty = integration.revokeScope(conversation('c1'), 'the owner closed the conversation')
    expect(empty.operation).toBe('scope-revoke-empty')
    expect(empty.ok).toBe(false)
    expect(empty.reason).toContain('nothing live')
  })

  it('leaves an expired item expired when a scope is revoked, rather than stamping it', () => {
    // The store's `revokeScope` counts and stamps everything not yet revoked, which
    // includes expired items — and because its state rule puts revocation ahead of the
    // clock, that converts a truthful `expired` into a `revoked`. This is the whole
    // reason the facade revokes live rows one at a time instead of delegating.
    let clock = T0
    const integration = new ContextIntegration({
      now: () => clock,
      newId: (() => {
        let next = 0
        return () => `x-${(next += 1)}`
      })(),
    })
    integration.activateScope(conversation('c1'))
    admitted(integration.admit(request({ content: 'expires', ttlMs: 1_000 })))

    clock = at(5_000)
    const outcome = integration.revokeScope(conversation('c1'), 'the owner closed the conversation')
    expect(outcome.operation).toBe('scope-revoke-empty')

    // Still `expired`, which is the fact about it. Had this delegated, the refusal a
    // person reads afterwards would be "revoked" for words that had only run out of time.
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-expired')
    expect(integration.read().items.map((row) => row.state)).toEqual(['expired'])
  })

it('takes everything back when a scope is forgotten, content included', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request()))
    const forgotten = integration.forgetScope(conversation('c1'), 'the owner closed the conversation')
    expect(forgotten).toEqual({
      operation: 'scope-forgotten',
      ok: true,
      scope: conversation('c1'),
      revokedCount: 1,
    })
    // The scope is gone, so it cannot be aimed at, and the content is gone with it.
    expect(integration.admit(request()).refusal).toBe('scope_not_declared')
    expect(integration.resolve({ term: 'this' }).ok).toBe(false)
    expect(contextId).toBe('x-1')
  })

  it('leaves nothing current behind it when a forgotten scope was the current one', () => {
    const integration = ready()
    admitted(integration.admit(request()))
    integration.forgetScope(conversation('c1'), 'the owner closed the conversation')
    // `here` refuses rather than resolving against a scope Core no longer holds.
    expect(integration.read().activeScope).toBeNull()
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-no-active-scope')
  })

  it('will not forget the session scope, because ambient "here" has to point somewhere', () => {
    const integration = ready()
    expect(integration.forgetScope(sessionScope(), 'the owner changed their mind').refusal).toBe(
      'scope_not_requestable',
    )
    // Revoking it is a different, available act — an explicit naming of the session.
    expect(integration.revokeScope(sessionScope(), 'stop sharing this session').operation).toBe(
      'scope-revoke-empty',
    )
  })
})

describe('resolution tells the five refusals apart', () => {
  it('resolves a unique live match and hands Core the item', () => {
    const integration = ready()
    admitted(integration.admit(request()))
    const resolved = integration.resolve({ term: 'this' })
    if (!resolved.ok) throw new Error(`expected a resolution: ${resolved.reason}`)
    expect(resolved.operation).toBe('resolved')
    expect(resolved.item.kind).toBe('explicit_selection')
  })

  it('refuses rather than guessing between two matches, and names both', () => {
    const integration = ready()
    admitted(integration.admit(request({ content: 'the first' })))
    admitted(integration.admit(request({ content: 'the second' })))

    const resolved = integration.resolve({ term: 'this' })
    expect(resolved.operation).toBe('unresolved-ambiguous')
    if (resolved.ok) throw new Error('expected a refusal')
    expect([...resolved.candidateIds].sort()).toEqual(['x-1', 'x-2'])
  })

  it('distinguishes nothing-matched from expired from revoked from no scope', () => {
    let clock = T0
    const integration = new ContextIntegration({
      now: () => clock,
      newId: (() => {
        let next = 0
        return () => `x-${(next += 1)}`
      })(),
    })

    // No scope is current: nothing can be judged, and that is not the same as nothing
    // matching.
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-no-active-scope')

    integration.activateScope(conversation('c1'))
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-no-candidates')

    const expiring = admitted(integration.admit(request({ content: 'expires', ttlMs: 1_000 })))
    clock = at(5_000)
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-expired')

    clock = at(10_000)
    integration.activateScope(conversation('c2'))
    const revoked = admitted(
      integration.admit(request({ scope: conversation('c2'), content: 'taken back', ttlMs: 60_000 })),
    )
    integration.revoke(revoked, 'the owner took it back')
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-revoked')
    expect(expiring).toBe('x-1')
  })

  it('answers a deferred kind by name rather than as an absence', () => {
    const integration = ready()
    const resolved = integration.resolve({ term: 'here', kind: 'active_window' })
    expect(resolved.operation).toBe('unresolved-kind-deferred')
    if (resolved.ok) throw new Error('expected a refusal')
    expect(resolved.reason).toContain('does not source that context kind yet')
  })

  it('refuses a reference it does not understand', () => {
    const integration = ready()
    expect(integration.resolve({ term: 'that' as ContextReference['term'] }).operation).toBe(
      'unresolved-invalid',
    )
  })

  it('reports a resolution without the content, for anything a window may read', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request({ content: 'the settlement is 40k' })))

    const forCore = integration.resolve({ term: 'this' })
    if (!forCore.ok) throw new Error('expected a resolution')
    expect(forCore.item.content).toContain('40k')

    const forAWindow = integration.resolveMetadata({ term: 'this' })
    expect(forAWindow).toEqual({ operation: 'resolved', ok: true, contextId })
    expect(JSON.stringify(forAWindow)).not.toContain('40k')
  })

  it('keeps a scope wall, and does not leak the other side through the outcome', () => {
    const integration = ready()
    integration.activateScope(conversation('other'))
    admitted(integration.admit(request({ scope: conversation('other'), content: 'the settlement is 40k' })))
    integration.activateScope(conversation('c1'))

    const resolved = integration.resolve({ term: 'this' })
    expect(resolved.operation).toBe('unresolved-no-candidates')
    if (resolved.ok) throw new Error('expected a refusal')
    expect(resolved.candidateIds).toEqual([])
    expect(JSON.stringify(resolved)).not.toContain('40k')
  })
})

describe('the read is metadata, and only metadata', () => {
  it('reports state, kinds, sources and instants and nothing that was said', () => {
    const integration = ready()
    admitted(
      integration.admit(
        request({
          kind: 'file',
          channel: 'owner_authorization',
          uri: 'file:///home/owner/legal/offer-letter.docx',
          label: 'offer-letter (final).docx',
          content: 'the settlement offer is 40k and the deadline is Friday',
        }),
      ),
    )

    const rows = integration.read().items
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'admittedAt',
      'capturedAt',
      'contentLength',
      'contextId',
      'expiresAt',
      'kind',
      'labelLength',
      'originId',
      'revokedAt',
      'scopeId',
      'scopeKind',
      'source',
      'state',
    ])
    const shared = JSON.stringify(integration.read())
    expect(shared).not.toContain('settlement')
    expect(shared).not.toContain('40k')
    expect(shared).not.toContain('offer-letter')
    expect(shared).not.toContain('file:///')
    // And it is not "no information": the measurement is still there.
    expect(rows[0]?.contentLength).toBe('the settlement offer is 40k and the deadline is Friday'.length)
  })

  it('keeps a revocation reason off every shared surface', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request()))
    integration.revoke(contextId, 'the owner asked about their health')

    const shared = JSON.stringify({ read: integration.read(), resolved: integration.resolveMetadata({ term: 'this' }) })
    expect(shared).toContain('"state":"revoked"')
    expect(shared).not.toContain('health')
  })

  it('does not report another conversation, or even how much of it there is', () => {
    // The obvious half of the wall is content. The half that is easy to forget is
    // existence: a projection listing every retained record would tell this
    // conversation which ids, kinds and sources exist in another, and a bare count is
    // enough to confirm a conversation is there at all.
    const integration = ready()
    admitted(integration.admit(request({ content: 'theirs' })))
    integration.activateScope(conversation('other'))
    admitted(integration.admit(request({ scope: conversation('other'), content: 'mine' })))

    const view = integration.read()
    expect(view.items).toHaveLength(1)
    expect(view.items[0]?.contentLength).toBe('mine'.length)
    expect(view.counts.retained).toBe(1)
    expect(view.counts.live).toBe(1)
    expect(JSON.stringify(view)).not.toContain('theirs')
  })

  it('shows session content to every scope, because ambient is what it means', () => {
    const integration = ready()
    integration.admitCoreRecord({
      kind: 'current_mission',
      scope: sessionScope(),
      content: 'The current Mission is m-1 and it is active.',
      originId: 'm-1',
    })
    const inConversation = integration.read().items.filter((row) => row.kind === 'current_mission')
    integration.activateScope(surface('s1'))
    expect(integration.read().items.filter((row) => row.kind === 'current_mission')).toEqual(inConversation)
  })

  it('reports nothing at all with no active scope, rather than an empty-but-ready view', () => {
    const integration = new ContextIntegration({ now: () => T0 })
    integration.activateScope(conversation('c1'))
    admitted(integration.admit(request()))
    integration.activateScope(null)

    const view = integration.read()
    expect(view.activeScope).toBeNull()
    expect(view.items).toEqual([])
    expect(view.counts.retained).toBe(0)
    // "there is no context" and "there is no scope to see it in" are different facts.
    expect(view.persistence.durable).toBe(false)
  })

  it('says context is ephemeral rather than looking healthy', () => {
    const view = ready().read()
    expect(view.persistence.mode).toBe('ephemeral')
    expect(view.persistence.durable).toBe(false)
    expect(view.persistence.reason).toContain('no encrypted context store exists yet')
  })
})

describe('the current-Mission adapter is narrow', () => {
  /**
   * A Mission integration with a scope current.
   *
   * The active scope is set because resolution fails closed without one — which
   * includes session content. That is the foundation's rule and this lane keeps it:
   * "here" needs a place to be *in*, and a Core that resolved ambient context with
   * nothing current would be guessing at where the person is.
   */
  function missionReady(): ContextIntegration {
    let next = 0
    const integration = new ContextIntegration({
      now: () => T0,
      newId: () => {
        next += 1
        return `x-${next}`
      },
    })
    integration.activateScope(conversation('c1'))
    return integration
  }

  it('points "here" at the active Mission and at nothing else', () => {
    const integration = missionReady()
    const placed = integration.syncMissionContext({ missionId: 'm-1', status: 'active' })
    expect(placed.operation).toBe('admitted')
    // Ambient, because a Mission that only resolved inside the conversation it was
    // created in would stop being "here" the moment the owner opened another surface.
    expect(placed.scope).toEqual(sessionScope())

    const resolved = integration.resolve({ term: 'here', kind: 'current_mission' })
    if (!resolved.ok) throw new Error(`expected a resolution: ${resolved.reason}`)
    // The whole of what crosses: an id and a status.
    expect(resolved.item.provenance).toEqual({
      source: 'core_record',
      capturedAt: T0.toISOString(),
      originId: 'm-1',
    })
    expect(resolved.item.content).toBe('The current Mission is m-1 and it is active.')
  })

  it('keeps at most one live current-Mission item, so "here" is never ambiguous', () => {
    const integration = missionReady()
    integration.syncMissionContext({ missionId: 'm-1', status: 'active' })
    integration.syncMissionContext({ missionId: 'm-2', status: 'active' })

    const resolved = integration.resolve({ term: 'here', kind: 'current_mission' })
    if (!resolved.ok) throw new Error(`expected a resolution: ${resolved.reason}`)
    expect(resolved.item.provenance.originId).toBe('m-2')
    // The previous one was taken back rather than left to compete for the word.
    const states = integration.read().items
      .filter((row) => row.kind === 'current_mission')
      .map((row) => row.state)
    expect(states.sort()).toEqual(['live', 'revoked'])
  })

  it('is idempotent, so a Mission board re-rendering cannot churn context ids', () => {
    const integration = missionReady()
    const first = integration.syncMissionContext({ missionId: 'm-1', status: 'active' })
    const second = integration.syncMissionContext({ missionId: 'm-1', status: 'active' })

    expect(second.operation).toBe('unchanged')
    // `ok: false` because nothing was admitted — but not a refusal either, which is
    // what the envelope's own `ok` is for.
    expect(second.ok).toBe(false)
    expect(second.refusal).toBeUndefined()
    expect(second.contextId).toBe(first.contextId)
    expect(integration.read().items).toHaveLength(1)
  })

  it('re-points when the status changes, because the sentence changes', () => {
    const integration = missionReady()
    integration.syncMissionContext({ missionId: 'm-1', status: 'active' })
    const paused = integration.syncMissionContext({ missionId: 'm-1', status: 'paused' })

    expect(paused.operation).toBe('admitted')
    expect(paused.revokedCount).toBe(1)

    const resolved = integration.resolve({ term: 'here', kind: 'current_mission' })
    if (!resolved.ok) throw new Error('expected a resolution')
    expect(resolved.item.content).toContain('paused')
  })

  it('points at nothing when there is no current Mission', () => {
    const integration = missionReady()
    integration.syncMissionContext({ missionId: 'm-1', status: 'active' })
    const cleared = integration.syncMissionContext(null)
    expect(cleared.operation).toBe('revoked')

    // Revoked, not merely gone: the refusal has to stay able to say what happened.
    expect(integration.resolve({ term: 'here', kind: 'current_mission' }).operation).toBe('unresolved-revoked')
    expect(integration.syncMissionContext(null).operation).toBe('revoke-not-found')
  })

  it('carries no Mission text, and could not', () => {
    // The report type is ids and a closed status. A Mission's title and intent live
    // in an encrypted store this lane cannot read, and admitting them would move the
    // most private text Freya holds into an ephemeral store with no encryption at all.
    const integration = missionReady()
    integration.syncMissionContext({ missionId: 'm-1', status: 'active' })

    const shared = JSON.stringify({
      read: integration.read(),
      resolved: integration.resolveMetadata({ term: 'here', kind: 'current_mission' }),
    })
    expect(shared).not.toMatch(/title|intent|criteria/i)
    // The status is visible as a closed label, which is the most it may say.
    expect(shared).toContain('active')
  })

  it('refuses a report that is not a report', () => {
    const integration = missionReady()
    // Not a compile error to try — a caller assembles this from a fold, so the check
    // is at runtime and says so rather than being trusted to the type.
    expect(integration.syncMissionContext({ missionId: '', status: 'active' }).operation).toBe('refused')
    expect(
      integration.syncMissionContext({ missionId: 'm-1', status: '' as MissionStatus }).operation,
    ).toBe('refused')
    expect(
      integration.syncMissionContext({ missionId: 'm-1', status: 'nonsense' as MissionStatus }).operation,
    ).toBe('refused')
    expect(integration.read().items).toEqual([])
  })
})

describe('every operation answers without a thenable', () => {
  it('keeps the integration synchronous, so idle context costs nothing', () => {
    const integration = ready()
    const contextId = admitted(integration.admit(request()))
    const outcomes: unknown[] = [
      integration.admit(request({ content: 'another' })),
      integration.admitHostReport({
        kind: 'shared_tab',
        scope: conversation('c1'),
        content: 'https://example.test',
        originId: 'w-1',
      }),
      integration.admitCoreRecord({
        kind: 'current_mission',
        scope: sessionScope(),
        content: 'The current Mission is m-1 and it is active.',
        originId: 'm-1',
      }),
      integration.resolve({ term: 'this' }),
      integration.resolveMetadata({ term: 'this' }),
      integration.read(),
      integration.revoke(contextId, 'the owner took it back'),
      integration.revokeScope(conversation('c1'), 'the owner closed the conversation'),
      integration.forgetScope(conversation('c1'), 'the owner closed the conversation'),
      integration.activateScope(conversation('c2')),
      integration.syncMissionContext(null),
      integration.agentContext(),
    ]
    for (const outcome of outcomes) {
      expect((outcome as { then?: unknown } | null | undefined)?.then).toBeUndefined()
    }
  })
})