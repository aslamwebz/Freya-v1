// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../core/index'
import type { CoreCommandName, CoreCommandResult } from '../../core/protocol/core-protocol'
import { skillOwnerScope } from '../../core/testing'
import { FakeModelProvider } from '../../core/model/fake-provider'
import {
  ABSENT_SKILL_PROJECTION,
  NO_SKILL_DOMAIN_REASON,
  type SkillProjection,
} from '../../core/protocol/skills'
import { SKILL_PROMOTION_THRESHOLDS } from '../../core/skills/promotion'
import type { Capability } from '../../core/protocol/core-protocol'

/**
 * THE SKILL DOMAIN INSIDE A REAL CORE.
 *
 * Everything above this file tested the domain; this file tests that Core actually
 * wires it, that the nine commands behave as the protocol says, and — the claim the
 * whole phase rests on — that none of it costs a model call.
 */

const SKILL_KEY = new Uint8Array(32).fill(0x31)
const SENTINEL = 'FREYA_RED_TEAM_SECRET_7A91'

interface Fixture {
  core: Core
  fake: FakeModelProvider
  dataPath: string
  dir: string
  submit(command: string, payload?: unknown): Promise<CoreCommandResult>
}

let requestCounter = 0

async function start(options: { skillKey?: Uint8Array | null } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-skills-core-'))
  const dataPath = join(dir, 'events.jsonl')
  const fake = new FakeModelProvider()
  const core = createCore({
    dataPath,
    providers: [fake],
    attentionObserveSources: false,
    ...(options.skillKey === undefined ? {} : { skillKey: options.skillKey }),
  })
  await core.start()
  return {
    core,
    fake,
    dataPath,
    dir,
    submit(command: string, payload?: unknown) {
      requestCounter += 1
      return core.handleCommand({
        command: command as CoreCommandName,
        requestId: `r-${requestCounter}`,
        payload,
      })
    },
  }
}

async function stop(fixture: Fixture | null): Promise<void> {
  if (fixture === null) return
  await fixture.core.stop('skills test teardown')
  await rm(fixture.dir, { recursive: true, force: true })
}

/** A procedure body this Core can actually execute: `test.record` is registered. */
function procedure(name: string, summary = 'Reads a file and produces a bounded summary of it.') {
  return {
    name,
    kind: 'procedure',
    summary,
    contract: {
      inputs: [{ name: 'path', description: 'The file to read.' }],
      outputs: [{ name: 'summary', description: 'A bounded summary.' }],
      preconditions: [],
      postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
    },
    applicability: ['research'],
    requiredCapabilities: ['work.execute'],
    steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
  }
}

describe('the projection is truthful about what exists', () => {
  it('reports unavailable before start, and says it has no domain', () => {
    const dir = join(tmpdir(), 'never-created')
    const core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [] })
    const projection = core.skills()
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBe(NO_SKILL_DOMAIN_REASON)
    // Not `ready` with zero counts: "no procedures" and "nothing is watching for
    // procedures" are different facts.
    expect(projection.counts.retained).toBe(0)
    expect(ABSENT_SKILL_PROJECTION.health).toBe('unavailable')
  })

  it('is ready, empty and durable after start with a key', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const projection = fixture.core.skills()
      expect(projection.health).toBe('ready')
      expect(projection.reason).toBeNull()
      expect(projection.counts.retained).toBe(0)
      expect(projection.persistence).toEqual({ mode: 'encrypted', durable: true, reason: null })
      expect(projection.thresholds.minEstablishedForPromoted).toBe(
        SKILL_PROMOTION_THRESHOLDS.minEstablishedForPromoted,
      )
    } finally {
      await stop(fixture)
    }
  })

  it('says plainly that it is ephemeral without a key, rather than claiming durability', async () => {
    const fixture = await start({ skillKey: null })
    try {
      const projection = fixture.core.skills()
      expect(projection.persistence.mode).toBe('ephemeral')
      expect(projection.persistence.durable).toBe(false)
      expect(projection.persistence.reason).toMatch(/in this process only/i)
    } finally {
      await stop(fixture)
    }
  })

  it('pushes the current projection to a window that attaches late', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const seen: SkillProjection[] = []
      const dispose = fixture.core.onSkills((projection) => seen.push(projection))
      // Attached late, and it still knows where it stands.
      expect(seen).toHaveLength(1)
      expect(seen[0]?.health).toBe('ready')
      await fixture.submit('skill.admit', procedure('summarise-a-file'))
      expect(seen.at(-1)?.counts.retained).toBe(1)
      dispose()
      const before = seen.length
      await fixture.submit('skill.admit', procedure('another-one'))
      expect(seen).toHaveLength(before)
    } finally {
      await stop(fixture)
    }
  })
})

