// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  InertSkillArtifactSink,
  assertMutableTarget,
  normaliseArtifactRef,
  planRevision,
  promoteIntoRuntime,
  wouldRaiseTrustClass,
  type SkillArtifactCandidate,
} from '../../core/skills/improvement'
import { ClosedSkillExecutionPort, planSkillExecution } from '../../core/skills/execution'
import { initialSkillState, reduceSkillState, type SkillFoldRecord } from '../../core/skills/state'
import { SKILL_LIMITS, type SkillRecord } from '../../core/skills/types'
import type { Capability } from '../../core/protocol/core-protocol'

/**
 * CONTROLLED IMPROVEMENT AND THE EXECUTION SEAM.
 *
 * The two places where Phase 17 could become dangerous, tested as the phase claims:
 *
 * 1. **Improvement is bounded and ordinary.** Three targets, a closed protected-domain
 *    table, a new version every time, a converged loop bound, no trust escalation, and
 *    **no runtime self-rewrite anywhere**.
 * 2. **Execution is only ever inside authorised work.** Three required references, the
 *    Run's own capabilities rather than the skill's wishes, and a refusal in words for
 *    everything else.
 */

describe('the protected boundary is closed and unreachable by path', () => {
  it('refuses every protected domain by name', () => {
    for (const targetRef of [
      'constitution',
      'guard',
      'governor',
      'stop-all',
      'keyring',
      'core-runtime',
      'capability-definition',
    ]) {
      const verdict = assertMutableTarget({
        target: 'implementation-artifact',
        targetRef,
        summary: 'improve this',
      })
      expect(verdict.ok).toBe(false)
      if (verdict.ok) continue
      expect(verdict.code).toBe('boundary-violation')
    }
  })

  it('refuses a source path even when no protected word is present', () => {
    for (const targetRef of [
      'core/index.ts',
      'electron/preload.ts',
      'src/ui/App.tsx',
      'package.json',
      'tsconfig.core.json',
      'scripts/build-electron.mjs',
    ]) {
      const verdict = assertMutableTarget({ target: 'implementation-artifact', targetRef, summary: 'x' })
      expect(verdict.ok).toBe(false)
      if (verdict.ok) continue
      expect(verdict.code).toBe('boundary-violation')
    }
  })

  it('refuses a protected domain hidden inside an otherwise ordinary reference', () => {
    const verdict = assertMutableTarget({
      target: 'implementation-artifact',
      targetRef: 'my-guard-rule',
      summary: 'x',
    })
    expect(verdict.ok).toBe(false)
  })

  it('accepts the three ordinary targets with an ordinary reference', () => {
    for (const target of ['skill', 'procedure', 'implementation-artifact'] as const) {
      const verdict = assertMutableTarget({ target, targetRef: 'summarise-a-file', summary: 'x' })
      expect(verdict.ok).toBe(true)
      expect(verdict.target).toBe(target)
    }
  })

  it('refuses a target kind outside the closed list', () => {
    const verdict = assertMutableTarget({ target: 'constitution', targetRef: 'anything', summary: 'x' })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe('invalid-skill-kind')
  })

  it('refuses a missing or oversized reference', () => {
    expect(assertMutableTarget({ target: 'skill', targetRef: '', summary: 'x' }).ok).toBe(false)
    expect(assertMutableTarget({ target: 'skill', targetRef: 42, summary: 'x' }).ok).toBe(false)
    expect(
      assertMutableTarget({
        target: 'skill',
        targetRef: 'x'.repeat(SKILL_LIMITS.maxRefChars + 1),
        summary: 'x',
      }).ok,
    ).toBe(false)
  })

  it('normalises an artifact reference to a slug and refuses a path', () => {
    expect(normaliseArtifactRef('My Helper')).toBe('my-helper')
    expect(normaliseArtifactRef('../../etc/passwd')).toBeNull()
    expect(normaliseArtifactRef('has spaces and / slashes')).toBeNull()
  })
})

describe('trust is inherited and never raised', () => {
  it('orders the classes so an escalation is detectable', () => {
    expect(wouldRaiseTrustClass('untrusted-content', 'derived')).toBe(true)
    expect(wouldRaiseTrustClass('derived', 'code-owned')).toBe(true)
    expect(wouldRaiseTrustClass('code-owned', 'owner-declared')).toBe(false)
    expect(wouldRaiseTrustClass('untrusted-content', 'untrusted-content')).toBe(false)
  })
})

