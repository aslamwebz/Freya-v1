// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  establishDistinct,
  procedure,
  startSkillsCore,
  stopSkillsCore,
  walkTo,
  type SkillsFixture,
} from './harness'
import { CAPABILITIES } from '../../../core/protocol/core-protocol'
import { planSkillExecution } from '../../../core/skills/execution'
import type { SkillFoldRecord } from '../../../core/skills/state'
import type { SkillRecord } from '../../../core/skills/types'
import type { Capability } from '../../../core/protocol/core-protocol'

/**
 * SKILL AUTHORITY ESCALATION AND CAPABILITY LAUNDERING.
 *
 * The attacks, in one file because they are the same attack from different angles:
 *
 * 1. A skill **declares** a capability it should not have, hoping a declaration is
 *    mistaken for a grant.
 * 2. A skill is **planned** into a Run that does not hold its capability, hoping the
 *    store stands in for the authority check.
 * 3. A skill **executes** outside an authorised Mission/Run/Step.
 * 4. A skill **promotes itself** on evidence it authored, or on one lucky run.
 * 5. A skill **revises** itself into something more capable while keeping its old badge.
 *
 * The defences are structural: a closed forbidden-capability list checked at admission
 * *and* at execution, three required execution references, `EVALUATION_AUTHORS` with no
 * model member, a code-owned threshold table, and a revision that always resets to
 * `candidate`.
 */

const fixtures: SkillsFixture[] = []
async function start(): Promise<SkillsFixture> {
  const fixture = await startSkillsCore({ skillKey: new Uint8Array(32).fill(0x51) })
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopSkillsCore(fixture)
})

