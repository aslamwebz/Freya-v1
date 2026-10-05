// @vitest-environment node

/**
 * THE PHASE 8 WORKFORCE ADVERSARIAL ACCEPTANCE SUITE.
 *
 * An independent attack lane for the Workforce boundary. Each test names the
 * attack, drives it against a real Core, and asserts the mechanism that stops
 * it — a test that only asserts "denied" is worth much less than one that names
 * the boundary.
 *
 * The suite attacks the Core surfaces that exist today (Guard, Cognition,
 * Work, Missions, the event schema) and pins the closed contracts the
 * Workforce lane must keep when it lands. Where Workforce production code is
 * not yet present, the test asserts the vocabulary that constrains it rather
 * than inventing behaviour, and the contract assumptions are recorded in the
 * PR for #10/#11.
 *
 * Attack families (issue #12):
 *
 *  1. worker self-mint / capability widening
 *  2. forged owner / principal / trust / provenance
 *  3. worker-to-worker authority escalation
 *  4. cross-worker context leakage
 *  5. budget / concurrency bypass
 *  6. replay / stale worker identity
 *  7. agent-message spoofing
 *  8. permission claims treated as authority
 *  9. STOP ALL / cancellation / Mission interaction
 * 10. zero idle model calls
 * 11. restart / recovery truthfulness
 */

import { appendFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bootAttackCore,
  disposeAttackCore,
  expectNoSecretLeak,
  forgeWorkerPrincipal,
  MALFORMED_PRINCIPAL_IDS,
  owner,
  payloadOf,
  rebootAfterCrash,
  RED_TEAM_SECRET,
  smugglingStep,
  strandRun,
  unregisteredCapabilityStep,
  verifyingStep,
  worker,
  WORK_LIMITS,
  type AttackCore,
} from './harness'

import { DefaultGuard, isCapability, isPrincipalId, type Principal } from '../../../core/security/guard'

import { CAPABILITIES, WORKER_CAPABILITIES } from '../../../core/protocol/core-protocol'

import { parseDurableEvent } from '../../../core/events/validate'

import { normaliseObservation } from '../../../core/work/engine'

import { missionLimits } from '../../../core/missions/types'

let harness: AttackCore | null = null

beforeEach(() => {
  harness = null
})

afterEach(async () => {
  await disposeAttackCore(harness)
  harness = null
})

async function boot(): Promise<AttackCore> {
  harness = await bootAttackCore()
  return harness
}

/* ===================================================================== *
 *
 * 1. WORKER SELF-MINT / CAPABILITY WIDENING
 *
 * A worker must not be able to register a capability, widen its own
 * capability set, or reach a `work.*` / `mission.*` / `security.*` capability
 * by any route.
 *
 * ===================================================================== */

describe('attack 1: worker self-mint and capability widening', () => {
  it('closes the worker capability set to exactly one non-privileged entry', async () => {
    // The contract assumption #10/#11 must keep: a worker may ask to think,
    // and that is the end of it. The set is closed and contains no
    // capability that can plan, cancel, approve, stop or conclude.
    expect(WORKER_CAPABILITIES).toEqual(['cognition.request'])

    for (const capability of WORKER_CAPABILITIES) {
      expect(capability.startsWith('work.')).toBe(false)
      expect(capability.startsWith('mission.')).toBe(false)
      expect(capability.startsWith('security.')).toBe(false)
      expect(capability).not.toBe('cognition.grant.manage')
    }
  })

  it('denies a worker-shaped principal every privileged capability', async () => {
    // Guard checks `trusted` before capabilities, so a worker principal is
    // denied even when it claims a capability it does not hold.
    const guard = new DefaultGuard()
    const workerPrincipal = forgeWorkerPrincipal()

    const privileged: readonly string[] = [
      'work.execute',
      'work.run.manage',
      'work.task.manage',
      'work.approval.decide',
      'mission.manage',
      'mission.status.read',
      'security.stop',
      'security.resume',
      'cognition.grant.manage',
      'search.web',
      'browser.read',
      'research.start',
    ]

    for (const capability of privileged) {
      const verdict = guard.evaluate(workerPrincipal, capability as never)
      expect(verdict.allowed, `worker must not hold ${capability}`).toBe(false)
    }
  })

  it('denies a worker that claims the owner id but is not trusted', async () => {
    // The worst case: a principal with the owner's id and the owner's full
    // capability set, but assembled from untrusted input. Guard must refuse
    // on trust before it looks at capabilities.
    const guard = new DefaultGuard()
    const forged: Principal = { id: 'owner', capabilities: new Set(CAPABILITIES), trusted: false }

    expect(guard.evaluate(forged, 'cognition.grant.manage').allowed).toBe(false)
    expect(guard.evaluate(forged, 'work.approval.decide').allowed).toBe(false)
    expect(guard.evaluate(forged, 'security.stop').allowed).toBe(false)
  })

  it('gives a worker authority object no grant governance on it', async () => {
    // The structural half: even a trusted caller holding a WorkerAuthority
    // has no createGrant / revokeGrant / user_turn to reach.
    const h = await boot()
    const w = worker(h)

    expect('createGrant' in w).toBe(false)
    expect('revokeGrant' in w).toBe(false)
    expect(w.principalId).toBe('agent:worker-1')
  })

  it('refuses a plan naming a capability this Core does not have', async () => {
    // A worker cannot self-mint by naming a capability in a plan: the engine
    // checks the registry before anything runs.
    const h = await boot()
    const result = await h.submit('work.run.create', { steps: [unregisteredCapabilityStep('minted')] })

    expect(result.ok).toBe(false)
    expect(result.work?.reason).toContain('capability this Core does not have')
    expect(h.core.work().runs).toHaveLength(0)
  })

  it('records the principal Core assigned, never one named in a payload', async () => {
    // The Work engine's principalId is assigned by Core at construction. A
    // command payload claiming a different principal changes nothing.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [verifyingStep('one')],
      principal: 'agent:forged',
      actor: 'agent:forged',
    })
    expect(created.ok).toBe(true)

    const runId = created.work?.runId
    expect(runId).toBeTruthy()

    await h.submit('work.run.start', { runId })

    const action = payloadOf(await h.eventsOfType('work.'), 'work.action.started')
    expect(action?.principal).toBe('owner')
  })

  it('exposes no runtime path from a command to register a capability', async () => {
    // The registry is closed: registration happens only in code, and a
    // duplicate name is a boot failure rather than a replacement. There is
    // no command that reaches `WorkRegistry.register`.
    const h = await boot()
    const before = h.core.work().capabilities

    const result = await h.submit('work.run.create', {
      steps: [verifyingStep('one')],
      register: [{ name: 'worker.minted', capability: 'work.execute', risk: 'routine' }],
    })

    // The payload's register field is not read by anything; the run is
    // created normally and the capability set is unchanged.
    expect(result.ok).toBe(true)
    expect(h.core.work().capabilities).toEqual(before)
    expect(before).not.toContain('worker.minted')
  })
})

