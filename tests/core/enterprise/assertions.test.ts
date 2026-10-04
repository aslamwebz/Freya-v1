import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  analyseZeroHiddenSpend,
  auditEnterpriseTables,
  deriveBlockedReason,
  deriveNextBoundedAction,
  deriveProgress,
  deriveUncertainty,
  findCognitionEventsInVocabulary,
  findForbiddenVocabularyInSource,
  findImpurityInSource,
  findTimerUsageInSource,
  findUnboundedLoopInSource,
  initialEnterpriseState,
  projectEnterpriseState,
  reduceEnterpriseState,
  stripComments,
  type EnterpriseJournalEntry,
} from '../../../core/enterprise'
import { ENV_ID, T0 } from './harness'

/**
 * The claims this phase makes about itself.
 *
 * Everything else in the suite tests behaviour. This file tests the *structure* that
 * makes the behaviour credible — and it reads the source of each module rather than
 * trusting its doc comment, because a comment is a claim and a scan is evidence.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, '..', '..', '..', 'core', 'enterprise')

function sourceOf(file: string): string {
  return readFileSync(join(CORE, file), 'utf8')
}

/**
 * The modules that decide what Freya may do.
 *
 * Deliberately excludes `runtime.ts` and `ports.ts`: the runtime is *supposed* to call
 * ports, and `ports.ts` only declares them. Everything listed here decides whether an
 * action is allowed, whether a spend fits, whether an outcome was verified, or what the
 * durable state is — and none of those is a thing that should be able to reach the
 * outside world while deciding.
 */
const PURE_MODULES = [
  'types.ts',
  'machine.ts',
  'boundaries.ts',
  'spending.ts',
  'approvals.ts',
  'verification.ts',
  'rollback.ts',
  'catalog.ts',
  'orchestration.ts',
  'state.ts',
  'projection.ts',
] as const

describe('the modules that decide are unable to act', () => {
  for (const file of PURE_MODULES) {
    it(`${file} reads no clock, no network and no randomness`, () => {
      expect(findImpurityInSource(sourceOf(file)), file).toEqual([])
    })

    it(`${file} schedules nothing`, () => {
      expect(findTimerUsageInSource(sourceOf(file)), file).toEqual([])
    })

    it(`${file} has no loop with no condition`, () => {
      expect(findUnboundedLoopInSource(sourceOf(file)), file).toEqual([])
    })

    it(`${file} names no way to move money or mint authority`, () => {
      expect(findForbiddenVocabularyInSource(sourceOf(file)), file).toEqual([])
    })
  }
})

describe('the auditor itself is held to the same standard', () => {
  /**
   * `assertions.ts` is excluded from the scans above for one honest reason: it has to
   * *contain* the banned names in order to ban them, and those names sit in string and
   * regex literals. A scan that flagged a list of forbidden words would be flagging the
   * list.
   *
   * So it is checked differently and more strictly — with string literals stripped as
   * well as comments, which is a stronger scan than the others get. Anything the
   * auditor does rather than merely name would still be found.
   */
  const withLiteralsStripped = (source: string): string =>
    stripComments(source)
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')

  it('reads no clock, no network and no randomness in its executable code', () => {
    expect(findImpurityInSource(withLiteralsStripped(sourceOf('assertions.ts')))).toEqual([])
  })

  it('schedules nothing in its executable code', () => {
    expect(findTimerUsageInSource(withLiteralsStripped(sourceOf('assertions.ts')))).toEqual([])
  })

  it('has no unbounded loop in its executable code', () => {
    expect(findUnboundedLoopInSource(withLiteralsStripped(sourceOf('assertions.ts')))).toEqual([])
  })
})

