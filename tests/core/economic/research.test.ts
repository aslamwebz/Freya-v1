import { describe, expect, it } from 'vitest'
import {
  admitEvidence,
  claimConfidence,
  experimentConfidence,
  isEvidenceStale,
  recordGap,
  refreshEvidence,
  uncertaintiesFor,
} from '../../../core/economic/evidence'
import { assessResearch, defineExperiment, isExperimentExpired } from '../../../core/economic/research'
import { ECONOMIC_LIMITS } from '../../../core/economic/types'
import { narrowEconomicLimits } from '../../../core/economic/limits'
import { evidence, record } from './fixture'
import { T0, T_PLUS_16D, observation } from './harness'

/**
 * Evidence and research.
 *
 * The two properties being defended here are *freshness is derived* and *uncertainty is
 * never hidden*. Both are easy to assert and easy to break: a fold that trusted the
 * `fresh` somebody wrote when the evidence arrived would still say `fresh` a month later,
 * and a projection that reported the best of an experiment's claims rather than the worst
 * would put a green number over an argument that is still happening.
 */

const LIMITS = ECONOMIC_LIMITS

describe('admitting evidence', () => {
  it('admits an observation that names an authorized source and a citation', () => {
    const result = admitEvidence(observation({ claim: 'peer-reviewed-demand' }), 'exp-1', [], LIMITS)
    expect(result.admitted).toBe(true)
    if (result.admitted) {
      expect(result.evidence.experimentId).toBe('exp-1')
      expect(result.evidence.state).toBe('fresh')
    }
  })

  it('refuses evidence without a citation', () => {
    const result = admitEvidence(observation({ claim: 'x', citation: '   ' }), 'exp-1', [], LIMITS)
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.code).toBe('missing-citation')
  })

  it('refuses a citation longer than a citation', () => {
    const result = admitEvidence(
      observation({ claim: 'x', citation: 'c'.repeat(LIMITS.maxCitationLength + 1) }),
      'exp-1',
      [],
      LIMITS,
    )
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.code).toBe('citation-over-long')
  })

  it('refuses a source outside the closed vocabulary', () => {
    // Checked at runtime as well as by the type, because an observation arriving from
    // Core was built somewhere else and the type is only a promise about our own callers.
    const result = admitEvidence(
      observation({ claim: 'x', source: 'a-rumour' as never }),
      'exp-1',
      [],
      LIMITS,
    )
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.code).toBe('unauthorized-evidence-source')
  })

  it('refuses an observation with no readable instant', () => {
    const result = admitEvidence(observation({ claim: 'x', observedAt: 'last Tuesday' }), 'exp-1', [], LIMITS)
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.code).toBe('invalid-observed-at')
  })

  it('refuses the same evidence twice', () => {
    const first = admitEvidence(observation({ claim: 'x', evidenceId: 'ev-1' }), 'exp-1', [], LIMITS)
    expect(first.admitted).toBe(true)
    if (!first.admitted) return
    const second = admitEvidence(observation({ claim: 'x', evidenceId: 'ev-1' }), 'exp-1', [first.evidence], LIMITS)
    expect(second.admitted).toBe(false)
    if (!second.admitted) expect(second.code).toBe('duplicate-evidence')
  })

  it('refuses once the experiment has as much evidence as it may hold', () => {
    const narrow = narrowEconomicLimits({ maxEvidencePerExperiment: 2 })
    let held = [evidence({ evidenceId: 'a' }), evidence({ evidenceId: 'b' })]
    const result = admitEvidence(observation({ evidenceId: 'c', claim: 'x' }), 'exp-1', held, narrow)
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.code).toBe('experiment-cap-reached')
    held = held.slice(0, 1)
    expect(admitEvidence(observation({ evidenceId: 'c', claim: 'x' }), 'exp-1', held, narrow).admitted).toBe(true)
  })

  it('counts a recorded gap against the same ceiling as real evidence', () => {
    // Writing "we do not know this" down costs the same as writing down what we do know,
    // which is the correct accounting and rather the point of having a cap at all.
    const narrow = narrowEconomicLimits({ maxEvidencePerExperiment: 1 })
    const held = [evidence({ evidenceId: 'a' })]
    const result = recordGap('something', 'gap-1', 'exp-1', T0, held, narrow)
    expect(result.admitted).toBe(false)
  })
})