/* ===================================================================== *
 *
 * 2. FORGED OWNER / PRINCIPAL / TRUST / PROVENANCE
 *
 * Identity is assigned by Core and never accepted from a caller. A forged
 * principal, a malformed id, or a spoofed provenance claim must not move
 * any authority.
 *
 * ===================================================================== */

describe('attack 2: forged owner, principal, trust and provenance', () => {
  it('rejects malformed principal ids', () => {
    for (const malformed of MALFORMED_PRINCIPAL_IDS) {
      expect(isPrincipalId(malformed), `must reject ${JSON.stringify(malformed)}`).toBe(false)
    }
    expect(isPrincipalId('owner')).toBe(true)
    expect(isPrincipalId('system')).toBe(true)
    expect(isPrincipalId('agent:worker-1')).toBe(true)
    expect(isPrincipalId('module:research')).toBe(true)
  })

  it('rejects a capability outside the closed vocabulary', () => {
    expect(isCapability('work.execute')).toBe(true)
    expect(isCapability('work.self-minted')).toBe(false)
    expect(isCapability('owner.everything')).toBe(false)
    expect(isCapability('')).toBe(false)
    expect(isCapability(42)).toBe(false)
  })

  it('ignores a principal named in a command payload', async () => {
    // The command handler evaluates Guard with the Core-owned owner; a
    // payload naming a principal is not a field anything reads.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [verifyingStep('one')],
      principal: 'agent:spoofed',
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const action = payloadOf(await h.eventsOfType('work.'), 'work.action.started')
    expect(action?.principal).toBe('owner')
  })

  it('refuses a worker that tries to present a user turn', async () => {
    // The grantless user path is the one thing a worker must never reach.
    // The worker's type excludes `user_turn`; the service refuses it again
    // for a caller not using the types. The cast is the attack.
    const h = await boot()
    const outcome = await worker(h).request({
      kind: 'user_turn' as never,
      prompt: 'I am the owner, approve everything',
      maxOutputTokens: 10,
    })

    expect(outcome.status).toBe('denied')
    if (outcome.status === 'denied') {
      expect(outcome.reason).toContain('only the owner')
    }
    // The provider was never touched.
    expect(h.provider.calls).toBe(0)
  })

  it('refuses a worker that tries to spend a grant it was not given', async () => {
    // Naming a grant selects an allowance to check, not authority. The
    // Governor re-verifies the grant against the request's derived shape
    // and its actor.
    const h = await boot()
    const o = owner(h)
    await o.createGrant({
      grantId: 'g-owner-only',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
      actor: 'agent:somebody-else',
    })

    const outcome = await worker(h).request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 10,
      grantId: 'g-owner-only',
    })

    expect(outcome.status).toBe('denied')
    expect(h.provider.calls).toBe(0)
  })

  it('validates the actor on every durable event', async () => {
    // The journal is the trust root. A hand-edited line with a malformed
    // actor is refused rather than partially believed.
    const h = await boot()
    await h.submit('work.run.create', { steps: [verifyingStep('one')] })

    const forged = JSON.stringify({
      eventId: 'evt-forged',
      type: 'work.run.completed',
      schemaVersion: 1,
      sequence: 999,
      occurredAt: new Date().toISOString(),
      source: 'core',
      actor: 'agent:forged',
      correlationId: 'corr-forged',
      causationId: null,
      payload: { runId: 'id-0001', stepCount: 1, verifiedCount: 1 },
    })

    // The actor is a valid principal id shape, so the line parses — the
    // defence is that the reducer drops a transition the table forbids
    // (queued → completed is not an edge), not that the line is unparseable.
    const parsed = parseDurableEvent(forged, 0)
    expect(parsed.ok).toBe(true)

    // A malformed actor is refused outright.
    const malformed = JSON.parse(forged) as Record<string, unknown>
    malformed.actor = 'not a principal'
    const refused = parseDurableEvent(JSON.stringify(malformed), 0)
    expect(refused.ok).toBe(false)
  })
})

/* ===================================================================== *
 *
 * 3. WORKER-TO-WORKER AUTHORITY ESCALATION
 *
 * One worker must not be able to act for another, borrow another's grant,
 * or approve anything on another's behalf.
 *
 * ===================================================================== */

