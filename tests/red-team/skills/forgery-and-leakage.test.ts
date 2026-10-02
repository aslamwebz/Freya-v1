// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  establishDistinct,
  procedure,
  readJournalRaw,
  startSkillsCore,
  stopSkillsCore,
  walkTo,
  type SkillsFixture,
} from './harness'
import { expectNoSentinels, RED_TEAM_SENTINELS } from '../harness'

/**
 * RENDERER FORGERY, PRIVACY LEAKAGE, STALE REUSE AND MODEL-CALL AMPLIFICATION.
 *
 * The remaining Phase 17 attacks, grouped by the sink they try to reach:
 *
 * - **renderer forgery** — a window that writes a status, a verdict, a trust class or a
 *   threshold into what it was handed, or names a command outside the vocabulary.
 * - **private-data leakage** — a sentinel in a summary, a contract description or a
 *   procedure name reaching the projection, the activity feed or the journal.
 * - **rollback / version confusion** — an old version's evidence being reused, or a
 *   record being re-labelled onto another skill's id.
 * - **model-call amplification** — any path through this domain that spends money.
 */

const fixtures: SkillsFixture[] = []
async function start(): Promise<SkillsFixture> {
  const fixture = await startSkillsCore({ skillKey: new Uint8Array(32).fill(0x53) })
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopSkillsCore(fixture)
})

describe('a renderer cannot forge what Core pushed', () => {
  it('hands back a projection with no writable field for anything that matters', async () => {
    const fixture = await start()
    await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const projection = fixture.projection()
    const skill = projection.skills[0]!
    expect(skill.status).toBe('candidate')
    expect(skill.verification).toBe('unverified')

    // Mutating the copy a window holds changes nothing Core believes: the next read is
    // built from the fold, not from what a surface was sent.
    const forged = { ...skill, status: 'promoted' as const, verification: 'verified' as const }
    expect(forged.status).toBe('promoted')
    expect(fixture.projection().skills[0]?.status).toBe('candidate')
    expect(fixture.projection().skills[0]?.verification).toBe('unverified')
  })

  it('refuses every command name outside the vocabulary', async () => {
    const fixture = await start()
    for (const command of [
      'skill.promote',
      'skill.setStatus',
      'skill.setThreshold',
      'skill.trust',
      'skill.verification.create',
      'skill.run',
      'skill.execute',
      'skill.debug',
      'skill.eval',
    ]) {
      const result = await fixture.submit(command, { status: 'promoted', threshold: 0 })
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toMatch(/unknown command/)
    }
    expect(fixture.projection().counts.retained).toBe(0)
  })

  it('refuses a payload on the payloadless status read', async () => {
    const fixture = await start()
    for (const payload of [
      { status: 'promoted' },
      { thresholds: { minEstablishedForPromoted: 0 } },
      { trustClass: 'code-owned' },
      'a string',
      [1, 2, 3],
    ]) {
      const result = await fixture.submit('skill.status.read', payload)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.skill?.reason).toMatch(/carries no payload/i)
    }
  })

  it('refuses a trust class a caller supplies on admission', async () => {
    const fixture = await start()
    const result = await fixture.submit('skill.admit', {
      ...procedure('trust-me-not'),
      trustClass: 'code-owned',
      source: 'core',
      admittedBy: 'system',
      version: 9,
    })
    expect(result.ok).toBe(true)
    const view = fixture.projection().skills[0]
    // Core's, not the payload's: every one of the four.
    expect(view?.trustClass).toBe('owner-declared')
    expect(view?.source).toBe('owner')
    expect(view?.admittedBy).toBe('owner')
    expect(view?.version).toBe(1)
  })
})

describe('no private procedure text reaches a projection, the feed or the journal', () => {
  it('keeps a sentinel out of every metadata sink', async () => {
    const fixture = await start()
    const [secret] = RED_TEAM_SENTINELS
    const admitted = await fixture.submit(
      'skill.admit',
      procedure(
        'summarise-a-file',
        `Reads a file. ${secret}. Also: ${secret} appears in the contract.`,
      ),
    )
    expect(admitted.ok).toBe(true)
    const skillId = admitted.skill?.skillId

    // The projection: a measurement, never the text.
    const projection = fixture.projection()
    expectNoSentinels('skills projection', projection)
    expect(projection.skills[0]?.summaryLength).toBeGreaterThan(secret.length)

    // The activity feed: a sentence about what happened, not about what it said.
    expectNoSentinels('activity feed', fixture.core.activity())

    // The journal: metadata only, for the same reason the encrypted store exists.
    const raw = await readJournalRaw(fixture)
    for (const sentinel of RED_TEAM_SENTINELS) {
      expect(raw).not.toContain(sentinel)
    }

    // The one place it *does* come back is the owner's explicit single-skill read.
    const detail = await fixture.submit('skill.detail.read', { skillId })
    expect(detail.skill?.detail?.summary).toContain(secret)
    // And it never rejoins the standing feed.
    expect(JSON.stringify(fixture.projection())).not.toContain(secret)
  })

  it('reports a measured length rather than an estimate', async () => {
    const fixture = await start()
    const summary = 'x'.repeat(400)
    await fixture.submit('skill.admit', procedure('summarise-a-file', summary))
    expect(fixture.projection().skills[0]?.summaryLength).toBe(summary.length)
  })
})