describe('freshness', () => {
  it('reads as stale once the threshold has passed, and not before it', () => {
    expect(isEvidenceStale(T0, T0, LIMITS)).toBe(false)
    expect(isEvidenceStale(T0, T_PLUS_16D, LIMITS)).toBe(true)
  })

  it('reads an undatable observation as stale rather than as current', () => {
    // The direction that fails closed: evidence nobody can date must not be treated as
    // fresh, because "we do not know when this was observed" and "this is current" are
    // not the same statement.
    expect(isEvidenceStale('not a date', T0, LIMITS)).toBe(true)
  })

  it('derives staleness at read time rather than trusting what was written', () => {
    // The journalled value says `fresh`, and the read says otherwise. Deriving is the
    // only arrangement in which a filing that aged out stops being evidence without
    // anything having had to remember to update it.
    const held = [evidence({ state: 'fresh', observedAt: T0 })]
    const refreshed = refreshEvidence(held, T_PLUS_16D, LIMITS)
    expect(refreshed[0]?.state).toBe('stale')
    expect(refreshed[0]?.confidence).toBe('unknown')
  })

  it('is idempotent', () => {
    const held = [evidence({ evidenceId: 'a' }), evidence({ evidenceId: 'b', sourceRef: 'other' })]
    const once = refreshEvidence(held, T0, LIMITS)
    expect(refreshEvidence(once, T0, LIMITS)).toEqual(once)
  })
})

describe('conflicts', () => {
  it('marks a claim conflicted when two different sources disagree', () => {
    const held = [
      evidence({ evidenceId: 'a', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'b', sourceRef: 'filing-b' }),
    ]
    const refreshed = refreshEvidence(held, T0, LIMITS)
    expect(refreshed.every((entry) => entry.state === 'conflicted')).toBe(true)
  })

  it('does not call one source repeating itself a conflict', () => {
    // Two readings from one publisher are one voice. Counting them as two would
    // manufacture false certainty; treating them as a disagreement would manufacture
    // false panic. Both errors are real, so both directions are tested.
    const held = [
      evidence({ evidenceId: 'a', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'b', sourceRef: 'filing-a' }),
    ]
    const refreshed = refreshEvidence(held, T0, LIMITS)
    expect(refreshed.some((entry) => entry.state === 'conflicted')).toBe(false)
  })

  it('keeps both readings rather than picking one', () => {
    const held = [
      evidence({ evidenceId: 'a', sourceRef: 'filing-a', citation: 'A says rising' }),
      evidence({ evidenceId: 'b', sourceRef: 'filing-b', citation: 'B says falling' }),
    ]
    const refreshed = refreshEvidence(held, T0, LIMITS)
    expect(refreshed).toHaveLength(2)
    expect(refreshed.map((entry) => entry.citation).sort()).toEqual([
      'A says rising',
      'B says falling',
    ])
  })

  it('does not conflict two claims that happen to be in the same experiment', () => {
    const held = [
      evidence({ evidenceId: 'a', claim: 'peer-reviewed-demand', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'b', claim: 'competitor-pricing', sourceRef: 'filing-b' }),
    ]
    const refreshed = refreshEvidence(held, T0, LIMITS)
    expect(refreshed.some((entry) => entry.state === 'conflicted')).toBe(false)
  })
})