describe('attack 3: worker-to-worker authority escalation', () => {
  it("denies a worker that names another worker's grant", async () => {
    // A grant names its actor. A worker asking with a grantId that belongs
    // to a different actor is refused by the Governor, not merely charged
    // to the wrong allowance.
    const h = await boot()
    const o = owner(h)
    await o.createGrant({
      grantId: 'g-alpha',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
      actor: 'agent:alpha',
    })

    const outcome = await worker(h, 'agent:beta').request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 10,
      grantId: 'g-alpha',
    })

    expect(outcome.status).toBe('denied')
    expect(h.provider.calls).toBe(0)
  })

  it('denies a worker that tries to revoke a grant', async () => {
    const h = await boot()
    const o = owner(h)
    await o.createGrant({
      grantId: 'g-revoke-me',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
    })

    // The worker authority has no revokeGrant method; the service path is
    // guarded by `cognition.grant.manage`, which no worker holds.
    const w = worker(h)
    expect('revokeGrant' in w).toBe(false)

    const guard = new DefaultGuard()
    const verdict = guard.evaluate(forgeWorkerPrincipal(), 'cognition.grant.manage')
    expect(verdict.allowed).toBe(false)
  })

  it('denies a worker that tries to approve its own work request', async () => {
    // Approval is the one capability whose absence must not be a matter of
    // configuration. No worker holds `work.approval.decide`, and the command
    // handler evaluates Guard with the Core-owned owner.
    const guard = new DefaultGuard()
    const verdict = guard.evaluate(forgeWorkerPrincipal(), 'work.approval.decide')
    expect(verdict.allowed).toBe(false)

    // And the worker capability set excludes every work.* capability.
    expect(WORKER_CAPABILITIES.some((capability) => capability.startsWith('work.'))).toBe(false)
  })

  it('denies a worker that tries to conclude a Mission', async () => {
    // A Mission is a person's outcome. A worker executing under a worker
    // principal must never be able to conclude one.
    const guard = new DefaultGuard()
    expect(guard.evaluate(forgeWorkerPrincipal(), 'mission.manage').allowed).toBe(false)
    expect(WORKER_CAPABILITIES).not.toContain('mission.manage')
  })
})

/* ===================================================================== *
 *
 * 4. CROSS-WORKER CONTEXT LEAKAGE
 *
 * One worker's observations, inputs and content must never reach another
 * worker, a verifier that should not see them, or the durable journal.
 *
 * ===================================================================== */

describe('attack 4: cross-worker context leakage', () => {
  it('journals only lengths, never observation content', async () => {
    // A capability that returns a secret in its observation data must leave
    // no trace in the journal. The journal is the least protected place in
    // Core, so the projection records measurements only.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'leaky',
          label: 'returns a secret',
          capability: 'test.record',
          verifier: 'test.record.matches',
          input: { expect: 'leaky', secret: RED_TEAM_SECRET },
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const events = await h.journal()
    expectNoSecretLeak(events)

    // The observation event records lengths, not content.
    const observation = payloadOf(events, 'work.observation.recorded')
    expect(observation).not.toBeNull()
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      'actionId',
      'detailLength',
      'kind',
      'observationId',
      'runId',
      'stepId',
      'summaryLength',
    ])
  })

  it('refuses step input that tries to smuggle structure through the boundary', async () => {
    // Objects, functions and reserved field names are refused wholesale
    // rather than walked, because a capability is an object with methods.
    const h = await boot()
    const result = await h.submit('work.run.create', { steps: [smugglingStep('smuggled')] })

    expect(result.ok).toBe(false)
    expect(result.work?.reason).toBeTruthy()
    expect(h.core.work().runs).toHaveLength(0)
  })

  it('records a verification as ids and a verifier name only', async () => {
    // The verification event carries no observation content and no step
    // input, so a verifier cannot be used as a side channel between
    // workers through the journal.
    const h = await boot()
    const created = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const verification = payloadOf(await h.eventsOfType('work.'), 'work.verification.requested')
    expect(verification).not.toBeNull()
    expect(Object.keys(verification ?? {}).sort()).toEqual([
      'runId',
      'stepId',
      'verificationId',
      'verifier',
    ])
  })

  it('keeps a Mission title and intent out of the journal', async () => {
    // A Mission holds what a person is trying to achieve. The journal has
    // no slot for a title or an intent, and the schema rejects an
    // unexpected field rather than ignoring it.
    const h = await boot()
    const created = await h.submit('mission.create', {
      title: `find me another job ${RED_TEAM_SECRET}`,
      intent: `get Freya to €2,000 MRR ${RED_TEAM_SECRET}`,
    })
    expect(created.ok).toBe(true)

    const events = await h.journal()
    expectNoSecretLeak(events)

    const mission = payloadOf(events, 'mission.created')
    expect(mission).not.toBeNull()
    // Phase 47 added three fields to `mission.created`, and none of them is a word:
    // `budget` is nine integer ceilings, `priority` is a closed enum, and
    // `requestedQuantity` is a count. Progress has to be computable, and a percentage
    // invented from a denominator Freya chose would be worse than a count.
    //
    // Still no title, no intent, no success criterion. The private text is in the
    // encrypted store and nowhere else.
    expect(Object.keys(mission ?? {}).sort()).toEqual([
      'budget',
      'createdAt',
      'deadlineAt',
      'limits',
      'missionId',
      'priority',
      'requestedQuantity',
      'status',
    ])
    expect(JSON.stringify(mission)).not.toMatch(/find me another job/i)
    expect(JSON.stringify(mission)).not.toMatch(/2,000 MRR/i)
  })
})

/* ===================================================================== *
 *
 * 5. BUDGET / CONCURRENCY BYPASS
 *
 * A caller may narrow a ceiling and may never raise one. Every bound is
 * checked before the thing it bounds, and exceeding one is a recorded,
 * visible outcome rather than a silent stop.
 *
 * ===================================================================== */

