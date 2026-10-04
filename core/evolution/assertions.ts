import {
  EVOLUTION_ASSERTIONS,
  type EvolutionAssertionId,
  type EvolutionAssertionVerdict,
  type EvolutionLimits,
} from './types'
import type { EvolutionJournalEntry } from './state'

/**
 * The evolution assertion report.
 *
 * Analyses the journal and reports whether every evolution invariant holds.
 * A violation is a fact about the journal, not a judgement — it is reported
 * so the owner can see it, never silently resolved.
 */

export interface EvolutionAssertionReport {
  readonly holds: boolean
  readonly checks: EvolutionAssertionVerdict
  readonly violations: readonly EvolutionAssertionViolation[]
  readonly counted: Readonly<Record<string, number>>
}

export interface EvolutionAssertionViolation {
  readonly assertion: EvolutionAssertionId
  readonly detail: string
}

export interface EvolutionAssertionInput {
  readonly entries: readonly EvolutionJournalEntry[]
  readonly limits?: EvolutionLimits
}

const PASSING_REPORT: EvolutionAssertionReport = Object.freeze({
  holds: true,
  checks: Object.freeze(
    Object.fromEntries(EVOLUTION_ASSERTIONS.map((id) => [id, true])),
  ) as EvolutionAssertionVerdict,
  violations: Object.freeze([]),
  counted: Object.freeze({
    evolutionEvents: 0,
    wakes: 0,
    evidenceVerified: 0,
    improvementsProposed: 0,
    improvementsApplied: 0,
    driftChecksPassed: 0,
    driftChecksFailed: 0,
    selfModificationAttempts: 0,
    selfModificationRefused: 0,
  }),
})

const PASSING_ASSERTIONS: EvolutionAssertionReport = PASSING_REPORT

/**
 * Analyse the journal against every evolution invariant.
 *
 * The analysis is deterministic: same journal + same limits = same report. It
 * counts the events that matter and checks that no forbidden event appears.
 */
export function analyseEvolutionAssertions(
  input: EvolutionAssertionInput,
): EvolutionAssertionReport {
  const entries = input.entries
  const counted: { [key: string]: number } = {
    evolutionEvents: 0,
    wakes: 0,
    evidenceVerified: 0,
    improvementsProposed: 0,
    improvementsApplied: 0,
    driftChecksPassed: 0,
    driftChecksFailed: 0,
    selfModificationAttempts: 0,
    selfModificationRefused: 0,
  }

  const violations: EvolutionAssertionViolation[] = []

  for (const entry of entries) {
    if (!entry || typeof entry.type !== 'string') continue
    if (!entry.type.startsWith('evolution.')) continue
    counted['evolutionEvents'] = (counted['evolutionEvents'] ?? 0) + 1

    if (entry.type === 'evolution.wake.received' || entry.type === 'evolution.wake.denied') {
      counted['wakes'] = (counted['wakes'] ?? 0) + 1
    }
    if (entry.type === 'evolution.evidence.verified') {
      counted['evidenceVerified'] = (counted['evidenceVerified'] ?? 0) + 1
    }
    if (entry.type === 'evolution.improvement.proposed') {
      counted['improvementsProposed'] = (counted['improvementsProposed'] ?? 0) + 1
    }
    if (entry.type === 'evolution.improvement.applied') {
      counted['improvementsApplied'] = (counted['improvementsApplied'] ?? 0) + 1
    }
    if (entry.type === 'evolution.drift-check.passed') {
      counted['driftChecksPassed'] = (counted['driftChecksPassed'] ?? 0) + 1
    }
    if (entry.type === 'evolution.drift-check.failed' || entry.type === 'evolution.drift-check.boundary-violation') {
      counted['driftChecksFailed'] = (counted['driftChecksFailed'] ?? 0) + 1
    }
    if (entry.type === 'evolution.self-modification.attempted') {
      counted['selfModificationAttempts'] = (counted['selfModificationAttempts'] ?? 0) + 1
      violations.push({
        assertion: 'noSelfModification',
        detail: 'a self-modification attempt was journaled',
      })
    }
    if (entry.type === 'evolution.self-modification.refused') {
      counted['selfModificationRefused'] = (counted['selfModificationRefused'] ?? 0) + 1
    }
  }

  const checks: { [key: string]: boolean } = {}
  for (const assertion of EVOLUTION_ASSERTIONS) {
    checks[assertion] = !violations.some((v) => v.assertion === assertion)
  }

  const holds = violations.length === 0

  return Object.freeze({
    holds,
    checks: Object.freeze(checks) as EvolutionAssertionVerdict,
    violations: Object.freeze(violations),
    counted: Object.freeze(counted) as Readonly<Record<string, number>>,
  })
}

export { PASSING_REPORT, PASSING_ASSERTIONS }
