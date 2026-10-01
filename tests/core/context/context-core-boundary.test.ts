// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ContextIntegration } from '../../../core/context/coreIntegration'
import type { ContextCommandOutcome } from '../../../core/protocol/context'
import { T0, at, conversation } from './fixture'

/**
 * THE CORE BOUNDARY: forged provenance and scope escalation.
 *
 * The foundation (#15) already refuses a *incoherent* forgery — a claim that "Core
 * says so" about a shared tab dies on the closed kind/source table. What the store
 * cannot refuse is a **coherent** one, because `owner_selection` plus
 * `explicit_selection` is always a legal pair and always will be. Somebody who can
 * reach an admission path can therefore make a perfectly well-formed assertion
 * about where content came from, unless something in front of the store decides it
 * instead of them.
 *
 * That something is this layer, and these are the attempts it has to survive:
 *
 *  - naming a source directly, which is the whole attack in one field;
 *  - claiming `core_record` or `host_report`, the two sources that are not the
 *    caller's to assert, and which would otherwise let anybody mint provenance;
 *  - aiming at the `session` scope, the only one visible from every conversation and
 *    surface, which is the escalation with a real payoff;
 *  - aiming at a scope Core does not hold, so scope stops being containment and
 *    becomes a free-text field;
 *  - slipping an authority field past an allowlist that might be wrong.
 *
 * Two structural checks close the file: the store is not reachable as a field, so
 * there is no path around any of this; and the host's lane — the one place a
 * non-owner source is legitimate — has no way into the session scope either.
 */