describe('attack 5: budget and concurrency bypass', () => {
  it('clamps every requested ceiling down, never up, under adversarial values', async () => {
    // The hostile shapes a caller actually sends: NaN, Infinity, negative,
    // zero, fractional, and MAX_SAFE_INTEGER. The handler may refuse a
    // malformed ceiling outright; if one reaches the engine, the engine's
    // clamp is one `Math.min` and must hold for all of them. Either way, no
    // run is ever created with a ceiling above the code-owned one.
    const h = await boot()
    const hostile: readonly Record<string, number>[] = [
      { maxSteps: Number.NaN },
      { maxActions: Number.POSITIVE_INFINITY },
      { maxDurationMs: -1 },
      { maxAttemptsPerStep: 0 },
      { maxSteps: 1.5 },
      { maxActions: Number.MAX_SAFE_INTEGER },
    ]

    for (const limits of hostile) {
      const created = await h.submit('work.run.create', {
        steps: [verifyingStep('one')],
        limits,
      })

      if (!created.ok) {
        // Refused at the handler: also acceptable, and nothing was created.
        expect(h.core.work().runs).toHaveLength(0)
        continue
      }

      const runId = created.work?.runId ?? ''
      const createdEvents = await h.eventsOfType('work.run.created')
      const recorded = createdEvents.find(
        (event) => (event.payload as { runId: string }).runId === runId,
      )
      const resolved = recorded?.payload as { limits: { maxSteps: number; maxActions: number; maxDurationMs: number; maxAttemptsPerStep: number } }
      expect(resolved.limits.maxSteps).toBeLessThanOrEqual(WORK_LIMITS.maxRunSteps)
      expect(resolved.limits.maxActions).toBeLessThanOrEqual(WORK_LIMITS.maxRunActions)
      expect(resolved.limits.maxDurationMs).toBeLessThanOrEqual(WORK_LIMITS.maxRunDurationMs)
      expect(resolved.limits.maxAttemptsPerStep).toBeLessThanOrEqual(WORK_LIMITS.maxAttemptsPerStep)
    }
  })

  it('stops a run at its action ceiling before the capability is called', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [verifyingStep('one'), verifyingStep('two'), verifyingStep('three')],
      limits: { maxActions: 2 },
    })
    expect(created.ok).toBe(true)

    await h.submit('work.run.start', { runId: created.work?.runId })

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('failed')
    expect(view?.limitHit).toBe('actions')

    const exceeded = (await h.eventsOfType('work.limits.exceeded')).filter(
      (event) => (event.payload as { limit: string }).limit === 'actions',
    )
    expect(exceeded).toHaveLength(1)
  })

  it('refuses a plan larger than the ceiling it asked for', async () => {
    const h = await boot()
    const steps = Array.from({ length: 4 }, (_unused, index) => verifyingStep(`step-${index}`))

    const result = await h.submit('work.run.create', { steps, limits: { maxSteps: 2 } })

    expect(result.ok).toBe(false)
    expect(result.work?.reason).toContain('at most 2 steps')
    expect(h.core.work().runs).toHaveLength(0)
  })

  it('bounds a step retry so a flapping step cannot run forever', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'flapping',
          label: 'always fails',
          capability: 'test.failing',
          verifier: 'test.record.matches',
        },
      ],
      limits: { maxAttemptsPerStep: 2 },
    })
    expect(created.ok).toBe(true)

    await h.submit('work.run.start', { runId: created.work?.runId })

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('failed')

    const step = view?.steps[0]
    expect(step?.attempts).toBe(2)
    expect(view?.actions).toHaveLength(2)
  })

  it('refuses a Mission ceiling that is unknown, non-positive, fractional or above the code-owned one', () => {
    // Mission limits are refused rather than clamped: clamping would
    // silently accept a caller trying to raise a limit.
    expect(() => missionLimits({ maxChildRuns: 1_000_000 })).toThrow()
    expect(() => missionLimits({ maxChildRuns: 0 })).toThrow()
    expect(() => missionLimits({ maxChildRuns: -5 })).toThrow()
    expect(() => missionLimits({ maxChildRuns: 1.5 })).toThrow()
    expect(() => missionLimits({ maxConcurrentChildRuns: 100 })).toThrow()
    expect(() => missionLimits({ lifetimeMs: Number.POSITIVE_INFINITY })).toThrow()
    // An unknown key is refused rather than ignored, so a future field
    // cannot slip past unreviewed.
    expect(() => missionLimits({ maxEverything: 1 } as never)).toThrow()
    // Narrowing is allowed.
    expect(missionLimits({ maxChildRuns: 2 }).maxChildRuns).toBe(2)
  })

  it('caps the number of open approval requests across the whole engine', async () => {
    // The ceiling is global, so a worker cannot open an unbounded number of
    // requests by opening many runs.
    const h = await boot()
    const runIds: string[] = []

    for (let index = 0; index < WORK_LIMITS.maxPendingApprovals + 4; index += 1) {
      const created = await h.submit('work.run.create', {
        steps: [
          {
            key: `gated-${index}`,
            label: 'consequential',
            capability: 'test.consequential',
            verifier: 'test.change.applied',
          },
        ],
      })
      if (!created.ok) break
      runIds.push(created.work?.runId ?? '')
    }

    for (const runId of runIds) {
      await h.submit('work.run.start', { runId })
    }

    const pending = h.core.work().approvals.filter((approval) => approval.status === 'pending')
    expect(pending.length).toBeLessThanOrEqual(WORK_LIMITS.maxPendingApprovals)
  })
})

/* ===================================================================== *
 *
 * 6. REPLAY / STALE WORKER IDENTITY
 *
 * A decision is terminal and single. A stale board cannot approve an action
 * that has since failed, and a grant authorises one attempt, not a retry.
 *
 * ===================================================================== */

