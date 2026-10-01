// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentStep,
  createAgentGrant,
  startRedTeamCore,
  stopRedTeamCore,
  type RedTeamCore,
} from './harness'
import { CAPABILITIES, WORKER_CAPABILITIES, type Capability } from '../../core/protocol/core-protocol'
import { DefaultGuard, type Principal } from '../../core/security/guard'

/**
 * Attack family: generic workers cannot self-mint capabilities.
 *
 * RED-TEAM families 7 (tool privilege escalation) and 8 (agent escalation /
 * confused deputy), against Constitution C8 (agents are subordinate) and the
 * Guard's "a model can never grant" rule.
 *
 * The attacks are structural rather than textual: a worker tries every
 * route by which authority could be minted — calling a method it was never
 * issued, claiming a capability it does not hold, escalating through the
 * vocabulary itself. The invariant under attack: a worker holds exactly
 * what Core issued it, and nothing it does can widen that.
 */

let fixture: RedTeamCore | null = null

beforeEach(async () => {
  fixture = await startRedTeamCore()
})

afterEach(async () => {
  await stopRedTeamCore(fixture)
  fixture = null
})

describe('attack: a worker reaches for grant governance methods', () => {
  it('finds none on the authority object it was issued', async () => {
    const f = fixture!
    const worker = f.worker
    // The worker authority's own shape is the first boundary: no grant
    // methods, no revoke methods, no user turn, no principal parameter.
    expect('createGrant' in worker).toBe(false)
    expect('revokeGrant' in worker).toBe(false)
    expect('grants' in worker).toBe(false)
    expect(Object.keys(worker).sort()).toEqual(['principalId', 'request'])
    // And the worker's principal id is what Core chose for it, so there is
    // no field to overwrite into an owner.
    expect(worker.principalId).not.toBe('owner')
  })

  it('exposes no authority issuance on the public Core interface', () => {
    const f = fixture!
    // The `Core` interface exposes no authority issuance; reaching it needs
    // the test seam in core/testing.ts, which exists so tests can drive it
    // and nothing else. The check has to be a compile-time probe: a runtime
    // `Object.keys` sweep sees only the instance's own data fields, never the
    // prototype methods, so it passes whatever the interface exposes.
    const c = f.core
    // @ts-expect-error Core exposes no owner authority issuance.
    void c.issueOwnerAuthority
    // @ts-expect-error Core exposes no worker authority issuance.
    void c.issueWorkerAuthority
    // @ts-expect-error Core exposes no principal factory.
    void c.ownerPrincipalFor
    expect(true).toBe(true)
  })
})

describe('attack: a worker claims capabilities it does not hold', () => {
  const asPrincipal = (
    id: string,
    capabilities: readonly string[],
    trusted: boolean,
  ): Principal => ({
    id: id as Principal['id'],
    capabilities: new Set(capabilities as readonly Capability[]),
    trusted,
  })

  it('guard denies every capability to an untrusted worker, whatever it claims', () => {
    const guard = new DefaultGuard()
    for (const claimed of [CAPABILITIES, ALL_CLAIMS]) {
      const impostor = asPrincipal('agent:impostor', claimed, false)
      for (const capability of CAPABILITIES) {
        const verdict = guard.evaluate(impostor, capability)
        expect(verdict.allowed).toBe(false)
      }
    }
  })

  it('guard denies grant governance even to a trusted non-owner principal', () => {
    // The confused-deputy worst case: a genuinely trusted principal (a
    // future module, built by Core) that is not the owner still cannot
    // mint grants, because the capability is held, not inferred from trust.
    const guard = new DefaultGuard()
    const trustedModule = asPrincipal('module:plugin', ['core.status.read'], true)
    expect(guard.evaluate(trustedModule, 'cognition.grant.manage').allowed).toBe(false)
    expect(guard.evaluate(trustedModule, 'core.status.read').allowed).toBe(true)
  })

  it('the capability vocabulary contains no self-mint path', () => {
    // There is no `grant.create`, `capability.mint`, `policy.write` or
    // anything a provider response could reach. This is the guard.test.ts
    // invariant restated from the red-team side: the vocabulary is closed
    // against escalation, not just against unknowns.
    const dangerous = CAPABILITIES.filter((c) =>
      /grant\.create|mint|policy\.write|privilege|escalat|capability\./i.test(c),
    )
    expect(dangerous).toEqual([])
    // `cognition.grant.manage` exists and is the owner's alone.
    expect(CAPABILITIES).toContain('cognition.grant.manage')
    // And a worker's own ceiling excludes it.
    expect(WORKER_CAPABILITIES).not.toContain('cognition.grant.manage')
    expect(WORKER_CAPABILITIES).not.toContain('security.stop')
    expect(WORKER_CAPABILITIES).not.toContain('security.resume')
    expect(WORKER_CAPABILITIES).not.toContain('work.approval.decide')
    // No work capability at all: an agent cannot approve its own request.
    for (const capability of WORKER_CAPABILITIES) {
      expect(capability.startsWith('work.')).toBe(false)
    }
  })

  it('a worker cannot widen its own budget by any request it can make', async () => {
    const f = fixture!
    await createAgentGrant(f, 'g-escalate')
    const before = f.owner.grants().find((g) => g.id === 'g-escalate')
    expect(before?.maxCalls).toBe(10)

    // A worker's only verb is request(). Ask for something enormous and
    // something tiny, in sequence, and check the ceilings never move.
    await f.worker.request(agentStep('escalate', 10_000))
    await f.worker.request(
      ({ kind: 'scheduled_task', prompt: 'escalate at night', maxOutputTokens: 1 }) as never,
    ).catch(() => undefined)
    const after = f.owner.grants().find((g) => g.id === 'g-escalate')
    expect(after?.maxCalls).toBe(10)
    expect(after?.maxOutputTokens).toBe(10_000)
    expect(after?.usage.calls).toBeLessThanOrEqual(10)
    expect(after?.usage.outputTokenBudgetReserved).toBeLessThanOrEqual(10_000)
  })
})

/** Every capability string a determined impostor could claim. */
const ALL_CLAIMS = [...CAPABILITIES, 'root', 'grant.create', 'capability.mint'] as const

describe('attack: a worker mints a second identity to approve its own work', () => {
  it('finds no approval capability on any surface it holds', () => {
    const f = fixture!
    // The worker authority is the only object a worker holds, and its two
    // members are the whole of what it can do. Approval is decided by an
    // owner command with `work.approval.decide`, which a worker cannot even
    // submit — commands are evaluated against the owner principal baked in
    // by the bridge, and the worker surface has no `handleCommand`.
    const worker = f.worker as unknown as Record<string, unknown>
    expect(worker.handleCommand).toBeUndefined()
    expect(worker.decideApproval).toBeUndefined()
    // And the vocabulary-level exclusion from the case above is the second,
    // independent line: even a hypothetical worker principal with every
    // worker capability still cannot decide an approval.
    expect(WORKER_CAPABILITIES).not.toContain('work.approval.decide')
  })
})
