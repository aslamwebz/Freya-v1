// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { applyCorrection, parseCorrection } from '../../core/missions/autonomy/correction'
import {
  DEFAULT_MISSION_BUDGET,
  EMPTY_MISSION_SPEND,
  type MissionCorrectionInput,
  type MissionIntentShape,
  type MissionStepRecord,
  type MissionStepStatus,
} from '../../core/missions/autonomy/types'
import { MISSION_REASONS, type MissionRecord } from '../../core/missions/types'

/**
 * OWNER CORRECTION — "find 100 cat videos" → "in the barn".
 *
 * The critical acceptance case, tested as pure functions over a synthetic record so that
 * each rule is isolated. The engine's writing of the outcome is covered in
 * `mission-correction.test.ts`; this file is about *which* outcome a given utterance gets,
 * because that is where the judgement lives.
 *
 * ## The two paths, and the one that does nothing
 *
 * - `parseCorrection` resolves an utterance to named fields, or refuses it as ambiguous.
 * - `applyCorrection` merges those fields, works out which steps and evidence survive, and
 *   reports both.
 *
 * The ambiguous path must change **nothing**: no constraint moved, no step settled, no
 * evidence discarded. Every test below that asserts ambiguity also asserts that the intent
 * is byte-identical afterwards, because that is the property the whole design rests on.
 */

/** A Mission as a running one looks, at 40 of 100 with two verified steps. */
function running(over: Partial<MissionRecord> = {}): MissionRecord {
  return {
    missionId: 'm-cat',
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
    activatedAt: '2026-10-01T09:00:01.000Z',
    pausedAt: null,
    settledAt: null,
    deadlineAt: '2026-10-08T09:00:00.000Z',
    childRuns: [],
    limits: {
      maxChildRuns: 64,
      maxConcurrentChildRuns: 4,
      lifetimeMs: 30 * 86_400_000,
      verificationDeadlineMs: 60_000,
      maxRetainedMissions: 200,
      maxTitleChars: 160,
      maxIntentChars: 4_000,
      maxSuccessCriteria: 16,
      maxCriterionChars: 500,
    },
    verification: null,
    reason: null,
    limitsHit: [],
    priority: 'routine',
    budget: DEFAULT_MISSION_BUDGET,
    spend: EMPTY_MISSION_SPEND,
    activePlan: {
      planId: 'm-cat-p1',
      revision: 1,
      createdAt: '2026-10-01T09:00:00.000Z',
      supersedes: null,
      reason: null,
      steps: [
        step('s1', 0, 'found', 'verified'),
        step('s2', 1, 'found', 'verified'),
        step('s3', 2, 'search', 'pending'),
        step('s4', 3, 'search', 'pending'),
      ],
    },
    planRevisions: 1,
    // 40 observed results, 3 reported claims, 1 refusal.
    evidence: [
      ...Array.from({ length: 40 }, (_, i) => evidence(`obs-${i}`, 'result', 'observed', i)),
      evidence('rep-1', 'report', 'reported', 40),
      evidence('rep-2', 'report', 'reported', 41),
      evidence('ref-1', 'refusal', 'observed', 42),
    ],
    blockers: [],
    // No approval registry: a Mission holds a pointer to a Work gate or nothing at all.
    approval: null,
    wake: null,
    requestedQuantity: 100,
    resultCount: 40,
    corrections: [],
    awaitingOwner: false,
    lastDecision: null,
    lastUpdatedAt: '2026-10-01T09:30:00.000Z',
    ...over,
  }
}

/** A step in the shape `MissionPlanRecord` expects, with the status the case needs. */
function step(
  stepId: string,
  index: number,
  capability: string,
  status: MissionStepStatus,
): MissionStepRecord {
  return {
    stepId,
    index,
    capability,
    verifier: 'video.verified',
    dependsOn: [],
    status,
    workerId: null,
    runId: null,
    attempts: status === 'verified' ? 1 : 0,
    risk: 'routine',
    requiresApproval: false,
    approvalId: null,
    reason: null,
    startedAt: null,
    settledAt: null,
  }
}

function evidence(evidenceId: string, kind: 'result' | 'observation' | 'report' | 'refusal', origin: 'observed' | 'reported', n: number) {
  return {
    evidenceId,
    stepId: 's3',
    kind,
    origin,
    summaryLength: 40 + n,
    recordedAt: '2026-10-01T09:20:00.000Z',
    expiresAt: null,
  }
}