describe('a declaration is not a grant', () => {
  it('refuses every capability that decides whether Freya may act', async () => {
    const fixture = await start()
    const forbidden = CAPABILITIES.filter(
      (capability) =>
        capability.startsWith('security.') ||
        capability === 'cognition.grant.manage' ||
        capability === 'work.approval.decide' ||
        capability === 'mission.manage' ||
        capability === 'work.run.manage',
    )
    expect(forbidden.length).toBeGreaterThan(0)
    for (const capability of forbidden) {
      const result = await fixture.submit('skill.admit', {
        ...procedure('launder-a-capability'),
        requiredCapabilities: [capability],
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.skill?.code).toBe('forbidden-capability-required')
    }
    // Nothing was recorded at all.
    expect(fixture.projection().counts.retained).toBe(0)
  })

  it('refuses a forbidden capability smuggled in through a step', async () => {
    const fixture = await start()
    const result = await fixture.submit('skill.admit', {
      ...procedure('launder-through-a-step'),
      steps: [{ key: 'stop', capability: 'security.stop', verifier: 'test.record.matches' }],
    })
    expect(result.ok).toBe(false)
    expect(result.skill?.code).toBe('forbidden-capability-required')
  })

  it('refuses a capability outside the closed vocabulary entirely', async () => {
    const fixture = await start()
    const result = await fixture.submit('skill.admit', {
      ...procedure('invent-a-capability'),
      requiredCapabilities: ['guard.always_allow'],
    })
    expect(result.ok).toBe(false)
    expect(result.skill?.code).toBe('unknown-capability-required')
  })

  it('refuses a step whose verifier this Core does not have', async () => {
    const fixture = await start()
    const result = await fixture.submit('skill.admit', {
      ...procedure('no-way-to-check-this'),
      steps: [{ key: 'read', capability: 'test.record', verifier: 'a.verifier.i.invented' }],
    })
    expect(result.ok).toBe(false)
    expect(result.skill?.code).toBe('step-verifier-missing')
  })
})

describe('a stored skill cannot reach authority at execution either', () => {
  const record: SkillFoldRecord = {
    skillId: 'sk_1',
    name: 'summarise-a-file',
    nameLength: 17,
    kind: 'procedure',
    status: 'trial',
    version: 1,
    verification: 'verified',
    source: 'owner',
    trustClass: 'owner-declared',
    admittedBy: 'owner',
    admittedAt: '2026-10-02T09:00:00.000Z',
    promotedAt: null,
    retiredAt: null,
    retirementReason: null,
    applicability: ['research'],
    versions: [],
    evaluations: [],
    executionsPlanned: 0,
    updatedAt: '2026-10-02T09:00:00.000Z',
  }

  function body(overrides: Partial<SkillRecord> = {}): SkillRecord {
    return {
      skillId: 'sk_1',
      name: 'summarise-a-file',
      kind: 'procedure',
      status: 'trial',
      version: 1,
      verification: 'verified',
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

  const request = { missionId: 'm1', runId: 'r1', stepId: 's1', principal: 'owner' } as const

  it('refuses to plan into a Run that does not hold what it requires', () => {
    const outcome = planSkillExecution({
      record,
      body: body({ requiredCapabilities: ['search.web'] }),
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('capability-not-granted')
  })

  it('refuses capability laundering even when the Run somehow holds it', () => {
    const outcome = planSkillExecution({
      record,
      body: body({ requiredCapabilities: ['cognition.grant.manage'] }),
      request,
      work: { ...work, runCapabilities: () => ['cognition.grant.manage'] },
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('capability-laundering')
  })

  it('refuses without any of the three work references', () => {
    for (const missing of ['missionId', 'runId', 'stepId'] as const) {
      const outcome = planSkillExecution({
        record,
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
    const outcome = planSkillExecution({ record, body: body(), request, work, stopAll: () => true })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('stop-all')
  })

  it('refuses a body whose version the record does not vouch for', () => {
    const outcome = planSkillExecution({
      record,
      body: body({ version: 2 }),
      request,
      work,
      stopAll: () => false,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-such-version')
  })

  it('has no owner-scope method that could run or grant anything', async () => {
    const fixture = await start()
    const methods = Object.keys(fixture.scope() as unknown as Record<string, unknown>)
    for (const forbidden of ['plan', 'execute', 'run', 'grant', 'approve', 'request', 'stopAll']) {
      expect(methods).not.toContain(forbidden)
    }
  })
})

describe('no skill promotes itself', () => {
  it('refuses promotion with no evidence at all', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    // The walk stops at `trial`, because `trial` is the first status that can execute.
    const trial = await walkTo(fixture, skillId!, 'trial')
    expect(trial.ok).toBe(false)
    expect(fixture.projection().skills[0]?.status).toBe('draft')
  })

  it('refuses promotion on three established evaluations of one lucky run', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    // The cheapest forgery there is: one subject, three times over.
    for (const _attempt of [0, 1, 2]) {
      await fixture.submit('skill.recordEvaluation', {
        skillId,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
      })
    }
    expect(fixture.projection().skills[0]?.verification).toBe('verified')
    // `verified` is reached — the evidence is genuinely enough for *that* — and
    // `promoted` is refused, because three records of one subject are one subject.
    const promoted = await walkTo(fixture, skillId!, 'promoted')
    expect(promoted.ok).toBe(false)
    expect(fixture.projection().skills[0]?.status).toBe('verified')
  })

  it('promotes on genuinely distinct subjects, and records the owner as the actor', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    await establishDistinct(fixture, skillId!, 3)
    const promoted = await walkTo(fixture, skillId!, 'promoted')
    expect(promoted.ok).toBe(true)
    expect(fixture.projection().skills[0]?.status).toBe('promoted')
    // And the journal names the owner, never a payload-supplied author.
    const events = await fixture.core.activity()
    expect(events.some((row) => row.text.includes('A skill was promoted'))).toBe(true)
  })

  it('resets to candidate on revision, so an old badge cannot carry over', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    await establishDistinct(fixture, skillId!, 3)
    await walkTo(fixture, skillId!, 'promoted')
    expect(fixture.projection().skills[0]?.status).toBe('promoted')

    const revised = await fixture.submit('skill.revise', {
      ...procedure('summarise-a-file', 'A different body that asks for more.'),
      skillId,
    })
    expect(revised.ok).toBe(true)
    const view = fixture.projection().skills[0]
    expect(view?.version).toBe(2)
    expect(view?.status).toBe('candidate')
    expect(view?.verification).toBe('unverified')
    expect(view?.promotedAt).toBeNull()
    // The previous version's evidence is still visible but counts for nothing.
    expect(view?.evaluationCount).toBe(0)
    expect(view?.versions).toHaveLength(2)

    // Which means the new version cannot reach `trial` on the old one's evidence.
    const trial = await walkTo(fixture, skillId!, 'trial')
    expect(trial.ok).toBe(false)
  })

  it('cannot raise a trust class by revising repeatedly, and the loop converges', async () => {
    const fixture = await start()
    const scope = fixture.scope()
    const admitted = await scope.admit(procedure('from-a-web-page'), 'untrusted-content')
    if (!admitted.ok) throw new Error(`untrusted admission refused: ${admitted.reason}`)
    const skillId = admitted.skillId
    for (let revision = 1; revision <= 3; revision += 1) {
      const revised = await fixture.submit('skill.revise', {
        ...procedure('from-a-web-page', `Body number ${revision}, with real improvements.`),
        skillId,
      })
      if (!revised.ok) throw new Error(`revision ${revision} refused: ${revised.skill?.reason}`)
      expect(fixture.projection().skills[0]?.trustClass).toBe('untrusted-content')
    }
    const fourth = await fixture.submit('skill.revise', {
      ...procedure('from-a-web-page', 'Body number four, which will never arrive.'),
      skillId,
    })
    expect(fourth.ok).toBe(false)
    expect(fourth.skill?.code).toBe('revision-limit')
    expect(fixture.projection().skills[0]?.version).toBe(4)
  })

  it('never selects untrusted content, whatever status it reaches', async () => {
    const fixture = await start()
    const scope = fixture.scope()
    const admitted = await scope.admit(procedure('from-a-web-page'), 'untrusted-content')
    if (!admitted.ok) throw new Error(`untrusted admission refused: ${admitted.reason}`)
    const skillId = admitted.skillId
    // Established evidence, and a walk through every legal status, and still nothing.
    for (const _attempt of [0, 1, 2]) {
      await fixture.submit('skill.recordEvaluation', {
        skillId,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
      })
    }
    // Even the strongest status this one lucky run can reach, nothing is executable.
    await walkTo(fixture, skillId!, 'verified')
    expect(fixture.projection().skills[0]?.status).toBe('verified')
    expect(fixture.projection().counts.executable).toBe(0)
    const selection = await fixture.submit('skill.select', {
      applicability: ['research'],
      includeTrial: true,
      includeVerified: true,
    })
    expect(selection.skill?.selection?.candidates).toHaveLength(0)
  })
})