describe('the runtime schedules nothing either', () => {
  it('contains no timer and no self-rearming loop', () => {
    const source = sourceOf('runtime.ts')
    expect(findTimerUsageInSource(source)).toEqual([])
    expect(findUnboundedLoopInSource(source)).toEqual([])
  })

  it('schedules itself nowhere: the only async work is a call it was given', () => {
    const source = stripComments(sourceOf('runtime.ts'))
    // Every `await` in the runtime is on a port call or on one of its own functions.
    // No bare `new Promise`, no scheduler, no queue that survives the call.
    expect(source).not.toContain('new Promise')
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('queueMicrotask')
  })
})

describe('the ports cannot reach a model or mint authority', () => {
  const source = stripComments(sourceOf('ports.ts'))

  it('declares no cognition request', () => {
    // Not "does not use one" — does not *declare* one. There is no route to spend.
    expect(source).not.toMatch(/requestCognition|cognition\s*\(/i)
    expect(source).not.toMatch(/\bprovider\b/)
    expect(source).not.toMatch(/\bgateway\b/i)
    expect(source).not.toMatch(/\bgrant\b/)
  })

  it('declares no capability or permission check to ask around authority', () => {
    expect(source).not.toMatch(/capabilit/i)
    expect(source).not.toMatch(/permission/i)
  })

  it('declares no payment or transfer route', () => {
    expect(source).not.toMatch(/transfer|payment|pay\b|charge/i)
  })

  it('names a currency nowhere in its effect request shape', () => {
    // The effect request carries no amount and no currency: an effect request that
    // could carry those is one that could move money, and the type would be the last
    // thing standing between a caller and a payment.
    const effectRequest = source.slice(
      source.indexOf('interface EnterpriseEffectRequest'),
      source.indexOf('interface EnterpriseEffectOutcome'),
    )
    expect(effectRequest).not.toMatch(/amount|currency|Minor/i)
  })
})

describe('this phase cannot record that it thought', () => {
  it('has no cognition event type', () => {
    expect(findCognitionEventsInVocabulary()).toEqual([])
  })
})

describe('the audits themselves are honest', () => {
  it('finds nothing wrong with the tables as they stand', () => {
    expect(auditEnterpriseTables()).toEqual([])
  })

  it('detects an injected timer, so the check is not vacuous', () => {
    // An audit that cannot fail protects nothing. Each of these is the shape of finding
    // the scan is supposed to produce.
    expect(findTimerUsageInSource('setInterval(() => tick(), 100)')).toContain('setInterval')
    expect(findUnboundedLoopInSource('while (true) { work() }')).toContain('while-true')
    expect(findImpurityInSource('const now = Date.now()')).toContain('Date.now')
    expect(findImpurityInSource('await ports.append("x", {})')).toContain('ports-call')
    expect(findForbiddenVocabularyInSource('function transferFunds() {}')).toContain('transferFunds')
  })

  it('does not mistake prose about a timer for a timer', () => {
    const prose = `
      // This module deliberately contains no setInterval, because a loop that re-arms
      // itself is a loop nobody bounded. See findTimerUsageInSource.
      export const note = 'setTimeout is not used here either'
    `
    expect(findTimerUsageInSource(prose)).toEqual([])
  })

  it('strips both comment styles', () => {
    expect(stripComments('a // b\n/* c */ d')).not.toContain('b')
    expect(stripComments('a // b\n/* c */ d')).not.toContain('c')
  })

  it('does not mistake a URL scheme for a global', () => {
    // `https://` contains no window reference, but a naive scan for `window` would
    // have to be careful about prose too.
    expect(findImpurityInSource('const u = "https://example.com/window"')).toEqual([])
  })
})

describe('an idle journal is provably idle', () => {
  it('reports no actions and no violations from an empty log', () => {
    const report = analyseZeroHiddenSpend({ entries: [] })
    expect(report).toEqual({ violations: [], wakes: 0, actions: 0 })
  })

  it('reports no actions from a log that only records state changes', () => {
    const entries: EnterpriseJournalEntry[] = [
      { type: 'enterprise.environment.created', recordedAt: T0, payload: {} },
      { type: 'enterprise.environment.state-changed', recordedAt: T0, payload: {} },
    ]
    expect(analyseZeroHiddenSpend({ entries }).actions).toBe(0)
  })

  it('reports no actions from a projection of an idle state', () => {
    const projection = projectEnterpriseState({ state: initialEnterpriseState(), at: T0 })
    expect(projection.activeEnvironments).toEqual([])
    expect(projection.nextBoundedAction).toBeNull()
  })
})

describe('the projection counts progress and never invents it', () => {
  const seeded = reduceEnterpriseState([
    {
      type: 'enterprise.environment.created',
      recordedAt: T0,
      payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'Site', at: T0 },
    },
  ]).state

  it('reports zero for an environment with no children, not a guess', () => {
    expect(deriveProgress(seeded, ENV_ID)).toBe(0)
  })

  it('counts terminal children over children that exist', () => {
    const withWork = reduceEnterpriseState([
      ...[
        {
          type: 'enterprise.environment.created',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'Site', at: T0 },
        },
      ],
      {
        type: 'enterprise.task.created',
        recordedAt: T0,
        payload: { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 },
      },
      {
        type: 'enterprise.task.state-changed',
        recordedAt: T0,
        payload: { taskId: 't1', environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', at: T0 },
      },
    ]).state
    expect(deriveProgress(withWork, ENV_ID)).toBe(0)

    const finished = reduceEnterpriseState([
      {
        type: 'enterprise.environment.created',
        recordedAt: T0,
        payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'Site', at: T0 },
      },
      {
        type: 'enterprise.task.created',
        recordedAt: T0,
        payload: { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 },
      },
      {
        type: 'enterprise.task.state-changed',
        recordedAt: T0,
        payload: { taskId: 't1', environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', at: T0 },
      },
      { type: 'enterprise.task.completed', recordedAt: T0, payload: { taskId: 't1', environmentId: ENV_ID, at: T0 } },
      {
        type: 'enterprise.task.created',
        recordedAt: T0,
        payload: { taskId: 't2', environmentId: ENV_ID, state: 'draft', at: T0 },
      },
    ]).state
    // One of two finished. A failed task also counts as finished, so let me pin both.
    expect(deriveProgress(finished, ENV_ID)).toBe(0.5)
  })

  it('counts a failed child as finished rather than as pending work', () => {
    // Otherwise a business can appear 80% done with 40% of it failed.
    const state = reduceEnterpriseState([
      {
        type: 'enterprise.environment.created',
        recordedAt: T0,
        payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'Site', at: T0 },
      },
      {
        type: 'enterprise.task.created',
        recordedAt: T0,
        payload: { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 },
      },
      {
        type: 'enterprise.task.state-changed',
        recordedAt: T0,
        payload: { taskId: 't1', environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', at: T0 },
      },
      { type: 'enterprise.task.failed', recordedAt: T0, payload: { taskId: 't1', environmentId: ENV_ID, code: 'x', at: T0 } },
    ]).state
    expect(deriveProgress(state, ENV_ID)).toBe(1)
  })

  it('surfaces uncertainty rather than hiding it', () => {
    const state = reduceEnterpriseState([
      {
        type: 'enterprise.environment.created',
        recordedAt: T0,
        payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'Site', at: T0 },
      },
      {
        type: 'enterprise.webzone-operation.started',
        recordedAt: T0,
        payload: {
          operationId: 'op-1',
          environmentId: ENV_ID,
          kind: 'publish',
          target: 'https://example.com/',
          at: T0,
        },
      },
    ]).state
    const uncertainty = deriveUncertainty(state, ENV_ID)
    expect(uncertainty.join(' ')).toContain('not been verified')
  })

  it('names a blocked environment specifically', () => {
    expect(deriveBlockedReason(initialEnterpriseState(), 'nope')).toContain('not in the durable record')
  })

  it('proposes no next action from an idle state', () => {
    expect(deriveNextBoundedAction(initialEnterpriseState())).toBeNull()
  })
})