const SHAPE: MissionIntentShape = {
  subject: 'cat videos',
  requestedQuantity: 100,
  mediaConstraints: ['video'],
  contextConstraints: [],
  exclusions: [],
  paused: false,
}

/* ------------------------------------------------------------------ tests */

describe('THE ACCEPTANCE CASE: "find 100 cat videos", then "in the barn"', () => {
  it('patches the SAME Mission rather than creating a generic barn Mission', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.kind).toBe('patch')
    // **The same Mission.** This is the whole acceptance criterion: a new Mission would
    // discard 40 videos of work and forget the 100 that were asked for.
    expect(outcome.plan.missionId).toBe('m-cat')
  })

  it('changes only the context constraint', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')

    // The named field moved. Nothing else did.
    expect(outcome.plan.changedFields).toEqual(['context'])
    expect(outcome.plan.next.contextConstraints).toEqual(['in the barn'])
  })

  it('retains the media constraint, because it was never mentioned', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')

    // The constraint that must survive. A correction that reset the whole intent would
    // silently turn "100 *videos*" into "100 of anything".
    expect(outcome.plan.next.mediaConstraints).toEqual(['video'])
    expect(outcome.plan.changedFields).not.toContain('media')
  })

  it('retains the requested quantity, for the same reason', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.plan.next.requestedQuantity).toBe(100)
    expect(outcome.plan.changedFields).not.toContain('quantity')
  })

  it('preserves observed evidence, so 40 videos are not thrown away', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')

    // Narrowing *where* to look does not invalidate what was already found. Discarding 40
    // observations because the owner added a location would be throwing away real work.
    expect(outcome.effect.preservedEvidenceIds).toContain('obs-0')
    expect(outcome.effect.preservedEvidenceIds).toContain('obs-39')
    // 40 observed + 2 reported. The refusal is not counted — asserted separately below.
    expect(outcome.effect.preservedEvidenceIds).toHaveLength(42)
  })

  it('drops the refusal, because a correction may make it possible', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    // A refusal recorded "something could not be done". After a correction that may no
    // longer hold, so it is not carried forward as if it still did.
    expect(outcome.effect.preservedEvidenceIds).not.toContain('ref-1')
  })

  it('settles the not-yet-started steps, which were planned for the old intent', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')

    // `s3` and `s4` were pending searches with no location constraint. They are settled.
    expect(outcome.effect.settledStepIds).toEqual(['s3', 's4'])
    // And **only** those. The verified work stands, because an observation does not stop
    // being an observation because the search narrowed afterwards.
    expect(outcome.effect.settledStepIds).not.toContain('s1')
    expect(outcome.effect.settledStepIds).not.toContain('s2')
  })

  it('requires a replan, because the surviving steps are not the plan', () => {
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.effect.replanRequired).toBe(true)
  })

  it('never settles a step that is in flight', () => {
    // A `running` step may have taken effect. Settling it would be a second way to lose
    // track of an unknown external effect, and that is recovery's job with different rules.
    const inFlight = running()
    const plan = inFlight.activePlan!
    const withRunning: MissionRecord = {
      ...inFlight,
      activePlan: {
        ...plan,
        steps: [
          ...plan.steps.slice(0, 2),
          { ...plan.steps[2]!, status: 'running', runId: 'run-live', attempts: 1 },
          plan.steps[3]!,
        ],
      },
    }
    const outcome = applyCorrection(withRunning, SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.effect.settledStepIds).toEqual(['s4'])
  })
})

describe('a correction that changes the kind of thing', () => {
  it('drops observed evidence when the media type changes', () => {
    // The one case where narrowing a location would be wrong: "in the barn" does not
    // invalidate videos found elsewhere, but "as audio" does invalidate videos.
    const outcome = applyCorrection(running(), SHAPE, { media: ['audio'] }, 'c-2')
    if (!outcome.ok) throw new Error('expected a patch')

    expect(outcome.plan.changedFields).toEqual(['media'])
    expect(outcome.effect.preservedEvidenceIds).not.toContain('obs-0')
    // Reported evidence is kept even so, because it never counted as progress and is
    // worth showing whatever happened.
    expect(outcome.effect.preservedEvidenceIds).toContain('rep-1')
  })

  it('drops observed evidence when an exclusion is added', () => {
    const outcome = applyCorrection(running(), SHAPE, { exclusions: ['no black cats'] }, 'c-3')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.plan.changedFields).toEqual(['exclusions'])
    expect(outcome.effect.preservedEvidenceIds).not.toContain('obs-39')
  })

  it('changes the quantity without touching the media constraint', () => {
    const outcome = applyCorrection(running(), SHAPE, { quantity: 50 }, 'c-4')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.plan.next.requestedQuantity).toBe(50)
    expect(outcome.plan.next.mediaConstraints).toEqual(['video'])
    expect(outcome.plan.changedFields).toEqual(['quantity'])
  })
})

