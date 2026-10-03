import { describe, expect, it } from 'vitest'
import {
  LEARNING_GRANTS_NOTHING,
  LEARNING_LIMITS,
  LearningEngine,
  admitToSkills,
  assertProposalIsInert,
  isAdmissibleProposalName,
  isProposalSource,
  type ProcedureProposal,
} from '../../core/learning'
import { MemoryLearningStore } from '../../core/vault/repositories/learning-store'

/**
 * PHASE 28 — THE PIPELINE, THE OWNER'S ACTS, AND THE EXIT.
 *
 * The engine is the only way a learning record exists, so these tests pin the three things
 * that depend on it: the pipeline refuses to skip a stage, the owner's acts are
 * correction-without-erasure and withdrawal-without-disappearance, and the exit hands the
 * Skills domain inert data and nothing else.
 *
 * Deterministic: `now` and `newId` are injected, so no clock, no randomness, no model.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()

function makeEngine(options: { stopped?: () => boolean } = {}): {
  engine: LearningEngine
  store: MemoryLearningStore
} {
  let counter = 0
  const store = new MemoryLearningStore()
  const engine = new LearningEngine({
    store,
    now: () => NOW,
    newId: () => `gen-${(counter += 1)}`,
    stopped: options.stopped ?? (() => false),
  })
  return { engine, store }
}

async function seed(engine: LearningEngine, suffix: string): Promise<{ experienceId: string; knowledgeId: string }> {
  const outcome = await engine.recordVerifiedOutcome({
    outcomeId: `out-${suffix}`,
    sourceDomain: 'work',
    verificationId: `ver-${suffix}`,
    verifierId: 'work.step.verified',
    checked: 'the run completed and its verifier inspected the artefact',
    subjectRef: `run-${suffix}`,
    result: 'succeeded',
    establishedAt: NOW_ISO,
  })
  if (!outcome.ok) throw new Error(`outcome refused: ${outcome.code} ${outcome.reason}`)
  const lesson = await engine.distilExperience(`out-${suffix}`, {
    experienceId: `exp-${suffix}`,
    kind: 'tool-lesson',
    lesson: `the release verifier inspected the artefact bundle for ${suffix}`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    observedAt: NOW_ISO,
  })
  if (!lesson.ok) throw new Error(`lesson refused: ${lesson.code} ${lesson.reason}`)
  const claim = await engine.deriveKnowledge({
    knowledgeId: `kn-${suffix}`,
    kind: 'process-fact',
    claim: `a release check has to inspect the artefact bundle rather than trust the log (${suffix})`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    supports: [`exp-${suffix}`],
    tags: ['release'],
    observedAt: NOW_ISO,
  })
  if (!claim.ok) throw new Error(`claim refused: ${claim.code} ${claim.reason}`)
  return { experienceId: `exp-${suffix}`, knowledgeId: `kn-${suffix}` }
}

describe('the pipeline refuses to skip a stage', () => {
  it('cannot distil a lesson from an outcome nobody recorded', async () => {
    const engine = makeEngine().engine
    const outcome = await engine.distilExperience('out-never-checked', {
      experienceId: 'exp-1',
      kind: 'tool-lesson',
      lesson: 'a lesson about a check that did not happen',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-outcome')
  })

  it('cannot distil a claim from an experience that is not admitted', async () => {
    const { engine, store } = makeEngine()
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the artefact',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    // A claim citing an id Core holds but has not admitted.
    const claim = await engine.deriveKnowledge({
      knowledgeId: 'kn-1',
      kind: 'process-fact',
      claim: 'a claim resting on nothing that was ever established',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['exp-never-distilled'],
      observedAt: NOW_ISO,
    })
    expect(claim.ok).toBe(false)
    if (claim.ok) return
    expect(claim.code).toBe('no-supporting-experience')
    expect(store.state().knowledge.size).toBe(0)
  })

  it('records a checked outcome only with its verification id', async () => {
    const engine = makeEngine().engine
    const outcome = await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'not an id!',
      verifierId: 'work.step.verified',
      checked: 'a check with no verification behind it',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('invalid-evidence-refs')
  })

  it('refuses every write while stopped, and keeps the pipeline readable', async () => {
    let stop = true
    const { engine, store } = makeEngine({ stopped: () => stop })
    const outcome = await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'a check',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('store-unavailable')
    expect(store.state().outcomes.size).toBe(0)

    stop = false
    const allowed = await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'a check',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    expect(allowed.ok).toBe(true)
  })
})

describe('correction', () => {
  it('writes a replacement, supersedes the original, and loses nothing', async () => {
    const engine = makeEngine().engine
    const { knowledgeId } = await seed(engine, 'a')

    const corrected = await engine.correct(knowledgeId, {
      claim: 'a release check has to inspect the artefact bundle rather than trust the log (corrected)',
      reason: 'the owner corrected the wording',
      observedAt: NOW_ISO,
    })
    expect(corrected.ok).toBe(true)
    expect(corrected.outcome).toBe('corrected')
    expect(corrected.superseded).toBe(knowledgeId)
    expect(corrected.recordId).not.toBeNull()

    // The original is still readable, with the words it originally held. An edit that
    // rewrote it in place would have destroyed the fact that a correction happened.
    const original = engine.readClaim(knowledgeId)
    expect(original.ok).toBe(true)
    if (!original.ok) return
    expect(original.claim.status).toBe('superseded')
    expect(original.claim.claim).toContain('(a)')

    const replacement = engine.readClaim(corrected.recordId as string)
    expect(replacement.ok).toBe(true)
    if (!replacement.ok) return
    expect(replacement.claim.status).toBe('admitted')
    expect(replacement.claim.claim).toContain('(corrected)')
    // The replacement carries the same support, so its evidence is intact.
    expect(replacement.claim.supports).toEqual(['exp-a'])
    expect(replacement.claim.verificationIds).toEqual(['ver-a'])
  })

  it('refuses a correction with no reason, and a correction of something not live', async () => {
    const engine = makeEngine().engine
    const { knowledgeId } = await seed(engine, 'a')
    const unreasoned = await engine.correct(knowledgeId, { claim: 'new', reason: '', observedAt: NOW_ISO })
    expect(unreasoned.ok).toBe(false)
    if (unreasoned.ok) return
    expect(unreasoned.code).toBe('invalid-claim')

    await engine.withdraw(knowledgeId)
    const withdrawn = await engine.correct(knowledgeId, { claim: 'new', reason: 'a reason', observedAt: NOW_ISO })
    expect(withdrawn.ok).toBe(false)
    if (withdrawn.ok) return
    expect(withdrawn.code).toBe('not-admitted')
  })
})

describe('withdrawal and forgetting', () => {
  it('destroys the claim text and keeps the fact that it was withdrawn', async () => {
    const engine = makeEngine().engine
    const { knowledgeId } = await seed(engine, 'a')
    const withdrawn = await engine.withdraw(knowledgeId)
    expect(withdrawn.ok).toBe(true)

    const read = engine.readClaim(knowledgeId)
    if (!read.ok) throw new Error('the single read refused')
    expect(read.claim.claim).toBe('')
    expect(read.claim.textDestroyed).toBe(true)
    expect(read.claim.lifecycleReason).toBe('owner-withdrew-this-record')

    const derivation = engine.derive()
    expect(derivation.counts.knowledge).toBe(0)
    expect(derivation.counts.retracted).toBe(1)
  })

  it('refuses to forget a live claim and asks for the withdrawal first', async () => {
    const { engine, store } = makeEngine()
    const { knowledgeId } = await seed(engine, 'a')
    const refused = await engine.forget(knowledgeId)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('not-admitted')
    // Still there: a refused forget destroys nothing.
    expect(store.state().knowledge.has(knowledgeId)).toBe(true)

    await engine.withdraw(knowledgeId)
    expect((await engine.forget(knowledgeId)).ok).toBe(true)
    expect(store.state().knowledge.has(knowledgeId)).toBe(false)
    const exported = engine.export()
    if (!exported.ok) throw new Error('export refused')
    expect(exported.export.items.some((item) => item.recordId === knowledgeId)).toBe(false)
  })

  it('refuses to forget something that does not exist', async () => {
    const engine = makeEngine().engine
    const outcome = await engine.forget('kn-never')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-such-record')
  })
})

describe('the exit is inert data, and nothing else', () => {
  it('hands the Skills domain a packet with no authority field to find', async () => {
    const engine = makeEngine().engine
    await seed(engine, 'a')
    await seed(engine, 'b')
    const packets = engine.skillPackets()
    expect(packets.ok).toBe(true)
    if (!packets.ok) return
    expect(packets.packets).toHaveLength(1)
    const packet = packets.packets[0]!
    for (const field of Object.keys(packet)) {
      expect(field, field).not.toMatch(/capab|grant|authority|permission|allow|override|budget|spend/i)
    }
    expect(packet.executable).toBe(false)
    expect(packet.trustClass).toBe('derived')
    // `originRefs` are ids only, so a packet points at the evidence rather than copying it.
    for (const ref of packet.originRefs) {
      expect(ref, ref).toMatch(/^[A-Za-z0-9._:-]+$/)
    }
  })

it('offers nothing at all while the support is below threshold', async () => {
    const engine = makeEngine().engine
    await seed(engine, 'a')
    const packets = engine.skillPackets()
    expect(packets.ok).toBe(true)
    if (!packets.ok) return
    expect(packets.packets).toHaveLength(0)
  })

  it('refuses a forged proposal that claims to grant something', () => {
    const forged = {
      proposalId: 'prop-forged',
      name: 'a procedure that helps',
      steps: [{ key: 'step-1', summary: 'do the thing' }],
      knowledgeIds: ['kn-1'],
      experienceIds: ['exp-1'],
      distinctVerifications: 2,
      failedOutcomes: 0,
      scope: 'one-instance',
      scopeLimits: ['no-future-guarantee'],
      confidence: 'medium',
      grantsCapability: true,
      executable: true,
      authority: 'work.run.manage',
      support: {
        aboveThreshold: true,
        distinctVerifications: 2,
        distinctExperiences: 2,
        failedOutcomes: 0,
        staleVerifications: 0,
        reason: 'above-threshold',
      },
    } as unknown as ProcedureProposal
    const inert = assertProposalIsInert(forged)
    expect(inert.ok).toBe(false)
    if (inert.ok) return
    expect(inert.code).toBe('proposal-not-inert')
    // And it is refused rather than sanitised, because a silent repair is how a
    // forbidden field becomes a permitted one nobody reviewed.
    expect(admitToSkills(forged).ok).toBe(false)
  })

  it('refuses a proposal that carries a forbidden field name', () => {
    const forged = {
      proposalId: 'prop-forged',
      name: 'a procedure that helps',
      steps: [{ key: 'step-1', summary: 'do the thing' }],
      knowledgeIds: [],
      experienceIds: [],
      distinctVerifications: 2,
      failedOutcomes: 0,
      scope: 'one-instance',
      scopeLimits: ['no-future-guarantee'],
      confidence: 'medium',
      requiredCapability: 'work.run.manage',
      grantsCapability: false,
      executable: false,
      authority: 'none',
      support: {
        aboveThreshold: true,
        distinctVerifications: 2,
        distinctExperiences: 2,
        failedOutcomes: 0,
        staleVerifications: 0,
        reason: 'above-threshold',
      },
    } as unknown as ProcedureProposal
    const inert = assertProposalIsInert(forged)
    expect(inert.ok).toBe(false)
  })

  it('renders the guarantee as data rather than merely respecting it', () => {
    expect(LEARNING_GRANTS_NOTHING).toEqual({
      grantsCapability: false,
      grantsAuthority: false,
      grantsPermission: false,
      mayExecute: false,
      mayPromoteItself: false,
      reason: 'learning is evidence, not authority',
    })
    const projection = engineProjection()
    expect(projection.authority).toBe('none')
    expect(projection.confidenceCeiling).toBe('medium')
  })

  it('exposes no method that could promote, execute or activate', () => {
    const engine = makeEngine().engine
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object).map(String)
    for (const name of methods) {
      expect(name, `${name} sounds like a promotion path`).not.toMatch(
        /promote|activate|enable|grant|execute|install|register|deploy/i,
      )
    }
  })

  it('permits proposals only from a source that was not trying to produce them', () => {
    expect(isProposalSource('experience-outcome')).toBe(true)
    expect(isProposalSource('owner-assertion')).toBe(true)
    expect(isProposalSource('system-observation')).toBe(true)
    for (const source of ['model-inference', 'external-untrusted', 'imported-document', 'freya-inference'] as const) {
      expect(isProposalSource(source), source).toBe(false)
    }
  })

  it('refuses a proposal name that promises more than its evidence', () => {
    expect(isAdmissibleProposalName('verify the artefact before release')).toBe(true)
    expect(isAdmissibleProposalName('this always works')).toBe(false)
    expect(isAdmissibleProposalName('a guaranteed procedure')).toBe(false)
  })
})

describe('privacy boundaries', () => {
  it('carries no lesson or claim text in the projection or the broad read', async () => {
    const engine = makeEngine().engine
    await seed(engine, 'a')
    const projection = JSON.stringify(engine.project())
    const listed = JSON.stringify(engine.listRecords())
    expect(projection).not.toContain('release check has to inspect')
    expect(projection).not.toContain('release verifier inspected')
    expect(listed).not.toContain('release check has to inspect')
    expect(listed).not.toContain('release verifier inspected')
    // The only trace is a measured length.
    const records = engine.listRecords()
    if (!records.ok) throw new Error('list refused')
    const claim = records.records.items.find((item) => item.stage === 'knowledge')
    expect(claim?.textLength).toBeGreaterThan(0)
    // No `text` field exists on the view at all, which is stronger than a field that
    // happens to be empty: there is nothing for a renderer to read by mistake.
    expect(Object.keys(claim ?? {}).sort()).toEqual([
      'actor',
      'admittedAt',
      'confidence',
      'kind',
      'lifecycleAt',
      'lifecycleReason',
      'observedAt',
      'recordId',
      'recordedAt',
      'scope',
      'scopeLimits',
      'sourceDomain',
      'sourceType',
      'stage',
      'status',
      'supportCount',
      'tags',
      'textLength',
      'verificationCount',
      'verificationStatus',
    ])
  })

  it('carries the text only in the single-claim read and the owner export', async () => {
    const engine = makeEngine().engine
    const { knowledgeId } = await seed(engine, 'a')
    const single = engine.readClaim(knowledgeId)
    if (!single.ok) throw new Error('the single read refused')
    expect(single.claim.claim).toContain('release check has to inspect')
    const exported = engine.export()
    if (!exported.ok) throw new Error('export refused')
    expect(exported.export.items.some((item) => item.text.includes('release check has to inspect'))).toBe(true)
  })

  it('reports what the export bound withheld, so a partial export is never read as complete', async () => {
    const engine = makeEngine().engine
    for (let i = 0; i < LEARNING_LIMITS.maxProjectionRecords + 1; i += 1) {
      await seed(engine, `n${i}`)
    }
    const exported = engine.export()
    if (!exported.ok) throw new Error('export refused')
    expect(exported.export.items.length).toBe(LEARNING_LIMITS.maxProjectionRecords * 2)
    expect(exported.export.withheld).toBeGreaterThan(0)
  })

  it('reports an ephemeral store as ephemeral rather than as durable memory', () => {
    const ephemeral = new MemoryLearningStore({ mode: 'ephemeral', faultReason: 'no Vault key was available' })
    const engine = new LearningEngine({ store: ephemeral, now: () => NOW })
    const projection = engine.project()
    expect(projection.persistence.mode).toBe('ephemeral')
    expect(projection.persistence.durable).toBe(false)
    expect(projection.persistence.reason).toContain('no Vault key')
  })
})

describe('the retention bound', () => {
  it('retires the oldest records under a code-owned bound and says so', async () => {
    const { engine, store } = makeEngine()
    // Increasing observed instants, so "oldest" is unambiguous rather than falling back to
    // an id tie-break among records written in the same instant.
    const base = Date.parse('2025-01-01T00:00:00.000Z')
    const at = (index: number): string => new Date(base + index * 60_000).toISOString()
    const seeds = Math.ceil(LEARNING_LIMITS.maxLiveRecords / 2) + 4
    for (let i = 0; i < seeds; i += 1) {
      await engine.recordVerifiedOutcome({
        outcomeId: `out-r${i}`,
        sourceDomain: 'work',
        verificationId: `ver-r${i}`,
        verifierId: 'work.step.verified',
        checked: 'the run completed and its verifier inspected the artefact',
        subjectRef: `run-r${i}`,
        result: 'succeeded',
        establishedAt: at(i),
      })
      await engine.distilExperience(`out-r${i}`, {
        experienceId: `exp-r${i}`,
        kind: 'tool-lesson',
        lesson: `the release verifier inspected the artefact bundle for run ${i}`,
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        observedAt: at(i),
      })
      await engine.deriveKnowledge({
        knowledgeId: `kn-r${i}`,
        kind: 'process-fact',
        claim: `a release check has to inspect the artefact bundle rather than trust the log (run ${i})`,
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        supports: [`exp-r${i}`],
        tags: ['release'],
        observedAt: at(i),
      })
    }
    const derivation = engine.derive()
    expect(derivation.counts.expired).toBeGreaterThan(0)
    const expired = [...store.state().knowledge.values()].filter((entry) => entry.status === 'expired')
    for (const entry of expired) {
      expect(entry.claim).toBe('')
      expect(entry.lifecycleReason).toBe('retention-bound-reached')
    }
    // The newest records survive: the bound retires the oldest, not the last written.
    const newest = store.state().knowledge.get(`kn-r${seeds - 1}`)
    expect(newest?.status).toBe('admitted')
    expect(store.state().knowledge.get('kn-r0')?.status).toBe('expired')
  }, 30_000)

  it('does nothing while stopped', async () => {
    const engine = new LearningEngine({ store: new MemoryLearningStore(), now: () => NOW, stopped: () => true })
    expect(await engine.applyRetentionBound()).toEqual([])
  })
})

function engineProjection() {
  return makeEngine().engine.project()
}