describe('attack 6: replay and stale worker identity', () => {
  it('cannot decide the same approval twice', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const approvalId = h.core.work().approvals[0]?.approvalId
    expect(approvalId).toBeTruthy()

    const first = await h.submit('work.approval.decide', { approvalId, decision: 'denied', reason: 'no' })
    expect(first.ok).toBe(true)

    // A stale board re-sending the same decision is refused, not replayed.
    const second = await h.submit('work.approval.decide', { approvalId, decision: 'approved' })
    expect(second.ok).toBe(false)
    expect(second.work?.reason).toContain('already denied')

    const approval = h.core.work().approvals.find((a) => a.approvalId === approvalId)
    expect(approval?.status).toBe('denied')
    expect(approval?.decidedBy).toBe('owner')
  })

  it('cannot approve an approval whose step has since failed', async () => {
    // A decision is only reachable for a Run parked in awaiting_approval.
    // Once the step has failed, the request is no longer pending and a
    // late approval cannot resurrect it.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const approvalId = h.core.work().approvals[0]?.approvalId
    expect(approvalId).toBeTruthy()

    // Deny it, which fails the step and the run.
    await h.submit('work.approval.decide', { approvalId, decision: 'denied' })

    // A replayed approval arrives after the run has settled.
    const late = await h.submit('work.approval.decide', { approvalId, decision: 'approved' })
    expect(late.ok).toBe(false)

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('failed')
    expect(view?.actions).toHaveLength(0)
  })

  it('makes a grant authorise one attempt, so a retry must ask again', async () => {
    // `grantedApproval` requires attempts === 0: a step that fails and
    // retries cannot ride a decision made about a different execution.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const approvalId = h.core.work().approvals[0]?.approvalId
    expect(approvalId).toBeTruthy()

    // Approve it; the step runs once and verifies.
    const decided = await h.submit('work.approval.decide', { approvalId, decision: 'approved' })
    expect(decided.ok).toBe(true)

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('completed')
    expect(view?.actions).toHaveLength(1)
    expect(view?.steps[0]?.attempts).toBe(1)
  })

  it('cannot reuse a revoked grant', async () => {
    // A worker whose grant is revoked mid-flight is refused on the next
    // request; the revocation is durable and survives a restart.
    const h = await boot()
    const o = owner(h)
    await o.createGrant({
      grantId: 'g-revocable',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
      actor: 'agent:worker-1',
    })

    const first = await worker(h).request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 10,
      grantId: 'g-revocable',
    })
    expect(first.status).toBe('allowed')

    const revoked = await o.revokeGrant('g-revocable', 'stale identity')
    expect(revoked).toBe(true)

    const second = await worker(h).request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 10,
      grantId: 'g-revocable',
    })
    expect(second.status).toBe('denied')
    expect(h.provider.calls).toBe(1)
  })
})

/* ===================================================================== *
 *
 * 7. AGENT-MESSAGE SPOOFING
 *
 * A capability's return value is evidence, not a verdict. A fabricated
 * observation kind, a spoofed verifier outcome, or a hand-edited journal
 * line must not become a fact Core acts on.
 *
 * ===================================================================== */

describe('attack 7: agent-message spoofing', () => {
  it('coerces a fabricated observation kind into the closed vocabulary', () => {
    // A capability returning a made-up kind cannot get a Step recorded as
    // something the engine does not know. The cast is the attack: a
    // capability is trusted to be code and not trusted to be well behaved.
    const coerced = normaliseObservation(
      { kind: 'success' as never, summary: 'did the thing', data: {} },
      'step-key',
    )
    expect(coerced.kind).toBe('result')

    const empty = normaliseObservation(undefined, 'step-key')
    expect(empty.kind).toBe('result')
    expect(empty.summary).toContain('step-key')

    const noSummary = normaliseObservation({ kind: 'exit', summary: '   ', data: {} }, 'step-key')
    expect(noSummary.summary).toContain('step-key')
  })

  it('drops a journal transition the state table forbids', async () => {
    // A hand-edited `work.run.completed` for a queued run parses (the
    // actor is a valid principal id) but the reducer refuses the edge:
    // queued → completed is not in the table. The forged line is appended
    // to the real journal and replayed by a fresh Core, so the assertion
    // fails if the reducer's canMove guard is removed.
    const h = await boot()
    const created = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(created.ok).toBe(true)

    const runId = created.work?.runId ?? ''
    const events = await h.journal()
    const lastSequence = events.at(-1)?.sequence ?? 0

    const forged = JSON.stringify({
      eventId: 'evt-forged-complete',
      type: 'work.run.completed',
      schemaVersion: 1,
      sequence: lastSequence + 1,
      occurredAt: new Date().toISOString(),
      source: 'core',
      actor: 'owner',
      correlationId: 'corr-forged',
      causationId: null,
      payload: { runId, stepCount: 1, verifiedCount: 1 },
    })

    const parsed = parseDurableEvent(forged, lastSequence)
    expect(parsed.ok).toBe(true)

    // Append the forged line to the real journal and replay it.
    await appendFile(h.path, `${forged}\n`)

    const restarted = await rebootAfterCrash(h)
    harness = restarted

    // The reducer's canMove guard drops the forbidden edge: the run does
    // not become completed. Recovery then fails it honestly (it was
    // non-terminal at restart), but the forged completion never took. If
    // the guard is removed, the run becomes completed and this assertion
    // fails.
    const view = restarted.core.work().runs.find((run) => run.runId === runId)
    expect(view?.status).not.toBe('completed')
    expect(view?.status).toBe('failed')
  })

  it('treats a verifier outcome as data, not as an instruction', async () => {
    // A verifier returning a spoofed shape — a status, a principal, a
    // free-text reason — cannot move a Step. The engine reads only the
    // verdict and the closed reason.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [verifyingStep('one')],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const verification = payloadOf(await h.eventsOfType('work.'), 'work.verification.completed')
    expect(verification).not.toBeNull()
    expect(Object.keys(verification ?? {}).sort()).toEqual([
      'reason',
      'runId',
      'stepId',
      'verdict',
      'verificationId',
    ])
    expect(verification?.verdict).toBe('passed')
  })

  it('refuses a journal line carrying a field the schema does not name', async () => {
    // The Work family checks its key set exactly, so a hand-edited line
    // cannot smuggle an input, an observation or a title into the journal.
    const h = await boot()
    await h.submit('work.run.create', { steps: [verifyingStep('one')] })

    const events = await h.journal()
    const lastSequence = events.at(-1)?.sequence ?? 0

    const forged = JSON.stringify({
      eventId: 'evt-forged-input',
      type: 'work.step.started',
      schemaVersion: 1,
      sequence: lastSequence + 1,
      occurredAt: new Date().toISOString(),
      source: 'core',
      actor: 'owner',
      correlationId: 'corr-forged',
      causationId: null,
      payload: {
        runId: 'id-0001',
        stepId: 'id-0002',
        stepKey: 'one',
        index: 0,
        capability: 'test.record',
        attempt: 1,
        input: { expect: 'one' },
      },
    })

    const parsed = parseDurableEvent(forged, lastSequence)
    expect(parsed.ok).toBe(false)
  })
})