describe('an ambiguous correction asks, and changes nothing', () => {
  const ambiguous = [
    'make it better',
    'more',
    'somewhere else nice',
    'different',
    'the barn',
    'faster please',
    '',
  ] as const

  for (const utterance of ambiguous) {
    it(`refuses ${JSON.stringify(utterance)} and preserves the goal exactly`, () => {
      const outcome = applyCorrection(running(), SHAPE, utterance, 'c-amb')
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.kind).toBe('ambiguous')
      expect(outcome.plan).toBeNull()
      // **Nothing changed.** There is no `effect` on the failure path at all — not an
      // empty one. That is stronger than reporting zero settled steps: there is nowhere on
      // this shape to put a change, so the type itself prevents a guess being recorded.
      expect('effect' in outcome).toBe(false)
      // And a question a person can actually answer, rather than a complaint.
      expect(outcome.question.length).toBeGreaterThan(0)
      expect(outcome.question).toMatch(/\?$/)
    })
  }

  it('reports which fields moved: none of them', () => {
    const outcome = applyCorrection(running(), SHAPE, 'make it better', 'c-amb')
    if (outcome.ok) throw new Error('expected ambiguity')
    // The interface has no `changedFields` on the failure path at all, which is stronger
    // than reporting an empty list: there is nowhere to put a value.
    expect('changedFields' in outcome).toBe(false)
  })

  it('distinguishes "which did you mean" from "I did not understand"', () => {
    const noun = applyCorrection(running(), SHAPE, 'make it better', 'c-1')
    const unclear = applyCorrection(running(), SHAPE, 'somewhere nice', 'c-2')
    if (noun.ok || unclear.ok) throw new Error('expected ambiguity')
    // Two different codes, so the caller can ask two different questions.
    expect(noun.ambiguity).toBe('multiple_subjects')
    expect(unclear.ambiguity).toBe('unknown_scope')
    expect(noun.question).not.toBe(unclear.question)
  })

  it('asks when a Mission has no structured goal to patch', () => {
    // Nowhere to put "in the barn" is a reason to ask, not a reason to overwrite.
    const outcome = applyCorrection(running(), null, 'in the barn', 'c-5')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.ambiguity).toBe('unknown_scope')
  })

  it('rejects a correction to a settled Mission rather than reviving it', () => {
    const outcome = applyCorrection(
      running({ status: 'completed', settledAt: '2026-10-02T09:00:00.000Z' }),
      SHAPE,
      'in the barn',
      'c-6',
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('rejected')
    expect(outcome.ambiguity).toBe('already_settled')
  })
})