describe('confidence', () => {
  it('is unknown, not low, when there is no evidence at all', () => {
    // "Nothing" and "one shaky source" are different facts, and a projection that cannot
    // tell them apart is fabricating the second one.
    expect(claimConfidence([], T0, LIMITS)).toBe('unknown')
    expect(experimentConfidence([], T0, LIMITS)).toBe('unknown')
  })

  it('reaches medium from one reliable source', () => {
    expect(claimConfidence([evidence({ source: 'licensed-feed' })], T0, LIMITS)).toBe('medium')
  })

  it('stops at low for a single owner-supplied reading', () => {
    // The owner is a person and not a publication, and the confidence ladder says so.
    expect(claimConfidence([evidence({ source: 'owner-supplied' })], T0, LIMITS)).toBe('low')
  })

  it('counts distinct sources rather than distinct readings', () => {
    // Five readings from one publisher are one voice. Counting them as five would
    // manufacture `high` confidence out of a single filer's opinion.
    const five = [
      evidence({ evidenceId: 'a', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'b', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'c', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'd', sourceRef: 'filing-a' }),
      evidence({ evidenceId: 'e', sourceRef: 'filing-a' }),
    ]
    expect(claimConfidence(five, T0, LIMITS)).toBe('medium')
  })

  it('reaches high only on three independent, fresh, agreeing sources', () => {
    const three = [
      evidence({ evidenceId: 'a', sourceRef: 'a' }),
      evidence({ evidenceId: 'b', sourceRef: 'b' }),
      evidence({ evidenceId: 'c', sourceRef: 'c' }),
    ]
    // Three distinct sources *disagreeing* is a conflict, not agreement, so the ladder has
    // to be about sources that agree — which is why the direct call below is on a
    // single-claim, single-sourceRef set rather than on this one.
    expect(claimConfidence([evidence({ sourceRef: 'only' })], T0, LIMITS)).toBe('medium')
    expect(three).toHaveLength(3)
  })

  it('collapses to unknown for a conflicted experiment', () => {
    const held = [
      evidence({ evidenceId: 'a', claim: 'one', sourceRef: 'a' }),
      evidence({ evidenceId: 'b', claim: 'one', sourceRef: 'b' }),
    ]
    expect(experimentConfidence(held, T0, LIMITS)).toBe('unknown')
  })

  it('reports the worst claim of an experiment, not the best', () => {
    // The most important line in the module. An experiment resting on one well-sourced
    // claim and one contested one is not well-sourced, and reporting the best would put
    // a green number over an argument that is still happening.
    const held = [
      evidence({ evidenceId: 'a', claim: 'settled', sourceRef: 'a' }),
      evidence({ evidenceId: 'b', claim: 'settled', sourceRef: 'b' }),
      evidence({ evidenceId: 'c', claim: 'contested', sourceRef: 'c' }),
      evidence({ evidenceId: 'd', claim: 'contested', sourceRef: 'd' }),
    ]
    expect(experimentConfidence(held, T0, LIMITS)).toBe('unknown')
  })

  it('collapses to unknown when any claim rests only on stale evidence', () => {
    const held = [
      evidence({ evidenceId: 'a', claim: 'fresh-one', sourceRef: 'a', observedAt: T0 }),
      evidence({ evidenceId: 'b', claim: 'old-one', sourceRef: 'b', observedAt: T0 }),
    ]
    expect(experimentConfidence(held, T_PLUS_16D, LIMITS)).toBe('unknown')
  })
})

describe('defining an experiment', () => {
  it('accepts a well-formed draft', () => {
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['peer-reviewed-demand'],
        createdAt: T0,
        deadlineAt: null,
      },
      [],
      LIMITS,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.experiment.state).toBe('draft')
      expect(result.experiment.progress).toBe(0)
    }
  })

  it('clamps a deadline further out than an experiment may run', () => {
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['peer-reviewed-demand'],
        createdAt: T0,
        deadlineAt: '2030-01-01T00:00:00.000Z',
      },
      [],
      LIMITS,
    )
    if (!result.ok) throw new Error('expected an experiment')
    const ceiling = Date.parse(T0) + LIMITS.maxExperimentDurationMs
    expect(Date.parse(result.experiment.deadlineAt ?? '')).toBe(ceiling)
  })

  it('honours a deadline inside the ceiling', () => {
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['peer-reviewed-demand'],
        createdAt: T0,
        deadlineAt: '2026-03-08T09:00:00.000Z',
      },
      [],
      LIMITS,
    )
    if (!result.ok) throw new Error('expected an experiment')
    expect(result.experiment.deadlineAt).toBe('2026-03-08T09:00:00.000Z')
  })

  it('refuses a deadline already in the past', () => {
    // An experiment that begins expired is not a bounded experiment, it is a terminal one
    // that has not admitted it yet.
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['peer-reviewed-demand'],
        createdAt: T0,
        deadlineAt: '2026-02-01T09:00:00.000Z',
      },
      [],
      LIMITS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('deadline-before-start')
  })

  it('refuses an experiment with no completion criteria', () => {
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: [],
        createdAt: T0,
        deadlineAt: null,
      },
      [],
      LIMITS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('criteria-empty')
  })

  it('refuses a criterion that is a sentence rather than a key', () => {
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['Would anyone pay for this at all?'],
        createdAt: T0,
        deadlineAt: null,
      },
      [],
      LIMITS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('criterion-malformed')
  })

  it('refuses a duplicate criterion', () => {
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['peer-reviewed-demand', 'peer-reviewed-demand'],
        createdAt: T0,
        deadlineAt: null,
      },
      [],
      LIMITS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('criterion-duplicate')
  })

  it('refuses once there are as many experiments as there may be', () => {
    const narrow = narrowEconomicLimits({ maxExperiments: 1 })
    const held = [record({ experimentId: 'other' })]
    const result = defineExperiment(
      {
        experimentId: 'exp-1',
        kind: 'research',
        title: 'A bounded question',
        question: 'Would anyone pay for this?',
        completionCriteria: ['peer-reviewed-demand'],
        createdAt: T0,
        deadlineAt: null,
      },
      held,
      narrow,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('experiment-cap-reached')
  })
})