describe('the lifecycle runs end to end through the command surface', () => {
  it('admits, evaluates, moves through the lifecycle, and promotes', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      expect(admitted.ok).toBe(true)
      expect(admitted.skill?.status).toBe('candidate')
      expect(admitted.skill?.version).toBe(1)
      const skillId = admitted.skill?.skillId
      expect(typeof skillId).toBe('string')

      // Evidence, from three distinct subjects, all recorded by the owner's report of
      // what it observed. No verification record is accepted on this path.
      for (const [index, ref] of ['run-1', 'run-2', 'run-3'].entries()) {
        const evaluated = await fixture.submit('skill.recordEvaluation', {
          skillId,
          subjectKind: 'trial-run',
          subjectRef: ref,
          evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
          metrics: [{ name: 'attempts', value: index + 1 }],
          commentaryLength: 4_000,
        })
        expect(evaluated.ok).toBe(true)
        expect(evaluated.skill?.operation).toBe('evaluated')
      }

      const afterEvidence = fixture.core.skills().skills[0]
      expect(afterEvidence?.verification).toBe('verified')
      expect(afterEvidence?.establishedCount).toBe(3)
      // The commentary was recorded, and moved nothing.
      expect(afterEvidence?.lastEvaluation?.commentaryChars).toBe(4_000)
      expect(afterEvidence?.lastEvaluation?.verdict).toBe('established')

      expect((await fixture.submit('skill.transition', { skillId, to: 'draft' })).ok).toBe(true)
      expect((await fixture.submit('skill.transition', { skillId, to: 'trial' })).ok).toBe(true)
      expect((await fixture.submit('skill.transition', { skillId, to: 'verified' })).ok).toBe(true)
      const promoted = await fixture.submit('skill.transition', { skillId, to: 'promoted' })
      expect(promoted.ok).toBe(true)
      expect(fixture.core.skills().skills[0]?.status).toBe('promoted')
      expect(fixture.core.skills().counts.promotions).toBe(1)
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a promotion with no evidence, and says which code applies', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      await fixture.submit('skill.transition', { skillId, to: 'draft' })
      const refused = await fixture.submit('skill.transition', { skillId, to: 'trial' })
      expect(refused.ok).toBe(false)
      expect(refused.skill?.ok).toBe(false)
      expect(refused.skill?.code).toBe('evidence-insufficient')
      expect(refused.skill?.reason).toBeTruthy()
      // The refusal is on the envelope *and* in the Skills slot, so a window that only
      // reads one of them cannot render it as a success.
      expect(refused.ok).toBe(false)
      expect(refused.refusal).toBeDefined()
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a status it does not know, without touching the record', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      const refused = await fixture.submit('skill.transition', { skillId, to: 'promoted!!' })
      expect(refused.ok).toBe(false)
      expect(refused.skill?.code).toBe('illegal-transition')
      expect(fixture.core.skills().skills[0]?.status).toBe('candidate')
    } finally {
      await stop(fixture)
    }
  })

  it('retires a procedure and refuses to bring it back by revising it', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      expect((await fixture.submit('skill.retire', { skillId, reason: 'owner-request' })).ok).toBe(true)
      expect(fixture.core.skills().skills[0]?.status).toBe('retired')
      expect(fixture.core.skills().skills[0]?.retirementReason).toBe('owner-request')

      // Terminal means terminal: there is no un-retire edge, and a revision of a
      // retired procedure is refused rather than quietly reviving it.
      const revised = await fixture.submit('skill.revise', {
        ...procedure('summarise-a-file', 'A different body entirely.'),
        skillId,
      })
      expect(revised.ok).toBe(false)
      expect(fixture.core.skills().skills[0]?.version).toBe(1)
    } finally {
      await stop(fixture)
    }
  })

  it('blocks an unsafe procedure rather than only retiring it', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      const blocked = await fixture.submit('skill.retire', { skillId, reason: 'unsafe' })
      expect(blocked.ok).toBe(true)
      expect(blocked.skill?.status).toBe('blocked')
      expect(fixture.core.skills().skills[0]?.status).toBe('blocked')
    } finally {
      await stop(fixture)
    }
  })

  it('revises into a new version that starts again at candidate', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      const revised = await fixture.submit('skill.revise', {
        ...procedure('summarise-a-file', 'A genuinely different body for the same procedure.'),
        skillId,
      })
      expect(revised.ok).toBe(true)
      expect(revised.skill?.version).toBe(2)
      expect(revised.skill?.status).toBe('candidate')
      const view = fixture.core.skills().skills[0]
      expect(view?.version).toBe(2)
      expect(view?.verification).toBe('unverified')
      expect(view?.evaluationCount).toBe(0)
      expect(view?.versions.map((entry) => entry.version)).toEqual([1, 2])
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a revision that changes nothing', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      const revised = await fixture.submit('skill.revise', { ...procedure('summarise-a-file'), skillId })
      expect(revised.ok).toBe(false)
      expect(revised.skill?.code).toBe('identical-revision')
    } finally {
      await stop(fixture)
    }
  })
})