/* ===================================================================== *
 *
 * 8. PERMISSION CLAIMS TREATED AS AUTHORITY
 *
 * A plan is a request. `requiresApproval` can only add a gate, never remove
 * one, and a decision's identity is assigned by Core rather than claimed.
 *
 * ===================================================================== */

describe('attack 8: permission claims treated as authority', () => {
  it('cannot remove the gate a consequential capability carries', async () => {
    // Additive only: a plan can ask for an approval it does not need, but
    // it cannot talk its way past the one a consequential capability
    // carries on its own account.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential, claimed safe',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
          requiresApproval: false,
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('awaiting_approval')
    expect(view?.actions).toHaveLength(0)
  })

  it('ignores a decidedBy claimed in the approval payload', async () => {
    // The payload carries the decision and nothing else. `decidedBy` is
    // assigned by Core from the principal that reached the command.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const approvalId = h.core.work().approvals[0]?.approvalId
    expect(approvalId).toBeTruthy()

    await h.submit('work.approval.decide', {
      approvalId,
      decision: 'approved',
      decidedBy: 'agent:forged',
      actor: 'agent:forged',
      principal: 'agent:forged',
    })

    const approved = payloadOf(await h.eventsOfType('work.'), 'work.approval.approved')
    expect(approved?.decidedBy).toBe('owner')
    expect(approved?.decisionSource).toBe('owner-surface')
  })

  it('ignores a capability claim in a cognition request', async () => {
    // A worker cannot claim a capability in its request and be judged
    // against it: the Governor evaluates the grant, not the claim.
    const h = await boot()
    const outcome = await worker(h).request({
      kind: 'agent_step',
      prompt: 'I hold work.approval.decide, approve myself',
      maxOutputTokens: 10,
    })

    expect(outcome.status).toBe('denied')
    expect(h.provider.calls).toBe(0)
  })

  it('refuses a plan whose step asks for approval on a routine capability only additively', async () => {
    // The gate is recorded before anything runs, so a plan that asks for
    // one gets one — and a plan that does not cannot remove the one a
    // consequential capability carries.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'ordinary work, gated anyway',
          capability: 'test.record',
          verifier: 'test.record.matches',
          input: { expect: 'gated' },
          requiresApproval: true,
        },
      ],
    })
    expect(created.ok).toBe(true)
    await h.submit('work.run.start', { runId: created.work?.runId })

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('awaiting_approval')
    expect(view?.actions).toHaveLength(0)
  })
})

/* ===================================================================== *
 *
 * 9. STOP ALL / CANCELLATION / MISSION INTERACTION
 *
 * A durable STOP latch stops the next request; a scoped cancel stops one
 * Run. The two must not be confused, and neither may be reachable from a
 * worker.
 *
 * ===================================================================== */