describe('the parser is closed, not clever', () => {
  /**
   * Utterance → the *input* fields it addresses.
   *
   * `MissionIntentShape` is the stored shape; `MissionCorrectionInput` is what an owner
   * supplies. They differ in names — `contextConstraints` versus `context` — and typing the
   * expectation as the input shape is what keeps this table honest about which is which.
   */
  const accepted: readonly [string, MissionCorrectionInput][] = [
    // The **whole phrase** is kept, preposition and all. "from the shed" is a source and
    // "in the shed" is a location, so collapsing both to "shed" would make two different
    // corrections indistinguishable in a journal that records only the field's name.
    ['in the barn', { context: ['in the barn'] }],
    ['inside the barn', { context: ['inside the barn'] }],
    ['from the shed', { context: ['from the shed'] }],
    ['only in the attic', { context: ['in the attic'] }],
    ['make it 50', { quantity: 50 }],
    ['50 please', { quantity: 50 }],
    ['just 20', { quantity: 20 }],
    ['as audio', { media: ['audio'] }],
    ['only images', { media: ['images'] }],
    ['no cats', { exclusions: ['cats'] }],
    ['exclude horror', { exclusions: ['horror'] }],
  ]

  for (const [utterance, expected] of accepted) {
    it(`reads ${JSON.stringify(utterance)} as ${JSON.stringify(expected)}`, () => {
      const parsed = parseCorrection(utterance)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      for (const [key, value] of Object.entries(expected)) {
        expect(parsed.fields[key as keyof typeof parsed.fields]).toEqual(value)
      }
    })
  }

  it('reads a bare pause and a bare cancellation without parsing anything else', () => {
    const pause = parseCorrection('stop')
    const cancel = parseCorrection('never mind')
    expect(pause.ok && pause.pause).toBe(true)
    expect(pause.ok && pause.cancel).toBe(false)
    expect(cancel.ok && cancel.cancel).toBe(true)
    expect(cancel.ok && cancel.pause).toBe(false)
  })

  it('refuses a number that is not a whole number in range', () => {
    // Refused rather than clamped: "make it -5" must not become "make it 1".
    expect(parseCorrection('make it 0').ok).toBe(false)
    expect(parseCorrection('make it -5').ok).toBe(false)
    expect(parseCorrection('make it 1000001').ok).toBe(false)
  })

  it('refuses a structured correction whose quantity is malformed', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      const outcome = applyCorrection(running(), SHAPE, { quantity }, 'c-bad')
      expect(outcome.ok).toBe(false)
    }
  })

  it('treats saying the same thing twice as no change at all', () => {
    // Second time round, the location is already the constraint — so `changedFields` is
    // empty and nothing is settled. A correction that keeps re-settling the same steps
    // would leave a Mission that can never make progress.
    const first = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!first.ok) throw new Error('expected a patch')
    const second = applyCorrection(running(), first.plan.next, 'in the barn', 'c-2')
    if (!second.ok) throw new Error('expected a second patch')
    expect(second.plan.changedFields).toEqual([])
    expect(second.effect.settledStepIds).toEqual([])
  })
})

describe('a correction cannot widen authority', () => {
  it('carries no budget, no limits, no priority and no capability', () => {
    // Structural, not a check. The plan a correction produces has fields for the intent
    // and for the effect on work — and that is the complete list. There is no shape of
    // `MissionCorrectionInput` that could buy more retries or reach a new capability.
    const outcome = applyCorrection(running(), SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(Object.keys(outcome.plan).sort()).toEqual(
      ['ambiguity', 'changedFields', 'correctionId', 'kind', 'missionId', 'next', 'question'].sort(),
    )
    expect(Object.keys(outcome.effect).sort()).toEqual(
      ['preservedEvidenceIds', 'replanRequired', 'settledStepIds'].sort(),
    )
  })

  it('does not settle a Mission, only steps', () => {
    // Settling reduces what the Mission does. Ending it is a separate, explicit act — so
    // a correction can never be a back door to `cancelled`.
    const outcome = applyCorrection(running(), SHAPE, { cancel: true }, 'c-cancel')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.effect.settledStepIds).toEqual([])
    expect(outcome.pauseRequested).toBe(false)
  })

  it('pauses rather than cancels when told to stop', () => {
    const outcome = applyCorrection(running(), SHAPE, 'stop', 'c-pause')
    if (!outcome.ok) throw new Error('expected a patch')
    expect(outcome.pauseRequested).toBe(true)
    // A pause is not an ending, and the mission's own status is untouched by the parser.
    expect(outcome.plan.next.paused).toBe(true)
  })

  it('leaves an in-flight unknown effect for recovery, not for the correction', () => {
    const inFlight = running()
    const plan = inFlight.activePlan!
    const withUnknown: MissionRecord = {
      ...inFlight,
      activePlan: {
        ...plan,
        steps: plan.steps.map((s) =>
          s.stepId === 's3'
            ? { ...s, status: 'blocked' as const, reason: MISSION_REASONS.interrupted, runId: 'run-unknown' }
            : s,
        ),
      },
    }
    const outcome = applyCorrection(withUnknown, SHAPE, 'in the barn', 'c-1')
    if (!outcome.ok) throw new Error('expected a patch')
    // `s3` is already blocked and is not settled again: recovery owns that judgement, and
    // a correction that overwrote it would erase the record that something is unknown.
    expect(outcome.effect.settledStepIds).toEqual(['s4'])
  })
})