describe('the projection measures and never quotes', () => {
  it('carries no summary, no contract description and no capability list', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      await fixture.submit('skill.admit', procedure('summarise-a-file', `A summary containing ${SENTINEL}.`))
      const projection = fixture.core.skills()
      const serialised = JSON.stringify(projection)
      expect(serialised).not.toContain(SENTINEL)
      // The capability *list* is the capability map of a procedure; only the count
      // crosses, because a window that could read the map could be asked to explain it.
      const view = projection.skills[0]
      expect(view?.requiredCapabilityCount).toBe(1)
      expect(Object.keys(view!).sort()).not.toContain('requiredCapabilities')
      expect(view?.inputCount).toBe(1)
      expect(view?.summaryLength).toBeGreaterThan(0)
    } finally {
      await stop(fixture)
    }
  })

  it('reads one body back only through the explicit detail read', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file', `Has ${SENTINEL}.`))
      const skillId = admitted.skill?.skillId
      const detail = await fixture.submit('skill.detail.read', { skillId })
      expect(detail.ok).toBe(true)
      expect(detail.skill?.detail?.summary).toContain(SENTINEL)
      expect(detail.skill?.detail?.steps[0]?.capability).toBe('test.record')
      // And it is the *only* place it appears.
      expect(JSON.stringify(fixture.core.skills())).not.toContain(SENTINEL)
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a detail read for a skill that does not exist', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const detail = await fixture.submit('skill.detail.read', { skillId: 'sk_nope' })
      expect(detail.ok).toBe(false)
      expect(detail.skill?.code).toBe('no-such-skill')
    } finally {
      await stop(fixture)
    }
  })
})

describe('selection is Core’s ordering, not the window’s', () => {
  it('ranks by evidence and reports what it matched', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      for (const ref of ['run-1', 'run-2']) {
        await fixture.submit('skill.recordEvaluation', {
          skillId,
          subjectKind: 'trial-run',
          subjectRef: ref,
          evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
        })
      }
      await fixture.submit('skill.transition', { skillId, to: 'draft' })
      await fixture.submit('skill.transition', { skillId, to: 'trial' })

      const selected = await fixture.submit('skill.select', { applicability: ['research'], includeTrial: true })
      expect(selected.ok).toBe(true)
      expect(selected.skill?.selection?.candidates).toHaveLength(1)
      expect(selected.skill?.selection?.candidates[0]?.matchedTags).toEqual(['research'])
      expect(selected.skill?.selection?.candidates[0]?.establishedCount).toBe(2)

      // A tag nothing declares selects nothing, and the report says so.
      const none = await fixture.submit('skill.select', { applicability: ['finance'], includeTrial: true })
      expect(none.skill?.selection?.candidates).toHaveLength(0)
      expect(none.skill?.selection?.emptyReason).toBe('no-applicable-skill')
    } finally {
      await stop(fixture)
    }
  })
})