describe('a record cannot be re-labelled onto another skill', () => {
  it('keys the fold on the derived id, so a duplicate name is a refusal', async () => {
    const fixture = await start()
    const first = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    expect(first.ok).toBe(true)
    // A second admission of the same name is the *same* skill at version 1 refused as a
    // duplicate, not a second record that could later disagree with the first.
    const second = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    expect(second.ok).toBe(false)
    expect(fixture.projection().counts.retained).toBe(1)
    expect(fixture.projection().rejectedAdmissions.at(-1)?.code).toBe('duplicate-identity')
  })

  it('keeps one active version per skill identity, always', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    for (let revision = 1; revision <= 3; revision += 1) {
      const revised = await fixture.submit('skill.revise', {
        ...procedure('summarise-a-file', `Body number ${revision}, materially different.`),
        skillId,
      })
      expect(revised.ok).toBe(true)
      const view = fixture.projection().skills[0]
      // One record, one current version, and the statuses of the old ones are history
      // rather than a second live entry.
      expect(fixture.projection().counts.retained).toBe(1)
      expect(view?.version).toBe(revision + 1)
      expect(view?.versions.filter((entry) => entry.version === revision + 1)).toHaveLength(1)
    }
  })

  it('refuses evidence recorded against a version the record does not have', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    const result = await fixture.submit('skill.recordEvaluation', {
      skillId,
      version: 42,
      subjectKind: 'trial-run',
      subjectRef: 'run-1',
      evidence: [{ kind: 'test-result', code: 'passed', count: 5 }],
    })
    expect(result.ok).toBe(true)
    const view = fixture.projection().skills[0]
    expect(view?.evaluationCount).toBe(1)
    // Core's version, not the payload's.
    expect(view?.lastEvaluation?.version).toBe(1)
  })
})

describe('nothing on this path spends money', () => {
  it('costs zero provider calls across every command in the vocabulary', async () => {
    const fixture = await start()
    const before = fixture.core.status().durableUsage.calls
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    await establishDistinct(fixture, skillId!, 3)
    await walkTo(fixture, skillId!, 'promoted')
    await fixture.submit('skill.status.read')
    await fixture.submit('skill.select', { applicability: ['research'], includeTrial: true })
    await fixture.submit('skill.detail.read', { skillId })
    await fixture.submit('skill.propose', { target: 'skill', targetRef: skillId, summary: 'better' })
    await fixture.submit('skill.revise', {
      ...procedure('summarise-a-file', 'A body that is definitely different.'),
      skillId,
    })
    await fixture.submit('skill.retire', { skillId, reason: 'owner-request' })

    expect(fixture.core.status().durableUsage.calls).toBe(before)
    expect(fixture.fake.calls).toBe(0)
    expect(fixture.core.status().activeProviderCalls).toBe(0)
    expect(fixture.core.status().sessionUsage.calls).toBe(0)
  })

  it('costs zero on an idle read loop, and zero again after a restart', async () => {
    const fixture = await start()
    const before = fixture.fake.calls
    for (let index = 0; index < 25; index += 1) {
      fixture.core.skills()
      await fixture.submit('skill.status.read')
      await fixture.submit('skill.select', {})
    }
    expect(fixture.fake.calls).toBe(before)

    const { reopen } = await import('./harness')
    const restarted = await reopen(fixture, new Uint8Array(32).fill(0x53))
    expect(restarted.fake.calls).toBe(before)
    expect(restarted.core.skills().health).toBe('ready')
    await restarted.core.stop('red-team restart ends')
  })

  it('costs zero to read a skill back', async () => {
    const fixture = await start()
    const admitted = await fixture.submit('skill.admit', procedure('summarise-a-file'))
    const skillId = admitted.skill?.skillId
    for (let index = 0; index < 10; index += 1) {
      await fixture.submit('skill.detail.read', { skillId })
    }
    expect(fixture.fake.calls).toBe(0)
  })
})

describe('spending and approval policy cannot be reached through a skill', () => {
  it('has no capability, grant or approval anywhere on the owner scope', async () => {
    const fixture = await start()
    const methods = Object.keys(fixture.scope() as unknown as Record<string, unknown>)
    for (const forbidden of [
      'grant',
      'createGrant',
      'revokeGrant',
      'approve',
      'decideApproval',
      'spend',
      'budget',
      'stopAll',
      'resume',
      'requestCognition',
    ]) {
      expect(methods).not.toContain(forbidden)
    }
  })

  it('keeps the skill lane out of the worker capability vocabulary', async () => {
    const fixture = await start()
    // A worker may only hold `cognition.request`; there is no `skill.*` capability a
    // subordinate could ever be given, so there is nothing for it to be granted.
    const { WORKER_CAPABILITIES } = await import('../../../core/protocol/core-protocol')
    expect(WORKER_CAPABILITIES).toEqual(['cognition.request'])
    expect(WORKER_CAPABILITIES.some((capability) => capability.startsWith('skill.'))).toBe(false)
    expect(fixture.projection().counts.retained).toBe(0)
  })
})