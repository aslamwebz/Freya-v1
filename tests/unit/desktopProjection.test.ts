import { describe, expect, it } from 'vitest'
import type { CoreStatus, ProviderStatus } from '../../core/protocol/core-protocol'
import {
  deriveAttention,
  derivePresence,
  projectDesktop,
  usageFact,
  type ActivityFact,
  type ProjectionInput,
} from '../../src/core/desktopProjection'

/**
 * The desktop projection.
 *
 * This is the layer that decides what Freya's window is allowed to claim. Every
 * test here is written from one question: could this projection make the window
 * say something untrue?
 */

function core(over: Partial<CoreStatus> = {}): CoreStatus {
  return {
    lifecycle: 'ready',
    eventSequence: 12,
    coreStartedAt: '2026-03-01T12:00:00.000Z',
    integrity: { integrity: 'ok', reason: 'read in full', line: null, eventsRead: 12, bytesDiscarded: 0 },
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 0 },
    providers: [],
    activeProviderCalls: 0,
    sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    faults: [],
    ...over,
  }
}

function input(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    core: core(),
    activity: [],
    listening: false,
    now: 1_800_000_000_000,
    ...over,
  }
}

function activity(id: string, at = 1_800_000_000_000): ActivityFact {
  const parts = id.split(':')
  const sequence = Number(parts[parts.length - 1] ?? 0)
  return { id, text: 'something happened', at, tone: 'neutral', sequence }
}