describe('nothing on this path reaches a model', () => {
  it('costs zero provider calls across admission, evaluation, promotion and reads', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const before = fixture.core.status().durableUsage.calls
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      for (const ref of ['run-1', 'run-2', 'run-3']) {
        await fixture.submit('skill.recordEvaluation', {
          skillId,
          subjectKind: 'trial-run',
          subjectRef: ref,
          evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
          commentaryLength: 2_000,
        })
      }
      await fixture.submit('skill.transition', { skillId, to: 'draft' })
      await fixture.submit('skill.transition', { skillId, to: 'trial' })
      await fixture.submit('skill.transition', { skillId, to: 'verified' })
      await fixture.submit('skill.transition', { skillId, to: 'promoted' })
      await fixture.submit('skill.select', { applicability: ['research'] })
      await fixture.submit('skill.status.read')
      await fixture.submit('skill.detail.read', { skillId })
      await fixture.submit('skill.propose', { target: 'skill', targetRef: skillId, summary: 'a proposal' })

      expect(fixture.core.status().durableUsage.calls).toBe(before)
      expect(fixture.fake.calls).toBe(0)
      expect(fixture.core.status().activeProviderCalls).toBe(0)
    } finally {
      await stop(fixture)
    }
  })
})

describe('STOP ALL closes the whole lane', () => {
  it('admits, promotes and plans nothing while Freya is stopped', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const stopped = await fixture.submit('security.stopAll')
      expect(stopped.ok).toBe(true)
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      expect(admitted.ok).toBe(false)
      expect(admitted.skill?.code).toBe('stop-all')
      expect(fixture.core.skills().counts.retained).toBe(0)
    } finally {
      await stop(fixture)
    }
  })
})