describe('a revision is always a new version at candidate', () => {
  const base = {
    currentVersion: 2,
    revisionsSoFar: 0,
    currentContentHash: 'a'.repeat(32),
    proposedContentHash: 'b'.repeat(32),
    summary: 'a genuinely different body',
  }

  it('plans version + 1 at candidate', () => {
    const plan = planRevision(base)
    expect(plan.refusal).toBeNull()
    expect(plan.nextVersion).toBe(3)
    expect(plan.nextStatus).toBe('candidate')
    expect(plan.baseVersion).toBe(2)
  })

  it('refuses an identical body, so a revision cannot dilute the history', () => {
    const plan = planRevision({ ...base, proposedContentHash: base.currentContentHash })
    expect(plan.refusal).toBe('identical-revision')
  })

  it('stops the loop at the convergence bound', () => {
    for (const revisionsSoFar of [0, 1, 2]) {
      expect(planRevision({ ...base, revisionsSoFar }).refusal).toBeNull()
    }
    const plan = planRevision({ ...base, revisionsSoFar: SKILL_LIMITS.maxRevisionsPerSkill })
    expect(plan.refusal).toBe('revision-limit')
    expect(plan.reason).toMatch(/must converge/i)
  })

  it('bounds and sanitises the summary rather than storing it raw', () => {
    const plan = planRevision({ ...base, summary: `  a${'\u0000'}b  ` })
    expect(plan.summary).toBe('ab')
    expect(plan.summaryLength).toBe(2)
    const oversized = planRevision({
      ...base,
      summary: 'x'.repeat(SKILL_LIMITS.maxSummaryChars * 8),
    })
    expect(oversized.refusal).toBe('contract-oversize')
  })
})

