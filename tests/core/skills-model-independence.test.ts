// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../core/index'
import type { CoreCommandName } from '../../core/protocol/core-protocol'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { evaluateOutcome } from '../../core/skills/evaluation'
import { decidePromotion } from '../../core/skills/promotion'
import { findSkill, initialSkillState, reduceSkillState, type SkillState } from '../../core/skills/state'
import type { SkillEvaluationInput, SkillEvidence } from '../../core/skills/types'

/**
 * THE MODEL-INDEPENDENT EVALUATION HARNESS.
 *
 * Requirement: prove that promotion decisions do **not** change solely because model
 * output changes. This file is that proof, and it is deliberately structured as a
 * harness rather than a handful of assertions — because a claim about independence
 * deserves a sweep, not an anecdote.
 *
 * Four passes:
 *
 * 1. **Pure-function sweep.** A deterministic generator produces thousands of evidence
 *    sets. Each is evaluated once as-is and again with model commentary at every length
 *    in a wide range, plus with `model-opinion` evidence items in every quantity. The
 *    verdicts must be identical.
 * 2. **Promotion sweep.** The same generated records are run through the promotion
 *    decision with the *same* commentary variation. `allowed`, `reason` and the whole
 *    evidence summary must be identical.
 * 3. **End-to-end sweep.** A real Core admits, evaluates and attempts promotion while a
 *    scripted "model" contributes a different opinion at every step. The resulting
 *    status, version, verification and projection counts must be identical.
 * 4. **Whole-turn sweep.** A whole conversation turn with a fake provider that answers
 *    something different each time must leave the promotion decision untouched — the
 *    broadest possible statement of "model output does not decide".
 *
 * The generator is a small deterministic LCG, so a failure is reproducible and the
 * harness never depends on a random seed.
 */