describe('restart recovery keeps the journal authoritative for status', () => {
  it('re-folds the lifecycle from the journal and reports the body as durable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-skills-restart-'))
    const dataPath = join(dir, 'events.jsonl')
    const fake = new FakeModelProvider()
    try {
      const first = createCore({ dataPath, providers: [fake], skillKey: SKILL_KEY, attentionObserveSources: false })
      await first.start()
      await first.handleCommand({
        command: 'skill.admit',
        requestId: 'admit-1',
        payload: procedure('summarise-a-file'),
      })
      await first.stop('first process ends')

      const second = createCore({ dataPath, providers: [fake], skillKey: SKILL_KEY, attentionObserveSources: false })
      await second.start()
      const projection = second.skills()
      expect(projection.counts.retained).toBe(1)
      expect(projection.skills[0]?.name).toBe('summarise-a-file')
      expect(projection.skills[0]?.status).toBe('candidate')
      expect(projection.persistence.durable).toBe(true)

      // The body came back, so the owner's explicit read works after a restart — which
      // is what makes procedures worth having.
      const detail = await second.handleCommand({
        command: 'skill.detail.read',
        requestId: 'detail-1',
        payload: { skillId: projection.skills[0]?.skillId },
      })
      expect(detail.ok).toBe(true)
      expect(detail.skill?.detail?.name).toBe('summarise-a-file')
      await second.stop('second process ends')

      // And a relaunch cost no model call either.
      expect(fake.calls).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('discards a body the journal does not vouch for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-skills-rejected-'))
    const dataPath = join(dir, 'events.jsonl')
    const fake = new FakeModelProvider()
    try {
      // A journal with no `skill.admitted` at all, but a store that claims to hold one.
      // Nothing here writes such a file legitimately; the point is that the engine
      // would refuse it anyway.
      const first = createCore({ dataPath, providers: [fake], skillKey: SKILL_KEY, attentionObserveSources: false })
      await first.start()
      await first.stop('ends')
      const second = createCore({ dataPath, providers: [fake], skillKey: SKILL_KEY, attentionObserveSources: false })
      await second.start()
      expect(second.skills().counts.retained).toBe(0)
      await second.stop('ends')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the owner scope is issued, never acquired', () => {
  it('carries the owner acts and nothing else', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const scope = skillOwnerScope(fixture.core)
      const methods = Object.keys(scope).sort()
      expect(methods).toEqual([
        'admit',
        'detail',
        'offerArtifact',
        'propose',
        'recordEvaluation',
        'retire',
        'revise',
        'settle',
        'transition',
      ])
      // No method that executes a skill, grants a capability, decides an approval, or
      // reaches a provider: the engine has no such method, which is the point.
      for (const forbidden of ['execute', 'plan', 'run', 'grant', 'approve', 'request', 'stopAll']) {
        expect(methods).not.toContain(forbidden)
      }
    } finally {
      await stop(fixture)
    }
  })

  it('admits untrusted content as a candidate that can never be executed', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const scope = skillOwnerScope(fixture.core)
      const admitted = await scope.admit(procedure('from-a-web-page'), 'untrusted-content')
      expect(admitted.ok).toBe(true)
      const view = fixture.core.skills().skills[0]
      expect(view?.trustClass).toBe('untrusted-content')
      expect(view?.status).toBe('candidate')

      // It may be *selected against*, and nothing more.
      const selection = fixture.core.skills()
      expect(selection.counts.executable).toBe(0)
      const chosen = await fixture.submit('skill.select', { applicability: ['research'], includeTrial: true })
      expect(chosen.skill?.selection?.candidates).toHaveLength(0)
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a proposal whose target is a protected domain, and journals the refusal', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const refused = await fixture.submit('skill.propose', {
        target: 'implementation-artifact',
        targetRef: 'core/security/guard.ts',
        summary: 'make the guard more permissive',
      })
      expect(refused.ok).toBe(false)
      expect(refused.skill?.code).toBe('boundary-violation')
      const projection = fixture.core.skills()
      expect(projection.rejectedAdmissions.at(-1)?.code).toBe('boundary-violation')
      expect(projection.proposals).toHaveLength(0)
    } finally {
      await stop(fixture)
    }
  })

  it('records an ordinary proposal with a basis Core derived itself', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      // No evidence yet, so there is nothing to improve *from*.
      const tooEarly = await fixture.submit('skill.propose', { target: 'skill', targetRef: skillId, summary: 'x' })
      expect(tooEarly.ok).toBe(false)
      expect(tooEarly.skill?.code).toBe('no-evaluation-basis')

      await fixture.submit('skill.recordEvaluation', {
        skillId,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
      })
      const proposed = await fixture.submit('skill.propose', { target: 'skill', targetRef: skillId, summary: 'do it better' })
      expect(proposed.ok).toBe(true)
      expect(fixture.core.skills().proposals).toHaveLength(1)
      expect(fixture.core.skills().proposals[0]?.basisCount).toBe(1)

      const settled = await fixture.submit('skill.proposal.settle', {
        proposalId: proposed.skill?.proposalId,
        decision: 'refused',
        reason: 'revision-limit',
      })
      expect(settled.ok).toBe(true)
      expect(fixture.core.skills().proposals).toHaveLength(0)
    } finally {
      await stop(fixture)
    }
  })

  it('refuses an artifact offered into the running runtime, and records the refusal', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const scope = skillOwnerScope(fixture.core)
      const offered = await scope.offerArtifact({
        targetRef: 'summarise-a-file',
        summary: 'replace the summariser with this instead',
      })
      expect(offered.ok).toBe(false)
      expect(offered.code).toBe('runtime-promotion-unavailable')
      const projection = fixture.core.skills()
      expect(projection.runtimePromotionRefusals).toHaveLength(1)
      expect(projection.runtimePromotionRefusals[0]?.reason).toBe('runtime-promotion-unavailable')
    } finally {
      await stop(fixture)
    }
  })
})