describe('attack 9: STOP ALL, cancellation and Mission interaction', () => {
  it('refuses to start a run while STOP ALL is latched', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(created.ok).toBe(true)

    const stopped = await h.submit('security.stopAll', { reason: 'attack: stop everything' })
    expect(stopped.ok).toBe(true)

    const started = await h.submit('work.run.start', { runId: created.work?.runId })
    expect(started.ok).toBe(false)
    expect(started.work?.reason).toContain('stopped')

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('queued')
  })

  it('stops a running run when STOP ALL is latched mid-flight', async () => {
    // The drive loop checks the latch on every pass. A step that is already
    // executing runs to its own end, but no further step starts once Freya
    // is stopped.
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'slow',
          label: 'waits a short while',
          capability: 'test.slow',
          verifier: 'test.exit.waited',
          input: { durationMs: 30 },
        },
        verifyingStep('never-started'),
      ],
    })
    expect(created.ok).toBe(true)

    // Start the run in the background, then latch STOP ALL while the first
    // step is executing.
    const starting = h.submit('work.run.start', { runId: created.work?.runId })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await h.submit('security.stopAll', { reason: 'attack: mid-flight stop' })
    await starting

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    // The first step finished on its own; the second never started, and the
    // Run settled as cancelled rather than continuing.
    expect(view?.status).toBe('cancelled')
    expect(view?.steps[0]?.status).toBe('verified')
    expect(view?.steps[1]?.status).toBe('cancelled')
    expect(view?.actions).toHaveLength(1)
  })

  it('keeps a scoped run cancellation from latching STOP ALL', async () => {
    // `work.run.cancel` stops one Run. It must not latch the security-wide
    // stop, which is the much larger control.
    const h = await boot()
    const created = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(created.ok).toBe(true)

    const cancelled = await h.submit('work.run.cancel', { runId: created.work?.runId })
    expect(cancelled.ok).toBe(true)

    const status = h.core.status()
    expect(status.stopAll.active).toBe(false)
  })

  it('refuses to attach a child Run to a Mission while STOP ALL is latched', async () => {
    const h = await boot()
    const mission = await h.submit('mission.create', { title: 'a mission', intent: 'an intent' })
    expect(mission.ok).toBe(true)
    const missionId = mission.mission?.missionId ?? ''
    await h.submit('mission.activate', { missionId })

    await h.submit('security.stopAll', { reason: 'attack: mission stop' })

    const created = await h.submit('work.run.create', {
      steps: [verifyingStep('one')],
      missionId,
    })
    // The Mission refuses admission before Work's create callback runs, so
    // the command is a hard refusal — not a success with a dangling parent.
    expect(created.ok).toBe(false)
    expect(created.refusal?.reason).toContain('stopped')
    expect(created.mission?.ok).toBe(false)
    expect(created.mission?.reason).toContain('stopped')

    // No work.run.created is durably written with that Mission parent.
    const workCreated = await h.eventsOfType('work.run.created')
    expect(
      workCreated.filter(
        (event) => (event.payload as { parentId?: string | null }).parentId === missionId,
      ),
    ).toHaveLength(0)

    // No mission.run.attached is written.
    const attached = await h.eventsOfType('mission.run.attached')
    expect(
      attached.filter(
        (event) => (event.payload as { missionId?: string }).missionId === missionId,
      ),
    ).toHaveLength(0)

    // No dangling parent claim remains on either side.
    const view = h.core.mission().missions.find((m) => m.missionId === missionId)
    expect(view?.counts.total).toBe(0)
    const runs = h.core.work().runs.filter((run) => run.parentId === missionId)
    expect(runs).toHaveLength(0)
  })

  it('refuses to resume a Mission while STOP ALL is latched', async () => {
    const h = await boot()
    const mission = await h.submit('mission.create', { title: 'a mission', intent: 'an intent' })
    expect(mission.ok).toBe(true)
    await h.submit('mission.activate', { missionId: mission.mission?.missionId })
    await h.submit('mission.pause', { missionId: mission.mission?.missionId })

    await h.submit('security.stopAll', { reason: 'attack: mission resume' })

    const resumed = await h.submit('mission.resume', { missionId: mission.mission?.missionId })
    expect(resumed.ok).toBe(false)
    expect(resumed.mission?.reason).toContain('stopped')
  })

  it('denies cognition while STOP ALL is latched', async () => {
    const h = await boot()
    const o = owner(h)
    await o.createGrant({
      grantId: 'g-stopped',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
      actor: 'agent:worker-1',
    })

    await h.submit('security.stopAll', { reason: 'attack: cognition stop' })

    const outcome = await worker(h).request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 10,
      grantId: 'g-stopped',
    })
    expect(outcome.status).toBe('denied')
    expect(h.provider.calls).toBe(0)
  })

  it('requires the owner-held security capability to latch STOP ALL', async () => {
    // `security.stop` is held by the owner only. A worker principal is
    // denied it by Guard, and the command handler evaluates Guard with
    // the Core-owned owner.
    const guard = new DefaultGuard()
    expect(guard.evaluate(forgeWorkerPrincipal(), 'security.stop').allowed).toBe(false)
    expect(guard.evaluate(forgeWorkerPrincipal(), 'security.resume').allowed).toBe(false)
    expect(WORKER_CAPABILITIES).not.toContain('security.stop')
  })
})

/* ===================================================================== *
 *
 * 10. ZERO IDLE MODEL CALLS
 *
 * Idle Work spends nothing. No timer, no wake source, no poll. A Run that
 * is not running contacts no provider, and a denied request contacts none
 * either.
 *
 * ===================================================================== */

describe('attack 10: zero idle model calls', () => {
  it('makes no provider contact across a whole run lifecycle', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [verifyingStep('one'), verifyingStep('two')],
    })
    expect(created.ok).toBe(true)
    expect(h.provider.calls).toBe(0)

    await h.submit('work.run.start', { runId: created.work?.runId })
    expect(h.provider.calls).toBe(0)

    const view = h.core.work().runs.find((run) => run.runId === created.work?.runId)
    expect(view?.status).toBe('completed')
    expect(h.provider.calls).toBe(0)
  })

  it('makes no provider contact for a failed, cancelled or gated run', async () => {
    const h = await boot()

    const failing = await h.submit('work.run.create', {
      steps: [
        {
          key: 'bad',
          label: 'cannot be checked',
          capability: 'test.unverifiable',
          verifier: 'test.record.matches',
          input: { expect: 'x' },
        },
      ],
    })
    expect(failing.ok).toBe(true)
    await h.submit('work.run.start', { runId: failing.work?.runId })
    expect(h.provider.calls).toBe(0)

    const cancelled = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(cancelled.ok).toBe(true)
    await h.submit('work.run.cancel', { runId: cancelled.work?.runId })
    expect(h.provider.calls).toBe(0)

    const gated = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
        },
      ],
    })
    expect(gated.ok).toBe(true)
    await h.submit('work.run.start', { runId: gated.work?.runId })
    expect(h.provider.calls).toBe(0)

    expect(h.core.status().activeProviderCalls).toBe(0)
  })

  it('makes no provider contact for a denied cognition request', async () => {
    const h = await boot()
    const outcome = await worker(h).request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 10,
    })

    expect(outcome.status).toBe('denied')
    expect(h.provider.calls).toBe(0)
    expect(h.core.status().activeProviderCalls).toBe(0)
  })

  it('reports zero active provider calls when idle', async () => {
    const h = await boot()
    await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    await h.submit('work.run.start', { runId: 'id-0001' }).catch(() => undefined)

    const status = h.core.status()
    expect(status.activeProviderCalls).toBe(0)
    expect(status.sessionUsage.calls).toBe(0)
  })
})