describe('nothing can promote an artifact into Freya’s running code', () => {
  const candidate: SkillArtifactCandidate = {
    artifactId: 'artifact-1',
    target: 'implementation-artifact',
    targetRef: 'summarise-a-file',
    skillId: 'sk_1',
    baseVersion: 1,
    summaryLength: 40,
    proposedBy: 'owner',
  }

  it('refuses through the shipped sink, and writes nothing', async () => {
    const decision = await promoteIntoRuntime(new InertSkillArtifactSink(), candidate)
    expect(decision.accepted).toBe(false)
    expect(decision.reason).toBe('runtime-promotion-unavailable')
    expect(decision.detail).toMatch(/explicit verified workflow/i)
  })

  it('refuses even if a future sink claims success without a reason', async () => {
    // An unaccountable acceptance is indistinguishable from a bug in the sink, so the
    // safe reading of an unaccountable claim is "no".
    const overenthusiastic = {
      recordCandidate: async () => ({ accepted: true, reason: null, detail: 'sure, why not' }),
    }
    const decision = await promoteIntoRuntime(overenthusiastic, candidate)
    expect(decision.accepted).toBe(false)
    expect(decision.reason).toBe('runtime-promotion-unavailable')
    expect(decision.detail).toMatch(/unaccountable/i)
  })

  it('has no member on the sink that could perform a write', () => {
    // Read off the shipped implementation, so adding an `apply`/`write` member later
    // fails here rather than in review.
    const methods = Object.getOwnPropertyNames(InertSkillArtifactSink.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(methods).toEqual(['recordCandidate'])
    for (const forbidden of ['apply', 'write', 'install', 'commit', 'promoteToRuntime', 'rewrite']) {
      expect(methods).not.toContain(forbidden)
    }
  })
})

describe('execution requires an authorised Mission, Run and Step', () => {
  function record(overrides: Partial<SkillFoldRecord> = {}): SkillFoldRecord {
    const state = reduceSkillState(
      initialSkillState(),
      event('skill.admitted', {
        skillId: 'sk_1',
        name: 'summarise-a-file',
        nameLength: 17,
        kind: 'procedure',
        version: 1,
        contentHash: 'a'.repeat(32),
        source: 'owner',
        trustClass: 'owner-declared',
        admittedBy: 'owner',
        originRef: 'renderer',
        stepCount: 1,
        requiredCapabilityCount: 1,
        applicabilityCount: 1,
        applicability: ['research'],
        inputCount: 1,
        outputCount: 1,
        preconditionCount: 0,
        postconditionCount: 1,
        summaryLength: 40,
      }),
    )
    let folded = state
    folded = transition(folded, 'sk_1', 'candidate', 'draft')
    folded = transition(folded, 'sk_1', 'draft', 'trial')
    const found = folded.records.find((entry) => entry.skillId === 'sk_1')
    if (found === undefined) throw new Error('no record')
    return { ...found, ...overrides }
  }

  function body(overrides: Partial<SkillRecord> = {}): SkillRecord {
    return {
      skillId: 'sk_1',
      name: 'summarise-a-file',
      kind: 'procedure',
      status: 'trial',
      version: 1,
      verification: 'unverified',
      contentHash: 'a'.repeat(32),
      summary: 'Reads a file and produces a bounded summary of it.',
      contract: {
        inputs: [{ name: 'path', description: 'The file to read.' }],
        outputs: [{ name: 'summary', description: 'A bounded summary.' }],
        preconditions: [],
        postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
      },
      steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
      requiredCapabilities: ['work.execute'],
      applicability: ['research'],
      provenance: {
        source: 'owner',
        trustClass: 'owner-declared',
        admittedBy: 'owner',
        admittedAt: '2026-10-02T09:00:00.000Z',
        parentSkillId: null,
        parentVersion: null,
        originRef: 'renderer',
      },
      createdAt: '2026-10-02T09:00:00.000Z',
      updatedAt: '2026-10-02T09:00:00.000Z',
      retiredAt: null,
      retirementReason: null,
      promotedAt: null,
      ...overrides,
    }
  }

  const work = {
    missionExists: () => true,
    runExists: () => true,
    runState: () => 'running' as const,
    stepExists: () => true,
    runCapabilities: () => ['work.execute'] as readonly Capability[],
  }

  const request = { missionId: 'm1', runId: 'r1', stepId: 's1', principal: 'owner' as const }

  it('plans a trial skill inside an existing Run and Step', () => {
    const outcome = planSkillExecution({ record: record(), body: body(), request, work, stopAll: () => false })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.steps).toHaveLength(1)
    expect(outcome.plan.steps[0]?.verifier).toBe('test.record.matches')
    // A plan, not an execution: nothing here ran anything.
    expect(Object.keys(outcome.plan).sort()).toEqual([
      'requiredCapabilities',
      'runId',
      'skillId',
      'stepId',
      'steps',
      'version',
    ])
  })

  it('refuses without any of the three references', () => {
    for (const missing of ['missionId', 'runId', 'stepId'] as const) {
      const outcome = planSkillExecution({
        record: record(),
        body: body(),
        request: { ...request, [missing]: '' },
        work,
        stopAll: () => false,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('not-in-work')
    }
  })

  it('refuses while STOP ALL is latched', () => {
    const outcome = planSkillExecution({
      record: record(),
      body: body(),
      request,
      work,
      stopAll: () => true,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('stop-all')
  })

  it('refuses a candidate — admission proves a contract exists and nothing else', () => {
    const outcome = planSkillExecution({
      record: record({ status: 'candidate' }),
      body: body({ status: 'candidate' }),
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('not-executable')
  })

  it('refuses a retired or blocked skill', () => {
    for (const status of ['retired', 'blocked'] as const) {
      const outcome = planSkillExecution({
        record: record({ status }),
        body: body({ status }),
        request,
        work,
        stopAll: () => false,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('not-executable')
    }
  })

  it('refuses untrusted content at any status', () => {
    const outcome = planSkillExecution({
      record: record({ trustClass: 'untrusted-content' }),
      body: {
        ...body(),
        provenance: { ...body().provenance, trustClass: 'untrusted-content' },
      },
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('untrusted-content')
  })

  it('refuses when the Run does not hold a declared capability', () => {
    const outcome = planSkillExecution({
      record: record(),
      body: body({ requiredCapabilities: ['search.web'] }),
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // The refusal names the capability a *stored skill cannot obtain*, only use.
    expect(outcome.code).toBe('capability-not-granted')
    expect(outcome.reason).toMatch(/cannot obtain a capability/i)
  })

  it('refuses capability laundering even when the Run somehow holds it', () => {
    const outcome = planSkillExecution({
      record: record(),
      body: body({ requiredCapabilities: ['work.approval.decide'] }),
      request,
      work: { ...work, runCapabilities: () => ['work.approval.decide'] },
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('capability-laundering')
  })

  it('refuses a terminal Run and a missing Run', () => {
    for (const [runState, code] of [
      ['terminal', 'work-run-unusable'],
      ['missing', 'work-run-unusable'],
    ] as const) {
      const outcome = planSkillExecution({
        record: record(),
        body: body(),
        request,
        work: { ...work, runState: () => runState },
        stopAll: () => false,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe(code)
    }
  })

  it('refuses a missing Mission or Step', () => {
    const noMission = planSkillExecution({
      record: record(),
      body: body(),
      request,
      work: { ...work, missionExists: () => false },
      stopAll: () => false,
    })
    expect(noMission.ok).toBe(false)
    const noStep = planSkillExecution({
      record: record(),
      body: body(),
      request,
      work: { ...work, stepExists: () => false },
      stopAll: () => false,
    })
    expect(noStep.ok).toBe(false)
    if (!noStep.ok) expect(noStep.code).toBe('work-step-missing')
  })

  it('refuses when the stored body and the record disagree about the version', () => {
    const outcome = planSkillExecution({
      record: record(),
      body: body({ version: 2 }),
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-such-version')
  })

  it('says nothing at all when there is no Work to plan into', () => {
    const outcome = planSkillExecution({
      record: record(),
      body: body(),
      request,
      work: new ClosedSkillExecutionPort(),
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // "No Work to plan into" is the honest answer, and it is the answer a Core that has
    // not started gives.
    expect(outcome.code).toBe('work-run-unusable')
  })

  it('plans nothing for a skill with no steps', () => {
    const outcome = planSkillExecution({
      record: record(),
      body: body({ steps: [] }),
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('not-executable')
  })
})

/* --------------------------------------------------------------- helpers */

let sequence = 0

function event(type: string, payload: unknown): never {
  sequence += 1
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: '2026-10-02T09:00:00.000Z',
    source: 'system',
    actor: 'system',
    correlationId: 'c',
    causationId: null,
    payload,
  } as never
}

function transition(state: ReturnType<typeof initialSkillState>, skillId: string, from: string, to: string) {
  return reduceSkillState(
    state,
    event('skill.transitioned', {
      skillId,
      from,
      to,
      reason: 'evaluation-basis',
      evidence: { version: 1, established: 0, contradicted: 0, distinctSubjects: 0 },
    }),
  )
}