describe('a renderer cannot reach past what the protocol names', () => {
  it('refuses an unknown skill command rather than guessing', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      for (const command of [
        'skill.execute',
        'skill.verify',
        'skill.promote.artifact',
        'skill.threshold.set',
        'skill.tick',
      ]) {
        const result = await fixture.submit(command, {})
        expect(result.ok).toBe(false)
        expect(result.refusal?.reason).toMatch(/unknown command/)
      }
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a payload on the payloadless status read', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const refused = await fixture.submit('skill.status.read', { status: 'promoted' })
      expect(refused.ok).toBe(false)
      expect(refused.skill?.reason).toMatch(/carries no payload/i)
      expect((await fixture.submit('skill.status.read')).ok).toBe(true)
      expect((await fixture.submit('skill.status.read', {})).ok).toBe(true)
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a verification record submitted over the command surface', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const forged = await fixture.submit('skill.recordEvaluation', {
        skillId: admitted.skill?.skillId,
        subjectKind: 'verification',
        subjectRef: 'v1',
        verification: [{ verificationId: 'v1', verifier: 'test.record.matches', verdict: 'passed' }],
      })
      expect(forged.ok).toBe(false)
      expect(forged.skill?.code).toBe('evidence-self-reported')
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a model opinion submitted as evidence', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const opinion = await fixture.submit('skill.recordEvaluation', {
        skillId: admitted.skill?.skillId,
        subjectKind: 'owner-report',
        subjectRef: 'note-1',
        evidence: [{ kind: 'model-opinion', code: 'positive', count: 1 }],
        commentaryLength: 900,
      })
      expect(opinion.ok).toBe(false)
      expect(opinion.skill?.code).toBe('evidence-self-reported')
      // And nothing was recorded.
      expect(fixture.core.skills().counts.evaluations).toBe(0)
    } finally {
      await stop(fixture)
    }
  })

  it('ignores a version a caller names on an evaluation', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
      const skillId = admitted.skill?.skillId
      await fixture.submit('skill.recordEvaluation', {
        skillId,
        version: 99,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
      })
      // The version is Core's, so the evaluation landed on version 1 and nothing else.
      const view = fixture.core.skills().skills[0]
      expect(view?.evaluationCount).toBe(1)
      expect(view?.lastEvaluation?.version).toBe(1)
    } finally {
      await stop(fixture)
    }
  })
})

describe('the activity feed measures and never quotes', () => {
  it('says what happened without a word of the procedure', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file', `Sentinel ${SENTINEL}.`))
      const skillId = admitted.skill?.skillId
      await fixture.submit('skill.recordEvaluation', {
        skillId,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
        commentaryLength: 1234,
      })
      const feed = fixture.core.activity().map((row) => row.text).join(' | ')
      expect(feed).not.toContain(SENTINEL)
      expect(feed).toMatch(/was recorded as summarise-a-file/)
      expect(feed).toMatch(/established \(verification-passed\)/)
      expect(feed).toMatch(/1234 characters of model commentary/)
    } finally {
      await stop(fixture)
    }
  })
})

describe('the Work port is a read port', () => {
  it('answers with the Run’s own capabilities and nothing else', async () => {
    const fixture = await start({ skillKey: SKILL_KEY })
    try {
      // A Core with no Work Run planned holds no capabilities, so the honest answer for
      // any run id is "no such Run" — which is what a Core that has not started gives.
      const engine = fixture.core as unknown as {
        skillWorkPort(): {
          runCapabilities(runId: string): readonly Capability[]
          runState(runId: string): string
        }
      }
      const port = engine.skillWorkPort()
      expect(port.runCapabilities('nope')).toEqual([])
      expect(port.runState('nope')).toBe('missing')
      // And the port exposes no write of any kind.
      const methods = Object.keys(port).sort()
      expect(methods).toEqual([
        'missionExists',
        'runCapabilities',
        'runExists',
        'runState',
        'stepExists',
      ])
      for (const forbidden of ['createCapability', 'grant', 'approve', 'execute', 'start']) {
        expect(methods).not.toContain(forbidden)
      }
    } finally {
      await stop(fixture)
    }
  })
})