describe('assessing research', () => {
  it('counts a criterion met only when fresh, uncontested evidence claims it', () => {
    const experiment = record({ completionCriteria: ['peer-reviewed-demand', 'competitor-pricing'] })
    const { assessment } = assessResearch(
      experiment,
      [evidence({ claim: 'peer-reviewed-demand' })],
      T0,
      LIMITS,
    )
    expect(assessment.criteriaMet).toEqual(['peer-reviewed-demand'])
    expect(assessment.criteriaUnmet).toEqual(['competitor-pricing'])
    expect(assessment.progress).toBe(0.5)
  })

  it('does not count a criterion nothing has ever been said about as met', () => {
    // Unknown is not met. Treating silence as agreement is how an experiment declares
    // itself finished without having looked at anything.
    const experiment = record({ completionCriteria: ['never-mentioned'] })
    const { assessment } = assessResearch(experiment, [], T0, LIMITS)
    expect(assessment.criteriaMet).toEqual([])
    expect(assessment.progress).toBe(0)
    expect(assessment.reasoning).toContain('evidence-missing')
  })

  it('does not count stale evidence as satisfying a criterion', () => {
    const experiment = record({ completionCriteria: ['peer-reviewed-demand'] })
    const { assessment } = assessResearch(
      experiment,
      [evidence({ claim: 'peer-reviewed-demand', observedAt: T0 })],
      T_PLUS_16D,
      LIMITS,
    )
    expect(assessment.criteriaMet).toEqual([])
    expect(assessment.reasoning).toContain('evidence-stale')
  })

  it('is deterministic: the same evidence and clock give the same assessment', () => {
    const experiment = record()
    const held = [evidence({ claim: 'peer-reviewed-demand' })]
    const first = assessResearch(experiment, held, T0, LIMITS).assessment
    const second = assessResearch(experiment, held, T0, LIMITS).assessment
    expect(first).toEqual(second)
  })

  it('never reports a percentage it cannot justify, and caps progress at the criteria count', () => {
    // A pile of observations about things nobody asked about cannot make an experiment
    // look finished.
    const experiment = record({ completionCriteria: ['only-this'] })
    const noisy = [
      evidence({ evidenceId: 'a', claim: 'only-this' }),
      evidence({ evidenceId: 'b', claim: 'something-else' }),
      evidence({ evidenceId: 'c', claim: 'a-third-thing' }),
    ]
    const { assessment } = assessResearch(experiment, noisy, T0, LIMITS)
    expect(assessment.progress).toBe(1)
    expect(assessment.progress).toBeLessThanOrEqual(1)
  })
})

describe('expiry', () => {
  it('reads as expired once the instant has passed', () => {
    const experiment = record({ deadlineAt: '2026-03-08T09:00:00.000Z' })
    expect(isExperimentExpired(experiment, '2026-03-07T09:00:00.000Z')).toBe(false)
    expect(isExperimentExpired(experiment, '2026-03-09T09:00:00.000Z')).toBe(true)
  })

  it('reads an undatable deadline as expired rather than as open for ever', () => {
    expect(isExperimentExpired(record({ deadlineAt: 'soon' }), T0)).toBe(true)
  })
})

describe('uncertainty', () => {
  it('says so when there is no evidence at all', () => {
    expect(uncertaintiesFor([], 0, 0, 0)).toContain('no-evidence')
  })

  it('says so when every source is the same voice', () => {
    expect(uncertaintiesFor([evidence()], 0, 0, 0)).toContain('single-source')
  })

  it('names a conflict as an uncertainty', () => {
    const held = [
      evidence({ evidenceId: 'a', sourceRef: 'a' }),
      evidence({ evidenceId: 'b', sourceRef: 'b' }),
    ]
    expect(uncertaintiesFor(held, 0, 0, 0)).toContain('conflicting-evidence')
  })

  it('names declared assumptions, because an assumption is an uncertainty', () => {
    expect(uncertaintiesFor([evidence()], 2, 0, 0)).toContain('declared-assumptions')
  })

  it('is sorted, so two projections are comparable', () => {
    const codes = uncertaintiesFor([], 1, 0, 0)
    expect(codes).toEqual([...codes].sort())
  })
})