function ready(options: { maxScopes?: number } = {}): ContextIntegration {
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

/** A request that is otherwise entirely well-formed, so each test varies one thing. */
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

function refused(outcome: ContextCommandOutcome): ContextCommandOutcome {
  expect(outcome.ok).toBe(false)
  expect(outcome.operation).toBe('refused')
  return outcome
}

describe('a caller cannot name its own provenance', () => {
  it('refuses a request carrying a source, and names the field', () => {
    const outcome = refused(ready().admit(request({ source: 'owner_selection' })))
    expect(outcome.refusal).toBe('authority_field_present')
    // Named, so a compromised window learns its laundering was noticed rather than
    // concluding the field was quietly ignored.
    expect(outcome.reason).toContain('source')
  })

  it('refuses a request carrying any authority field at all', () => {
    const integration = ready()
    const laundered = ['principal', 'principalId', 'owner', 'authority', 'capability', 'permission', 'grant', 'onBehalfOf', 'approvedBy', 'trusted']
    for (const field of laundered) {
      const outcome = refused(integration.admit(request({ [field]: 'owner' })))
      expect(outcome.refusal, field).toBe('authority_field_present')
      expect(outcome.reason).toContain(field)
    }
  })

  it('refuses a request whose shape is closed, and says which field broke it', () => {
    // Not authority — just unknown. Refused anyway, because an allowlist is what
    // makes a future field impossible rather than merely unimagined.
    const outcome = refused(ready().admit(request({ nickname: 'c1' })))
    expect(outcome.refusal).toBe('request_field_unknown')
    expect(outcome.reason).toContain('nickname')
  })

  it('holds nothing after a refused admission, however many fields were forged', () => {
    const integration = ready()
    refused(integration.admit(request({ source: 'core_record', principal: 'owner', forceAdmit: true })))
    expect(integration.read().counts.retained).toBe(0)
    expect(integration.resolve({ term: 'this' }).ok).toBe(false)
  })
})

describe('a caller cannot claim a source that is not its own', () => {
  it('refuses "Core says so", which would let anybody attest to itself', () => {
    // The highest-value forgery available: a source that means "Core already knows
    // this", on content Core has never seen.
    const outcome = refused(ready().admit(request({ channel: 'core_record' })))
    expect(outcome.refusal).toBe('channel_not_requestable')
    expect(outcome.reason).toContain('only the owner')
  })

  it('refuses "the host said so", which would let a window forge the host', () => {
    const outcome = refused(ready().admit(request({ channel: 'host_report', originId: 'window-7' })))
    expect(outcome.refusal).toBe('channel_not_requestable')
  })

  it('tells "that door is not yours" apart from "that is not a door"', () => {
    const integration = ready()
    expect(refused(integration.admit(request({ channel: 'telepathy' }))).refusal).toBe('channel_unknown')
    expect(refused(integration.admit(request({ channel: 'core_record' }))).refusal).toBe(
      'channel_not_requestable',
    )
    // The difference is the difference between a typo and an attempt, and a caller
    // that cannot tell which one it hit will keep trying the same name.
  })

  it('refuses a channel that is absent or not a string', () => {
    const integration = ready()
    const absent = { ...request() }
    delete absent.channel
    expect(refused(integration.admit(absent)).refusal).toBe('channel_unknown')
    expect(refused(integration.admit(request({ channel: 7 }))).refusal).toBe('channel_unknown')
  })
})

describe('a caller cannot escalate the scope', () => {
  it('refuses the ambient session scope, which is the one with a payoff', () => {
    // Session content is visible from every conversation and every surface. A payload
    // that can put something there has escalated past whatever scope it was in.
    const outcome = refused(
      ready().admit(request({ scope: { scopeKind: 'session', scopeId: 'session' } })),
    )
    expect(outcome.refusal).toBe('scope_not_requestable')
  })

  it('refuses a scope Core does not hold', () => {
    const integration = ready()
    const outcome = refused(integration.admit(request({ scope: conversation('somebody-elses') })))
    expect(outcome.refusal).toBe('scope_not_declared')
  })

  it('refuses a scope that is not a scope at all', () => {
    const integration = ready()
    expect(refused(integration.admit(request({ scope: 'c1' }))).refusal).toBe('scope_unknown')
    expect(refused(integration.admit(request({ scope: null }))).refusal).toBe('scope_unknown')
    expect(refused(integration.admit(request({ scope: { scopeKind: 'workspace', scopeId: 'c1' } }))).refusal).toBe(
      'scope_unknown',
    )
    expect(refused(integration.admit(request({ scope: { scopeKind: 'conversation' } }))).refusal).toBe(
      'scope_unknown',
    )
    expect(refused(integration.admit(request({ scope: { scopeKind: 'conversation', scopeId: '  ' } }))).refusal).toBe(
      'scope_unknown',
    )
  })

  it('binds the scope registry, so a scope cannot be minted per admission', () => {
    // Unbounded, a caller could declare a fresh scope on every request and make
    // "which scope is this" an open question with as many answers as it asked. The
    // session scope Core declares for itself counts against the bound, which is
    // deliberate: an ambient scope that were free would be the cheapest way to
    // overflow the registry.
    const integration = ready({ maxScopes: 3 })
    expect(integration.activateScope(conversation('c2')).ok).toBe(true)

    const overflow = refused(integration.activateScope(conversation('c3')))
    expect(overflow.refusal).toBe('scope_registry_full')
    expect(integration.read().declaredScopes.map((scope) => scope.scopeId).sort()).toEqual([
      'c1',
      'c2',
      'session',
    ])
    expect(integration.read().limits.maxScopes).toBe(3)
  })

  it('refuses rather than evicting, so a live scope cannot lose its place', () => {
    const integration = ready({ maxScopes: 3 })
    integration.activateScope(conversation('c2'))
    refused(integration.activateScope(conversation('c3')))
    // `c1` is still held and still usable: an eviction would have changed what
    // resolves for whatever was still pointed at it, silently.
    expect(integration.admit(request()).ok).toBe(true)
    expect(integration.read().declaredScopes.map((scope) => scope.scopeId).sort()).toEqual([
      'c1',
      'c2',
      'session',
    ])
  })

  it('never lets the host place content where every surface can see it', () => {
    // `host_report` is a legitimate source, so this lane has to exist — and it is
    // exactly where "one shared tab" would become "a feed of everything you have
    // ever looked at". The host reports into a scope; Core decides the scope.
    const integration = ready()
    const outcome = refused(
      integration.admitHostReport({
        kind: 'shared_tab',
        scope: { scopeKind: 'session', scopeId: 'session' },
        content: 'https://example.test/quarterly-deck',
        originId: 'window-7',
      }),
    )
    expect(outcome.refusal).toBe('scope_not_requestable')
  })

  it('refuses a host report into a scope Core does not hold', () => {
    const outcome = refused(
      ready().admitHostReport({
        kind: 'shared_tab',
        scope: conversation('not-declared'),
        content: 'https://example.test/deck',
        originId: 'window-7',
      }),
    )
    expect(outcome.refusal).toBe('scope_not_declared')
  })

  it('gives the host lane no field to relabel itself with', () => {
    // The type cannot express a claim about provenance at all, so a host report
    // cannot arrive dressed as the owner's own selection.
    const report = {
      kind: 'shared_tab',
      scope: conversation('c1'),
      content: 'https://example.test/deck',
      originId: 'window-7',
    }
    // A runtime object with the forbidden fields is still refused, because the
    // check does not depend on the compile-time type being honoured.
    const outcome = refused(ready().admit({ ...request(), ...report, source: 'owner_selection', channel: 'owner_share' }))
    expect(outcome.refusal).toBe('authority_field_present')
  })
})

describe('the boundary cannot be walked around', () => {
  it('makes the store genuinely unreachable, which is a stronger claim than `private`', () => {
    // `ContextStore.admit` takes a `source` at face value against the closed table.
    // That table refuses an incoherent forgery and cannot refuse a coherent one, so a
    // reachable store is a reachable way to assert provenance.
    //
    // Asserted as reachability rather than as a TypeScript annotation, because a
    // `private` is erased at compile time: with one, `integration['store']` would
    // still hand over the store at runtime and this whole file would be optional.
    const integration = ready()
    expect(Object.keys(integration)).not.toContain('store')
    expect(Object.getOwnPropertyNames(integration)).not.toContain('store')
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(integration) as object)).not.toContain('store')
    expect((integration as unknown as Record<string, unknown>)['store']).toBeUndefined()

    // And no operation on the public surface hands one back either. Spelled out
    // rather than looped over the prototype, because a `private` TypeScript method is
    // still a runtime prototype method and invoking those with no arguments would be
    // testing the absence of defaults rather than the absence of a leak.
    const returned: unknown[] = [
      integration.read(),
      integration.resolve({ term: 'this' }),
      integration.resolveMetadata({ term: 'this' }),
      integration.agentContext(),
      integration.admit(request()),
      integration.admitHostReport({
        kind: 'shared_tab',
        scope: conversation('c1'),
        content: 'https://example.test',
        originId: 'w-1',
      }),
      integration.admitCoreRecord({
        kind: 'current_mission',
        scope: { scopeKind: 'session', scopeId: 'session' },
        content: 'The current Mission is m-1 and it is active.',
        originId: 'm-1',
      }),
      integration.revoke('x-1', 'the owner took it back'),
      integration.revokeScope(conversation('c1'), 'the owner closed the conversation'),
      integration.forgetScope(conversation('c1'), 'the owner closed the conversation'),
      integration.activateScope(conversation('c1')),
      integration.syncMissionContext(null),
    ]
    for (const value of returned) {
      expect(value).not.toHaveProperty('admit')
      expect(value).not.toHaveProperty('resolve')
      expect(value).not.toHaveProperty('records')
    }
  })

  it('defers agent_work on every lane and sources active_window only on the host lane', () => {
    // `agent_work` waits on #16: refused by name on every lane, Core's own included.
    // `active_window` gained a real capture lane (issue #30), and the tables decide
    // its provenance rather than its caller: exactly one door — the host's — may
    // report it. An owner channel or Core's record lane asserting the front window
    // is the same forgery the kind/source table refuses elsewhere.
    const integration = ready()
    for (const lane of [
      () => integration.admit(request({ kind: 'agent_work' })),
      () =>
        integration.admitCoreRecord({
          kind: 'agent_work',
          scope: { scopeKind: 'session', scopeId: 'session' },
          content: 'whatever the desktop is showing',
          originId: 'window-7',
        }),
      () =>
        integration.admitHostReport({
          kind: 'agent_work',
          scope: conversation('c1'),
          content: 'whatever the desktop is showing',
          originId: 'window-7',
        }),
    ]) {
      expect(refused(lane()).reason).toContain('does not source')
    }

    const ownerClaim = refused(integration.admit(request({ kind: 'active_window' })))
    expect(ownerClaim.reason).toContain('does not come from that source')
    const coreClaim = refused(
      integration.admitCoreRecord({
        kind: 'active_window',
        scope: { scopeKind: 'session', scopeId: 'session' },
        content: 'whatever the desktop is showing',
        originId: 'window-7',
      }),
    )
    expect(coreClaim.reason).toContain('does not come from that source')
    expect(integration.read().counts.retained).toBe(0)

    const hostLane = integration.admitHostReport({
      kind: 'active_window',
      scope: conversation('c1'),
      content: 'whatever the desktop is showing',
      originId: 'window-7',
    })
    expect(hostLane.ok).toBe(true)
    expect(integration.read().counts.retained).toBe(1)
  })

  it('changes nothing at all when the clock cannot be read', () => {
    // Judging an item live because the clock was broken is the failure the
    // foundation's `invalid_clock` exists to prevent, and a boundary that decided
    // provenance before it checked the time would have already changed something.
    const integration = new ContextIntegration({ now: () => new Date(Number.NaN) })
    integration.activateScope(conversation('c1'))

    expect(refused(integration.admit(request())).refusal).toBe('invalid_clock')
    expect(refused(integration.activateScope(conversation('c2'))).refusal).toBe('invalid_clock')
    expect(integration.revoke('x-1', 'the owner took it back').refusal).toBe('invalid_clock')
    expect(integration.resolve({ term: 'this' }).operation).toBe('unresolved-invalid')
    expect(integration.read().items).toEqual([])
  })
})

describe('the agent seam is declared and cannot be used', () => {
  it('reports a wired seam as unavailable, because agent_work is a deferred kind', () => {
    // #16 has not landed, so `agent_work` is refused by name by the foundation. A
    // half-wired seam would be an unsourced channel that *looked* sourced, which is
    // the one thing this lane exists to prevent.
    const exploding = {
      agentWork: (): never => {
        throw new Error('the seam must not be read before #16 lands')
      },
    }
    const integration = new ContextIntegration({ now: () => T0, agentSource: exploding })

    const agent = integration.agentContext()
    expect(agent.wired).toBe(true)
    expect(agent.available).toBe(false)
    expect(agent.reason).toContain('does not source active-agent context')
    // And reading the projection is equally safe: nothing called the source.
    expect(integration.read().agentContext.wired).toBe(true)
    expect(integration.read().items).toEqual([])
  })

  it('reports an unfilled seam as unfilled rather than as a gap', () => {
    const integration = new ContextIntegration({ now: () => at(0) })
    expect(integration.agentContext()).toEqual({
      wired: false,
      available: false,
      reason: expect.stringContaining('does not source active-agent context'),
    })
  })
})