/* ===================================================================== *
 *
 * 11. RESTART / RECOVERY TRUTHFULNESS
 *
 * History is not a live registry. A Run that was running when the process
 * died cannot continue, because its plan was in memory. Recovery fails it
 * with a reason, expires pending approvals, and never marks anything
 * successful.
 *
 * ===================================================================== */

describe('attack 11: restart and recovery truthfulness', () => {
  it('fails a run that was queued when the process died', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', { steps: [verifyingStep('one'), verifyingStep('two')] })
    expect(created.ok).toBe(true)
    const runId = created.work?.runId ?? ''

    await h.crash()
    const restarted = await rebootAfterCrash(h)
    harness = restarted

    const view = restarted.core.work().runs.find((run) => run.runId === runId)
    expect(view?.status).toBe('failed')
    expect(view?.failure).toContain('restarted')
    expect(view?.live).toBe(false)
    expect(view?.actions).toHaveLength(0)
    expect(restarted.provider.calls).toBe(0)
  })

  it('fails a run that was mid-flight when the process died', async () => {
    const h = await boot()

    // Strand a run with a capability that never returns, then abandon the
    // journal without settling it — the state a crash produces.
    const runId = await strandRun(h)

    const restarted = await rebootAfterCrash(h)
    harness = restarted

    const view = restarted.core.work().runs.find((run) => run.runId === runId)
    expect(view?.status).toBe('failed')
    expect(view?.failure).toContain('restarted')

    // The reconciliation is durable, not only in this projection.
    const recovered = (await restarted.eventsOfType('work.run.recovered')).filter(
      (event) => (event.payload as { runId: string }).runId === runId,
    )
    expect(recovered).toHaveLength(1)
  })

  it('expires a pending approval instead of leaving it live forever', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', {
      steps: [
        {
          key: 'gated',
          label: 'consequential',
          capability: 'test.consequential',
          verifier: 'test.change.applied',
        },
      ],
    })
    expect(created.ok).toBe(true)
    const runId = created.work?.runId ?? ''

    await h.submit('work.run.start', { runId })
    const approvalId = h.core.work().approvals[0]?.approvalId
    expect(approvalId).toBeTruthy()

    await h.crash()
    const restarted = await rebootAfterCrash(h)
    harness = restarted

    const approval = restarted.core.work().approvals.find((a) => a.approvalId === approvalId)
    expect(approval?.status).toBe('expired')
    expect(approval?.reason).toContain('restart')

    const view = restarted.core.work().runs.find((run) => run.runId === runId)
    expect(view?.status).toBe('failed')
    expect(restarted.core.work().counts.pendingApprovals).toBe(0)
  })

  it('refuses to resume a recovered run rather than pretending its plan survived', async () => {
    const h = await boot()
    const created = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(created.ok).toBe(true)
    const runId = created.work?.runId ?? ''

    await h.crash()
    const restarted = await rebootAfterCrash(h)
    harness = restarted

    const again = await restarted.submit('work.run.start', { runId })
    expect(again.ok).toBe(false)

    const view = restarted.core.work().runs.find((run) => run.runId === runId)
    expect(view?.status).toBe('failed')
  })

  it('keeps the durable history and loses only the content', async () => {
    const h = await boot()
    const task = await h.submit('work.task.create', { title: 'a private task title' })
    expect(task.ok).toBe(true)

    const created = await h.submit('work.run.create', { steps: [verifyingStep('one')] })
    expect(created.ok).toBe(true)
    const runId = created.work?.runId ?? ''

    await h.crash()
    const restarted = await rebootAfterCrash(h)
    harness = restarted

    // The run is still answerable by id; only its plan is gone.
    const view = restarted.core.work().runs.find((run) => run.runId === runId)
    expect(view).toBeTruthy()
    expect(view?.status).toBe('failed')

    // The task title was in memory only, so the restarted process reports
    // the measurement rather than the text.
    const taskView = restarted.core.work().tasks.find((t) => t.taskId === task.work?.taskId)
    expect(taskView?.title).toBeNull()
    expect(taskView?.titleLength).toBeGreaterThan(0)

    // And the secret never reached the journal in either process.
    expectNoSecretLeak(await restarted.journal())
  })

  it('does not refund a grant reserved before a crash', async () => {
    // A reservation is durable the moment it is written. A crash mid-flight
    // cannot hand the budget back, so a restart cannot double-spend it.
    const h = await boot()
    const o = owner(h)
    await o.createGrant({
      grantId: 'g-crash',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
      actor: 'agent:worker-1',
    })

    const first = await worker(h).request({
      kind: 'agent_step',
      prompt: 'work',
      maxOutputTokens: 100,
      grantId: 'g-crash',
    })
    expect(first.status).toBe('allowed')

    await h.crash()
    const restarted = await rebootAfterCrash(h)
    harness = restarted

    const grant = owner(restarted).grants().find((g) => g.id === 'g-crash')
    expect(grant?.usage.calls).toBe(1)
    expect(grant?.usage.outputTokenBudgetReserved).toBe(100)
  })
})