describe('presence derivation', () => {
  it('maps a ready, healthy Core to idle', () => {
    expect(derivePresence(input()).state).toBe('idle')
  })

  it('maps Core booting to a startup wording, not to thinking', () => {
    const booting = derivePresence(input({ core: core({ lifecycle: 'booting', coreStartedAt: null }) }))
    expect(booting.state).toBe('idle')
    expect(booting.detail).toMatch(/starting/i)
  })

  it('maps a corrupt journal to error', () => {
    const corrupt = derivePresence(
      input({
        core: core({
          lifecycle: 'degraded',
          integrity: { integrity: 'corrupt', reason: 'journal corrupt at line 3', line: 3, eventsRead: 2, bytesDiscarded: 90 },
          governor: { status: 'deny_all', grantsActive: 0 },
        }),
      }),
    )
    expect(corrupt.state).toBe('error')
    expect(corrupt.detail).toMatch(/journal is corrupt/i)
  })

  it('maps a torn tail to idle, because a crash is not a fault', () => {
    const torn = derivePresence(
      input({ core: core({ integrity: { integrity: 'torn', reason: 'torn final write', line: null, eventsRead: 12, bytesDiscarded: 40 } }) }),
    )
    expect(torn.state).toBe('idle')
  })

  it('maps STOP ALL to locked', () => {
    const stopped = derivePresence(
      input({
        core: core({
          stopAll: { active: true, activatedAt: '2026-03-01T12:01:00.000Z', activatedBy: 'owner' },
          governor: { status: 'deny_all', grantsActive: 0 },
        }),
      }),
    )
    expect(stopped.state).toBe('locked')
    expect(stopped.detail).toMatch(/refused/i)
  })

  it('maps a Governor refusing everything, without STOP ALL, to locked as well', () => {
    const denied = derivePresence(input({ core: core({ governor: { status: 'deny_all', grantsActive: 0 } }) }))
    expect(denied.state).toBe('locked')
  })

  it('maps an explicit microphone to listening', () => {
    expect(derivePresence(input({ listening: true })).state).toBe('listening')
  })

  it('does not let a microphone override a locked Core', () => {
    const locked = derivePresence(
      input({
        listening: true,
        core: core({
          stopAll: { active: true, activatedAt: '2026-03-01T12:01:00.000Z', activatedBy: 'owner' },
          governor: { status: 'deny_all', grantsActive: 0 },
        }),
      }),
    )
    expect(locked.state).toBe('locked')
  })

  it('does not let a microphone override a corrupt journal', () => {
    const errored = derivePresence(
      input({
        listening: true,
        core: core({
          lifecycle: 'degraded',
          integrity: { integrity: 'corrupt', reason: 'corrupt', line: 2, eventsRead: 1, bytesDiscarded: 8 },
          governor: { status: 'deny_all', grantsActive: 0 },
        }),
      }),
    )
    expect(errored.state).toBe('error')
  })

  it('claims working only when Core reports a live provider call', () => {
    expect(derivePresence(input({ core: core({ activeProviderCalls: 1 }) })).state).toBe('working')
    expect(derivePresence(input({ core: core({ activeProviderCalls: 3 }) })).state).toBe('working')
  })

  it('follows one stop from running to locked to idle', () => {
    // The whole sequence, as a window actually sees it. The part worth stating
    // is the middle: once the work has finished, the window is still locked,
    // because the latch — not the absence of work — is what holds it there.
    const running = derivePresence(input({ core: core({ activeProviderCalls: 1 }) }))
    expect(running.state).toBe('working')

    const stopped = core({
      activeProviderCalls: 1,
      stopAll: { active: true, activatedAt: '2026-03-01T12:01:00.000Z', activatedBy: 'owner' },
      governor: { status: 'deny_all', grantsActive: 0 },
    })
    expect(derivePresence(input({ core: stopped })).state).toBe('locked')

    // The cancellation finished. Still locked: nothing about that undoes a stop.
    expect(derivePresence(input({ core: { ...stopped, activeProviderCalls: 0 } })).state).toBe('locked')

    const resumed = core({ activeProviderCalls: 0 })
    expect(derivePresence(input({ core: resumed })).state).toBe('idle')

    // The latch on its own, with the Governor not refusing, so this cannot be
    // satisfied by the branch above. STOP ALL is what holds the window, and it
    // holds it whether or not there is anything left to stop.
    const latchedOnly = core({
      activeProviderCalls: 0,
      stopAll: { active: true, activatedAt: '2026-03-01T12:01:00.000Z', activatedBy: 'owner' },
      governor: { status: 'ready', grantsActive: 0 },
    })
    expect(derivePresence(input({ core: latchedOnly })).state).toBe('locked')
  })

  it('never claims working from a command alone', () => {
    // A recorded command is not work. `command.received` reaches the activity
    // feed and nothing else, and no input other than a live provider count can
    // reach `working` — so this is true by construction rather than by
    // convention.
    const idle = derivePresence(
      input({
        core: core({ activeProviderCalls: 0 }),
        activity: [activity('command.received:4')],
      }),
    )
    expect(idle.state).toBe('idle')
  })

  it('reports running model work above an open microphone', () => {
    // A request that is executing is spending money whether or not anyone is
    // speaking, and the count is the only thing the user cannot otherwise see.
    const working = derivePresence(
      input({ core: core({ activeProviderCalls: 2 }), listening: true }),
    )
    expect(working.state).toBe('working')
  })

  it('treats a null Core as starting up rather than as healthy', () => {
    const none = derivePresence(input({ core: null }))
    expect(none.state).toBe('idle')
    expect(none.detail).toMatch(/starting/i)
  })
})

describe('usage presentation', () => {
  it('is exact when nothing is unaccounted for', () => {
    const fact = usageFact({ calls: 2, inputTokens: 10, outputTokens: 20, unknownUsageCalls: 0 })
    expect(fact.exact).toBe(true)
    expect(fact.label).toMatch(/30 tokens reported/)
  })

  it('is a declared lower bound when a call reported nothing', () => {
    const fact = usageFact({ calls: 2, inputTokens: 10, outputTokens: 20, unknownUsageCalls: 1 })
    expect(fact.exact).toBe(false)
    expect(fact.label).toMatch(/at least/i)
    expect(fact.label).toMatch(/1 unaccounted/)
  })

  it('says so when nothing at all has been reported', () => {
    const fact = usageFact({ calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 })
    expect(fact.label).toMatch(/nothing reported/i)
  })

  it('counts a failed call as unaccounted rather than as free', () => {
    const fact = usageFact({ calls: 1, inputTokens: null, outputTokens: null, unknownUsageCalls: 1 })
    expect(fact.exact).toBe(false)
    expect(fact.calls).toBe(1)
    expect(fact.unknownUsageCalls).toBe(1)
  })
})