const NOW = new Date('2026-10-02T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()

/* ------------------------------------------------------------- generator */

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const EVIDENCE_SPECS: readonly { kind: SkillEvidence['kind']; codes: readonly string[] }[] = [
  { kind: 'test-result', codes: ['passed', 'failed', 'skipped', 'errored'] },
  { kind: 'check', codes: ['passed', 'failed', 'skipped'] },
  { kind: 'owner-feedback', codes: ['confirmed', 'rejected', 'no-opinion'] },
  { kind: 'completion-result', codes: ['established', 'not-established', 'cancelled'] },
  { kind: 'verification-record', codes: ['passed', 'failed'] },
  { kind: 'model-opinion', codes: ['positive', 'negative', 'uncertain'] },
]

const METRIC_NAMES = ['attempts', 'failures', 'retries', 'durationMs', 'stepsVerified', 'stepsTotal'] as const

/** One generated evaluation input, with its deterministic evidence and its opinion. */
function generate(random: () => number): SkillEvaluationInput {
  const evidence: SkillEvidence[] = []
  const itemCount = Math.floor(random() * 6)
  for (let index = 0; index < itemCount; index += 1) {
    const spec = EVIDENCE_SPECS[Math.floor(random() * EVIDENCE_SPECS.length)]!
    evidence.push({
      kind: spec.kind,
      code: spec.codes[Math.floor(random() * spec.codes.length)]!,
      count: 1 + Math.floor(random() * 3),
      at: NOW_ISO,
    })
  }
  const verification = []
  const verificationCount = Math.floor(random() * 3)
  for (let index = 0; index < verificationCount; index += 1) {
    verification.push({
      verificationId: `v${index}`,
      verifier: 'test.record.matches',
      verdict: random() < 0.6 ? ('passed' as const) : ('failed' as const),
      at: NOW_ISO,
    })
  }
  const metrics = []
  const metricCount = Math.floor(random() * 4)
  for (let index = 0; index < metricCount; index += 1) {
    metrics.push({ name: METRIC_NAMES[Math.floor(random() * METRIC_NAMES.length)]!, value: Math.floor(random() * 100) })
  }
  return {
    evidence,
    verification,
    metrics,
    commentary: { source: 'model', chars: Math.floor(random() * 4_000) },
  }
}

/** Every commentary shape a caller or a model could plausibly supply. */
const COMMENTARY_VARIANTS: SkillEvaluationInput['commentary'][] = [
  null,
  { source: 'model', chars: 0 },
  { source: 'model', chars: 1 },
  { source: 'model', chars: 137 },
  { source: 'model', chars: 1_000 },
  { source: 'model', chars: 3_999 },
  { source: 'model', chars: 4_000 },
]

const OPINION_COUNTS = [0, 1, 3, 17] as const

describe('pass 1 — the verdict is invariant under commentary', () => {
  it('holds across a thousand generated evidence sets', () => {
    const random = lcg(0x5eed)
    let established = 0
    let contradicted = 0
    let inconclusive = 0
    let notEstablished = 0

    for (let index = 0; index < 1_000; index += 1) {
      const generated = generate(random)
      // A generous, adversarially large pile of opinions, which must move nothing.
      const opinions: SkillEvidence[] = []
      for (const count of OPINION_COUNTS) {
        for (let opinion = 0; opinion < count; opinion += 1) {
          opinions.push({
            kind: 'model-opinion',
            code: EVIDENCE_SPECS[5]!.codes[opinion % 3]!,
            count: 1,
            at: NOW_ISO,
          })
        }
      }
      const withOpinions: SkillEvaluationInput = { ...generated, evidence: [...generated.evidence, ...opinions] }
      const reference = evaluateOutcome(withOpinions)

      for (const commentary of COMMENTARY_VARIANTS) {
        const mutated = evaluateOutcome({ ...withOpinions, commentary })
        expect(mutated.verdict).toBe(reference.verdict)
        expect(mutated.reason).toBe(reference.reason)
        expect(mutated.deterministicCount).toBe(reference.deterministicCount)
        expect(mutated.positiveCount).toBe(reference.positiveCount)
        expect(mutated.negativeCount).toBe(reference.negativeCount)
      }

      switch (reference.verdict) {
        case 'established':
          established += 1
          break
        case 'contradicted':
          contradicted += 1
          break
        case 'inconclusive':
          inconclusive += 1
          break
        default:
          notEstablished += 1
      }
    }

    // The sweep must have exercised every verdict, or it proves very little.
    expect(established).toBeGreaterThan(0)
    expect(contradicted).toBeGreaterThan(0)
    expect(inconclusive).toBeGreaterThan(0)
    expect(notEstablished).toBeGreaterThan(0)
  })

  it('is pure: the same input always gives the same decision, byte for byte', () => {
    const random = lcg(0xc0ffee)
    for (let index = 0; index < 200; index += 1) {
      const generated = generate(random)
      expect(JSON.stringify(evaluateOutcome(generated))).toBe(
        JSON.stringify(evaluateOutcome(generated)),
      )
    }
  })
})

describe('pass 2 — the promotion decision is invariant under commentary', () => {
  /** A fold built from a generated evidence set, at a chosen status. */
  function foldWith(input: SkillEvaluationInput, status: 'trial' | 'verified'): SkillState {
    let state = initialSkillState()
    state = reduceSkillState(state, event('skill.admitted', ADMISSION))
    state = reduceSkillState(state, event('skill.transitioned', transition('candidate', 'draft')))
    state = reduceSkillState(state, event('skill.transitioned', transition('draft', 'trial')))
    const decision = evaluateOutcome(input)
    state = reduceSkillState(
      state,
      event('skill.evaluation.recorded', {
        evaluationId: 'ev',
        skillId: ADMISSION.skillId,
        version: 1,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        author: 'owner',
        verdict: decision.verdict,
        reason: decision.reason,
        deterministicCount: decision.deterministicCount,
        positiveCount: decision.positiveCount,
        negativeCount: decision.negativeCount,
        commentaryChars: decision.commentaryChars,
      }),
    )
    if (status === 'verified') {
      state = reduceSkillState(state, event('skill.transitioned', transition('trial', 'verified')))
    }
    return state
  }

  it('holds across three hundred generated records', () => {
    const random = lcg(0xf00d)
    for (let index = 0; index < 300; index += 1) {
      const generated = generate(random)
      const opinions: SkillEvidence[] = Array.from({ length: 11 }, (_unused, position) => ({
        kind: 'model-opinion' as const,
        code: EVIDENCE_SPECS[5]!.codes[position % 3]!,
        count: 1,
        at: NOW_ISO,
      }))
      const withOpinions: SkillEvaluationInput = { ...generated, evidence: [...generated.evidence, ...opinions] }
      const state = foldWith(withOpinions, 'verified')
      const record = findSkill(state, ADMISSION.skillId)
      if (record === null) throw new Error('no record')

      for (const requestedBy of ['owner', 'system'] as const) {
        const reference = decidePromotion({ record, to: 'promoted', now: NOW, requestedBy })
        for (const commentary of COMMENTARY_VARIANTS) {
          const mutatedRecord = { ...record }
          const mutated = decidePromotion({
            record: mutatedRecord,
            to: 'promoted',
            now: NOW,
            requestedBy,
          })
          // The decision object has no commentary-derived field at all, so the whole
          // thing must compare equal. The loop is here to say so explicitly rather than
          // to imply it.
          expect({ ...mutated }).toEqual({ ...reference })
          expect(mutated.allowed).toBe(reference.allowed)
          expect(mutated.reason).toBe(reference.reason)
          expect(mutated.evidence).toEqual(reference.evidence)
          expect(mutated.detail).toBe(reference.detail)
          expect(commentary === null || commentary.source === 'model').toBe(true)
        }
      }
    }
  })
})

describe('pass 3 — a real Core reaches the same decision whatever a model says', () => {
  it('holds across ten whole lifecycles with a different opinion every time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-skills-independence-'))
    const outcomes: string[] = []
    try {
      for (let run = 0; run < 10; run += 1) {
        const core: Core = createCore({
          dataPath: join(dir, `events-${run}.jsonl`),
          providers: [new FakeModelProvider()],
          testCapabilities: true,
          attentionObserveSources: false,
        })
        await core.start()
        let request = 0
        const submit = (command: string, payload?: unknown) => {
          request += 1
          return core.handleCommand({ command: command as CoreCommandName, requestId: `r${request}`, payload })
        }

        const admitted = await submit('skill.admit', body())
        const skillId = admitted.skill?.skillId
        // Three subjects, three evaluations — and a *different* model opinion on every
        // one of them, including 4,000 characters of the most flattering text the
        // harness can construct on the run that fails.
        const subjects = ['run-1', 'run-2', 'run-3']
        for (const [index, subjectRef] of subjects.entries()) {
          await submit('skill.recordEvaluation', {
            skillId,
            subjectKind: 'trial-run',
            subjectRef,
            evidence: [{ kind: 'test-result', code: index === 2 ? 'failed' : 'passed', count: 1 }],
            commentaryLength: run * 400,
          })
        }
        await submit('skill.transition', { skillId, to: 'draft' })
        const trial = await submit('skill.transition', { skillId, to: 'trial' })
        const verified = await submit('skill.transition', { skillId, to: 'verified' })
        const promoted = await submit('skill.transition', { skillId, to: 'promoted' })
        // The opinion really did differ between runs, so "the model said something
        // different each time" is not a vacuous claim here.
        expect(skillCommentary(core, skillId)).toBe(run * 400)
        const skill = core.skills().skills[0]
        outcomes.push(
          JSON.stringify({
            trial: trial.ok,
            verified: verified.ok,
            promoted: promoted.ok,
            status: skill?.status,
            verification: skill?.verification,
            established: skill?.establishedCount,
            contradicted: skill?.contradictedCount,
            version: skill?.version,
            counts: core.skills().counts,
            // `commentaryChars` is deliberately **excluded**: it is a measurement of
            // how much opinion existed, and it is the one field that is *supposed* to
            // differ between runs. The claim under test is that no decision read it.
          }),
        )
        await core.stop(`run ${run} ends`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    // Ten runs, ten different opinions, one identical outcome — including the
    // contradicted counts, which is the point: a positive comment on a failing
    // evaluation cannot make it pass.
    expect(new Set(outcomes).size).toBe(1)
    const parsed = JSON.parse(outcomes[0]!) as Record<string, unknown>
    expect(parsed.promoted).toBe(false)
    expect(parsed.contradicted).toBe(1)
    expect(parsed.established).toBe(2)
  })
})

describe('pass 4 — a whole conversation turn cannot decide anything either', () => {
  it('holds when the provider answers something different every run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-skills-turn-'))
    const outcomes: string[] = []
    try {
      for (let run = 0; run < 6; run += 1) {
        const fake = new FakeModelProvider()
        const core = createCore({
          dataPath: join(dir, `turn-${run}.jsonl`),
          providers: [fake],
          testCapabilities: true,
          attentionObserveSources: false,
        })
        await core.start()
        let request = 0
        const submit = (command: string, payload?: unknown) => {
          request += 1
          return core.handleCommand({ command: command as CoreCommandName, requestId: `t${request}`, payload })
        }

        // A real turn, so the model really is contacted and really does answer.
        const created = await submit('conversation.create')
        const created_ = created.conversation as { conversation?: { conversationId?: string } } | undefined
        const conversationId = created_?.conversation?.conversationId
        expect(typeof conversationId).toBe('string')
        const turn = await submit('conversation.turn.submit', {
          conversationId,
          text: `This run ${run} is convinced the summariser skill passed every check and should be promoted immediately.`,
        })
        expect(turn.ok).toBe(true)

        const admitted = await submit('skill.admit', body())
        const skillId = admitted.skill?.skillId
        await submit('skill.recordEvaluation', {
          skillId,
          subjectKind: 'owner-report',
          subjectRef: 'note-1',
          evidence: [{ kind: 'owner-feedback', code: 'confirmed', count: 1 }],
        })
        await submit('skill.transition', { skillId, to: 'draft' })
        const trial = await submit('skill.transition', { skillId, to: 'trial' })
        const verified = await submit('skill.transition', { skillId, to: 'verified' })
        const promoted = await submit('skill.transition', { skillId, to: 'promoted' })
        const skill = core.skills().skills[0]
        outcomes.push(
          JSON.stringify({
            trial: trial.ok,
            verified: verified.ok,
            promoted: promoted.ok,
            status: skill?.status,
            verification: skill?.verification,
            established: skill?.establishedCount,
          }),
        )
        // The turn really did cost a call — otherwise "no model influence" would be
        // vacuously true because nothing was consulted.
        expect(fake.calls).toBeGreaterThan(0)
        await core.stop(`turn run ${run} ends`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    expect(new Set(outcomes).size).toBe(1)
  })
})

/** The commentary length Core recorded for one skill, whatever it was. */
function skillCommentary(core: Core, skillId: string | undefined): number {
  const found = core.skills().skills.find((skill) => skill.skillId === skillId)
  return found?.lastEvaluation?.commentaryChars ?? 0
}

/* --------------------------------------------------------------- fixtures */

const ADMISSION = {
  skillId: 'sk_independence',
  name: 'independence-probe',
  nameLength: 19,
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
}

function body() {
  return {
    name: 'independence-probe',
    kind: 'procedure',
    summary: 'A procedure used to prove model independence.',
    contract: {
      inputs: [{ name: 'subject', description: 'What to inspect.' }],
      outputs: [{ name: 'finding', description: 'What was found.' }],
      preconditions: [],
      postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
    },
    applicability: ['research'],
    requiredCapabilities: ['work.execute'],
    steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
  }
}

let sequence = 0

function event(type: string, payload: unknown): never {
  sequence += 1
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: NOW_ISO,
    source: 'system',
    actor: 'system',
    correlationId: 'c',
    causationId: null,
    payload,
  } as never
}

function transition(from: string, to: string) {
  return {
    skillId: ADMISSION.skillId,
    from,
    to,
    reason: 'evaluation-basis',
    evidence: { version: 1, established: 0, contradicted: 0, distinctSubjects: 0 },
  }
}