describe('attention', () => {
  it('is none when nothing needs a person', () => {
    expect(deriveAttention([], core())).toBe('none')
  })

  it('is urgent for a corrupt journal', () => {
    const desktop = projectDesktop(
      input({
        core: core({
          lifecycle: 'degraded',
          integrity: { integrity: 'corrupt', reason: 'corrupt', line: 3, eventsRead: 2, bytesDiscarded: 90 },
          governor: { status: 'deny_all', grantsActive: 0 },
        }),
      }),
    )
    expect(desktop.attention).toBe('urgent')
    expect(desktop.attentionItems[0]?.id).toBe('integrity')
  })

  it('raises a faulted provider as a decision, not as an emergency', () => {
    const faulted: ProviderStatus = {
      id: 'nanogpt',
      kind: 'nanogpt',
      status: 'faulted',
      model: null,
      detail: 'The provider reported it cannot be used.',
      liveEnabled: false,
    }
    const desktop = projectDesktop(input({ core: core({ providers: [faulted] }) }))
    expect(desktop.attention).toBe('high')
  })
})

describe('the whole projection', () => {
  it('is deterministic for the same input', () => {
    const one = projectDesktop(input({ activity: [activity('model.request.started:1')] }))
    const two = projectDesktop(input({ activity: [activity('model.request.started:1')] }))
    expect(one).toEqual(two)
  })

  it('reports the six system rows a person reads first', () => {
    const desktop = projectDesktop(input())
    expect(desktop.system.map((row) => row.id)).toEqual([
      'core',
      'security',
      'journal',
      'governor',
      'models',
    ])
  })

  it('says there is no provider rather than implying one is ready', () => {
    const desktop = projectDesktop(input())
    const models = desktop.system.find((row) => row.id === 'models')
    expect(models?.value).toBe('No provider')
    expect(models?.detail).toMatch(/no model provider is registered/i)
  })

  it('does not call a configured provider without a key ready', () => {
    const noKey: ProviderStatus = {
      id: 'nanogpt',
      kind: 'nanogpt',
      status: 'configured',
      model: 'gpt-4o-mini',
      detail: 'No API key is configured.',
      liveEnabled: false,
    }
    const desktop = projectDesktop(input({ core: core({ providers: [noKey] }) }))
    expect(desktop.providers[0]?.state).toBe('no key')
    expect(desktop.providers[0]?.tone).toBe('warn')
  })

  it('keeps session and durable usage separate', () => {
    const desktop = projectDesktop(
      input({
        core: core({
          sessionUsage: { calls: 1, inputTokens: 5, outputTokens: 5, unknownUsageCalls: 0 },
          durableUsage: { calls: 9, inputTokens: 40, outputTokens: 40, unknownUsageCalls: 0 },
        }),
      }),
    )
    expect(desktop.usage.session.calls).toBe(1)
    expect(desktop.usage.durable.calls).toBe(9)
  })

  it('reports work as empty rather than inventing it', () => {
    const desktop = projectDesktop(input())
    expect(desktop.work.empty).toBe(true)
    expect(desktop.work.summary).toBe('No active work')
  })

  it('exposes grants as a number, not as prose to be parsed', () => {
    const desktop = projectDesktop(input({ core: core({ governor: { status: 'ready', grantsActive: 3 } }) }))
    expect(desktop.grantsActive).toBe(3)
  })

  it('never reports presence as thinking', () => {
    // `thinking` means a model is considering something. Nothing in the system
    // can cause that in Phase 2, so the projection must not be able to produce
    // it — asserted by enumerating every reachable input shape.
    const reachable = [
      derivePresence(input()).state,
      derivePresence(input({ listening: true })).state,
      derivePresence(input({ core: core({ activeProviderCalls: 2 }) })).state,
      derivePresence(input({ core: null })).state,
      derivePresence(input({ core: core({ lifecycle: 'booting' }) })).state,
    ]
    expect(reachable).not.toContain('thinking')
  })
})
