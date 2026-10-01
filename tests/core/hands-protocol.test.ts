// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as handsProtocol from '../../core/protocol/hands'
import {
  ABSENT_HANDS_STATUS_PROJECTION,
  HANDS_ACTION_PHASES,
  HANDS_ACTION_PHASE_REASONS,
  HANDS_ACTION_VIEW_KEY_NAMES,
  HANDS_STATUS_PROJECTION_KEY_NAMES,
  NO_HANDS_DOMAIN_REASON,
  UNKNOWN_VERIFIER_NAME,
  carriesVerifierEvidence,
  handsPhaseOf,
  hasExactHandsActionViewKeys,
  hasExactHandsStatusProjectionKeys,
  isHandsActionPhase,
  isHandsActionStatus,
  isHandsObservationKind,
  isHandsRefusalCode,
  isHandsVerificationStatus,
  projectHandsStatus,
  type HandsActionPhase,
  type HandsActionView,
  type HandsStatusCounts,
  type HandsStatusProjection,
  type HandsSource,
  type HandsUnverifiedActionView,
} from '../../core/protocol/hands'
import type {
  HandsActionResult,
  HandsObservationRecord,
  HandsVerificationResult,
} from '../../core/hands/contract'
import {
  HANDS_ACTION_STATUSES,
  HANDS_ACTION_TERMINAL_STATUSES,
  HANDS_OBSERVATION_KINDS,
  HANDS_REFUSAL_CODES,
  HANDS_REFUSAL_REASONS,
  HANDS_VERIFICATION_STATUSES,
} from '../../core/hands/types'
import {
  initialHandsState,
  recordActionResult,
  recordObservation,
  recordRefusal,
  recordVerificationResult,
  type HandsState,
} from '../../core/hands/state'

/**
 * The Hands protocol, on its own.
 *
 * Core's Hands engine is a later phase and this issue does not wire one, so this
 * suite cannot test a running Core's hands mirror — the seam is deliberately not
 * connected, and pretending otherwise would be guessing at internals. What it
 * *can* pin down is the vocabulary itself, and the claims this file is on the
 * hook for:
 *
 *  1. The runtime surface is reads and stated absences. Nothing in it can be
 *     submitted, executed or instructed, and there is no command in the file for a
 *     submission to arrive on.
 *  2. The absent projection is absent — `unavailable`, frozen all the way down,
 *     and never a `ready` frame with invented zeroes dressed as a report. "There
 *     are no Hands" and "Hands are idle" stay two different sentences.
 *  3. The phase vocabulary is closed, every value in it is reachable from state,
 *     and the words that would let a surface overclaim are absent: no
 *     `completed`, no `success`, no `ok`, and no per-action `idle`.
 *  4. **An action result, an observation and a verification result stay three
 *     separately represented things**, and `phase: 'verified'` cannot be written
 *     without handing over the verifier evidence that established it. The union
 *     makes most of it unrepresentable and `tsc` checks the rest.
 *  5. Exact-key validation holds the line for a payload arriving from outside:
 *     the declared key set and not one field more.
 *  6. The `HandsSource` port is readable and nothing else, and — stated as a fact
 *     about this lane rather than a promise — nothing in this repository plugs
 *     anything into it.
 */

const T0 = '2026-10-01T09:00:00.000Z'
const T1 = '2026-10-01T09:00:01.000Z'
const T2 = '2026-10-01T09:00:02.000Z'
const BUILD = '2026-10-01T09:00:03.000Z'

/* --------------------------------------------------------------- fixtures */

function action(over: Partial<HandsActionResult> = {}): HandsActionResult {
  return {
    actionId: 'action-1',
    status: 'running',
    startedAt: T0,
    settledAt: null,
    durationMs: null,
    reason: null,
    observationIds: [],
    ...over,
  }
}

function observation(over: Partial<HandsObservationRecord> = {}): HandsObservationRecord {
  return {
    observationId: 'obs-1',
    actionId: 'action-1',
    kind: 'result',
    summary: 'the page reported a title',
    data: { body: 'private page content that must never cross' },
    recordedAt: T1,
    ...over,
  }
}

function verification(over: Partial<HandsVerificationResult> = {}): HandsVerificationResult {
  return {
    verificationId: 'ver-1',
    actionId: 'action-1',
    status: 'passed',
    reason: 'the title matched what was asked for',
    verdictAt: T2,
    ...over,
  }
}

/**
 * Settle an action, which #35's insert-only fold cannot do on its own.
 *
 * `recordActionResult` refuses to rewrite an existing record and
 * `recordObservation` refuses to touch a terminal one, so the combination an
 * engine produces — observations while running, a terminal status afterwards — has
 * no reducer behind it yet. Transitions belong to the engine phase, not to this
 * one; the derivation under test only reads state, so the tests build the states
 * they need directly and say so here rather than pretending a fold exists.
 */
function settle(state: HandsState, actionId: string, result: HandsActionResult): HandsState {
  const actions = new Map(state.actions)
  actions.set(actionId, result)
  return { ...state, actions }
}

/** A running action carrying one observation: partial evidence, still in flight. */
function runningWithEvidence(): HandsState {
  return recordObservation(recordActionResult(initialHandsState(), action()), observation())
}

/** A settled action with evidence and no verdict — the `observed` case. */
function settledWithEvidence(): HandsState {
  return settle(runningWithEvidence(), 'action-1', action({
    status: 'completed',
    settledAt: T2,
    durationMs: 2_000,
    observationIds: ['obs-1'],
  }))
}

/** A settled action a verifier passed — the `verified` case. */
function verified(): HandsState {
  return recordVerificationResult(settledWithEvidence(), verification())
}

/** A refusal and nothing else — the `refused` case. */
function refused(): HandsState {
  return recordRefusal(initialHandsState(), {
    actionId: 'action-1',
    code: 'capability_unauthorized',
    reason: HANDS_REFUSAL_REASONS.capability_unauthorized,
    capabilityId: 'browser.click',
    refusedAt: T0,
  })
}

function onlyAction(state: HandsState): HandsActionView {
  const actions = projectHandsStatus(state, BUILD).actions
  expect(actions).toHaveLength(1)
  return actions[0]!
}

/** The counts key a phase reports under, so the phases can be summed without a cast. */
const COUNT_KEY: Record<HandsActionPhase, keyof HandsStatusCounts> = {
  running: 'running',
  observed: 'observed',
  settled: 'settled',
  verified: 'verified',
  refused: 'refused',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timedOut',
}

/* ------------------------------------------------------- source inspection */

/**
 * The protocol's own source, with its comments stripped.
 *
 * The file's argument for having no verbs is written in its prose, so a grep over
 * the raw text would match the sentences that *promise* the absence. Reading the
 * code the way a reviewer's eye does — skipping the comments — is what makes the
 * claim checkable.
 */
function strippedSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')
}

/** The `HandsSource` declaration on its own: header line through its closing brace. */
function seamSource(): string {
  const lines = strippedSource('../../core/protocol/hands.ts').split('\n')
  const start = lines.findIndex((line) => line.startsWith('export interface HandsSource'))
  const end = lines.findIndex((line, index) => index > start && line === '}')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

/* ------------------------------------------------------------------- tests */

describe('the protocol exposes a report and no verbs', () => {
  it('has a runtime surface of reads, absences and five functions', () => {
    // Everything else in the file is a type, which is to say a shape, which is to
    // say nothing a caller can *do*. Seventeen names, and all of them accounted
    // for: two closed tables, two stated absences, one fallback sentence, two key
    // lists, five guards over the contract's own words, and five functions — which
    // are `project`, `phase`, `carry` and two `hasExact`, none of which takes an
    // instruction or returns a handle.
    expect(Object.keys(handsProtocol).sort()).toEqual([
      'ABSENT_HANDS_STATUS_PROJECTION',
      'HANDS_ACTION_PHASES',
      'HANDS_ACTION_PHASE_REASONS',
      'HANDS_ACTION_VIEW_KEY_NAMES',
      'HANDS_STATUS_PROJECTION_KEY_NAMES',
      'NO_HANDS_DOMAIN_REASON',
      'UNKNOWN_VERIFIER_NAME',
      'carriesVerifierEvidence',
      'handsPhaseOf',
      'hasExactHandsActionViewKeys',
      'hasExactHandsStatusProjectionKeys',
      'isHandsActionPhase',
      'isHandsActionStatus',
      'isHandsObservationKind',
      'isHandsRefusalCode',
      'isHandsVerificationStatus',
      'projectHandsStatus',
    ])
  })

  it('names no mutating verb anywhere in its runtime surface', () => {
    for (const name of Object.keys(handsProtocol)) {
      expect(name.toLowerCase()).not.toMatch(
        /submit|execute|dispatch|perform|create|write|assign|grant|revoke|capture|set|invoke|send|run/,
      )
    }
  })

  it('declares no mutating verb in its code, and no command to arrive on', () => {
    // The stronger version of the claim above: read the file with the comments
    // stripped and there is nowhere for a submission to be declared, no channel to
    // arrive on, and no I/O to do it with. #14 shipped a *read* command for
    // Workforce and deliberately shipped none for Context; Hands is Context's case,
    // for the same reason.
    const code = strippedSource('../../core/protocol/hands.ts')
    expect(code).not.toMatch(/submit|execute|dispatch|perform|invoke\(/)
    expect(code).not.toMatch(/CoreCommandName|ipc|electron|renderer|require\(|node:/)
    // One dependency, the Hands domain itself, for the contract's own vocabulary.
    expect(code.match(/^import /gm)).toHaveLength(1)
  })

  it('leaves core/index.ts alone, because this seam is not wired', () => {
    // Stated as a fact about the repository rather than a promise: Core has no
    // `handsSource` option and no `hands()` mirror, so nothing in this lane quietly
    // granted a window a Hands read by way of the assembly it did not touch.
    const core = readFileSync(fileURLToPath(new URL('../../core/index.ts', import.meta.url)), 'utf8')
    expect(core).not.toMatch(/handsSource|onHands|HandsStatusProjection|HandsSource/)
  })

  it('makes no model call, reads no clock and routes no device', () => {
    // Every function in the file is a pure fold over a plain object graph handed to
    // it: no provider, no transport, no clock, and no capability kind with a route
    // attached. `observedAt` is the caller's for exactly this reason.
    const code = strippedSource('../../core/protocol/hands.ts')
    expect(code).not.toMatch(/provider|FakeModel|Date\.now|new Date|setTimeout|performance\./)
  })
})

describe('the absent projection is an absence, not a quiet frame', () => {
  it('is unavailable, with Core-not-reported words and no rows', () => {
    expect(ABSENT_HANDS_STATUS_PROJECTION.health).toBe('unavailable')
    expect(ABSENT_HANDS_STATUS_PROJECTION.reason).toBe('Core has not reported Hands yet')
    expect(ABSENT_HANDS_STATUS_PROJECTION.actions).toEqual([])
    expect(ABSENT_HANDS_STATUS_PROJECTION.sequence).toBe(0)
    expect(ABSENT_HANDS_STATUS_PROJECTION.observedAt).toBe('')
  })

  it('reports zeroes that mean "nobody counted", not "there is nothing"', () => {
    // The reason `health` is read first everywhere this is shown: every count here
    // is zero *because nothing is reporting*, and a surface that drew them as a
    // tally would be reporting Core's silence as a measurement of the hands.
    expect(ABSENT_HANDS_STATUS_PROJECTION.counts.actions).toBe(0)
    expect(ABSENT_HANDS_STATUS_PROJECTION.counts.verified).toBe(0)
    expect(ABSENT_HANDS_STATUS_PROJECTION.counts.running).toBe(0)
    expect(ABSENT_HANDS_STATUS_PROJECTION.counts).not.toHaveProperty('successCount')
  })

  it('is frozen all the way down, so a mirror cannot be edited into a lie', () => {
    expect(Object.isFrozen(ABSENT_HANDS_STATUS_PROJECTION)).toBe(true)
    expect(Object.isFrozen(ABSENT_HANDS_STATUS_PROJECTION.actions)).toBe(true)
    expect(Object.isFrozen(ABSENT_HANDS_STATUS_PROJECTION.counts)).toBe(true)
    // ESM is already strict mode: a window that received this object and tried to
    // redraw `unavailable` as `ready` gets a throw, not a silent lie.
    const mutable = ABSENT_HANDS_STATUS_PROJECTION as unknown as { health: string }
    expect(() => {
      mutable.health = 'ready'
    }).toThrow(TypeError)
  })

  it('keeps "no domain" a separate sentence from "not reported yet"', () => {
    // A window that opened before the first push and a Core that has no Hands
    // domain are different situations, and a surface matches on this constant
    // rather than paraphrasing it — so the two must never collapse into each other.
    expect(NO_HANDS_DOMAIN_REASON).toContain('no Hands domain')
    expect(NO_HANDS_DOMAIN_REASON).toContain('none is simulated')
    expect(NO_HANDS_DOMAIN_REASON).not.toBe(ABSENT_HANDS_STATUS_PROJECTION.reason)
  })

  it('reads idle while unavailable, which is why health comes first', () => {
    // `lane: 'idle'` on an absent projection is the least alarming value and it is
    // deliberately there: the protection is that nothing may read `lane` without
    // `health`, and the absent frame keeps both so a reader that does look at the
    // lane first still finds the alarming field right beside it.
    expect(ABSENT_HANDS_STATUS_PROJECTION.lane).toBe('idle')
    expect(ABSENT_HANDS_STATUS_PROJECTION.health).toBe('unavailable')
  })
})

describe('the phase vocabulary is closed, complete, and missing the flattering words', () => {
  it('has exactly eight phases, each with a sentence a person can read', () => {
    expect(HANDS_ACTION_PHASES).toEqual([
      'running',
      'observed',
      'settled',
      'verified',
      'refused',
      'failed',
      'cancelled',
      'timed_out',
    ])
    expect(Object.keys(HANDS_ACTION_PHASE_REASONS).sort()).toEqual([...HANDS_ACTION_PHASES].sort())
    for (const phase of HANDS_ACTION_PHASES) {
      expect(HANDS_ACTION_PHASE_REASONS[phase].length).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(HANDS_ACTION_PHASE_REASONS)).toBe(true)
  })

  it('has no word a surface could read as "it worked"', () => {
    // `completed` is not a claim that anything worked, and `success`/`ok`/`done`
    // are claims only a verifier may make. All four are absent from the phase
    // table, from the reason table, and from the projection's own field names.
    for (const forbidden of ['completed', 'success', 'succeeded', 'ok', 'done']) {
      expect(HANDS_ACTION_PHASES as readonly string[]).not.toContain(forbidden)
      expect(Object.keys(HANDS_ACTION_PHASE_REASONS)).not.toContain(forbidden)
    }
    const projection = ABSENT_HANDS_STATUS_PROJECTION as unknown as Record<string, unknown>
    const counts = ABSENT_HANDS_STATUS_PROJECTION.counts as unknown as Record<string, unknown>
    for (const forbidden of ['successCount', 'completedCount', 'ok', 'verifiedActionIds']) {
      expect(projection).not.toHaveProperty(forbidden)
      expect(counts).not.toHaveProperty(forbidden)
    }
  })

  it('keeps idle a fact about the lane, not a phase of an action that never existed', () => {
    // An id with no state behind it is absent from the projection rather than
    // reported as idle, because a phantom "idle action" row is a row about
    // something that was never attempted.
    expect(HANDS_ACTION_PHASES as readonly string[]).not.toContain('idle')
    expect(handsPhaseOf(initialHandsState(), 'action-nobody-recorded')).toBeNull()
    const live = projectHandsStatus(initialHandsState(), BUILD)
    expect(live.actions).toEqual([])
    // And the lane says the honest thing when the domain is live and empty.
    expect(live.health).toBe('ready')
    expect(live.lane).toBe('idle')
  })

  it('covers every terminal action status the contract can reach', () => {
    // A vocabulary that could not express a state #35's lifecycle produces would
    // force a surface to redraw that state as something else. Each terminal status
    // therefore has a phase, and the one that deliberately does not — `completed` —
    // is folded into `observed` or `settled` rather than dropped.
    const phaseFor: Record<string, HandsActionPhase> = {
      completed: 'observed',
      failed: 'failed',
      cancelled: 'cancelled',
      timed_out: 'timed_out',
    }
    expect([...HANDS_ACTION_TERMINAL_STATUSES].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'timed_out',
    ])
    for (const status of HANDS_ACTION_TERMINAL_STATUSES) {
      expect(HANDS_ACTION_PHASES).toContain(phaseFor[status]!)
    }
    expect(HANDS_ACTION_STATUSES).toContain('running')
  })

  it('reports the contract’s own tables verbatim, and refuses a word Core cannot produce', () => {
    // A projection is only honest if the words it shows are the words Core uses,
    // so the statuses, kinds and codes come from the contract's closed tables
    // rather than from a copy written here.
    expect(HANDS_ACTION_STATUSES.filter(isHandsActionStatus)).toEqual([...HANDS_ACTION_STATUSES])
    expect(HANDS_OBSERVATION_KINDS.filter(isHandsObservationKind)).toEqual([...HANDS_OBSERVATION_KINDS])
    expect(HANDS_VERIFICATION_STATUSES.filter(isHandsVerificationStatus)).toEqual([
      ...HANDS_VERIFICATION_STATUSES,
    ])
    expect(HANDS_REFUSAL_CODES.filter(isHandsRefusalCode)).toEqual([...HANDS_REFUSAL_CODES])

    // The near misses are the interesting ones: `complete`/`completed` are not a
    // phase, `success` is not an observation kind, `verified` is not a
    // verification status, and `not_allowed` is not a refusal code.
    expect(isHandsActionPhase('verified')).toBe(true)
    expect(isHandsActionPhase('complete')).toBe(false)
    expect(isHandsActionPhase('completed')).toBe(false)
    expect(isHandsActionStatus('succeeded')).toBe(false)
    expect(isHandsObservationKind('success')).toBe(false)
    expect(isHandsVerificationStatus('verified')).toBe(false)
    expect(isHandsRefusalCode('not_allowed')).toBe(false)
    for (const guard of [
      isHandsActionPhase,
      isHandsActionStatus,
      isHandsObservationKind,
      isHandsVerificationStatus,
      isHandsRefusalCode,
    ]) {
      expect(guard(null)).toBe(false)
      expect(guard(undefined)).toBe(false)
      expect(guard(7)).toBe(false)
    }
  })
})

describe('an action result, an observation and a verification result stay three things', () => {
  it('gives an action row one key set, whatever phase it is in', () => {
    // Key sets are checked exactly, the way the Workforce lane checks its
    // payloads: a field is either reported or absent, and a new one has to be a
    // visible change to this file rather than a quiet widening of what a window
    // may hold. All three arms share the set, which is what lets one check exist.
    for (const state of [runningWithEvidence(), settledWithEvidence(), verified(), refused()]) {
      const row = onlyAction(state)
      expect(Object.keys(row).sort()).toEqual([
        'actionId',
        'durationMs',
        'observations',
        'phase',
        'refusal',
        'result',
        'settledAt',
        'startedAt',
        'verification',
      ])
      expect(hasExactHandsActionViewKeys(row)).toBe(true)
    }
  })

  it('reports what happened as a result, and carries no verdict inside it', () => {
    const row = onlyAction(settledWithEvidence())
    expect(Object.keys(row.result ?? {}).sort()).toEqual([
      'durationMs',
      'settledAt',
      'startedAt',
      'status',
    ])
    const result = row.result as unknown as Record<string, unknown>
    // `reason` is free text written by whatever attempted the action, and
    // `observationIds` is a second answer to a question the view already answers
    // with `observations`. Neither crosses: the honest summary of a failed
    // execution is its closed phase, not its prose.
    expect(result).not.toHaveProperty('reason')
    expect(result).not.toHaveProperty('observationIds')
    expect(result).not.toHaveProperty('verified')
    expect(result).not.toHaveProperty('verifier')
  })

  it('reports what came back without the evidence itself', () => {
    const row = onlyAction(settledWithEvidence())
    expect(row.observations).toHaveLength(1)
    const seen = row.observations[0] as unknown as Record<string, unknown>
    expect(Object.keys(seen).sort()).toEqual(['kind', 'observationId', 'recordedAt', 'summary'])
    // `data` exists for the verifier and stays behind Core. A standing copy of it in
    // every window that caches a projection is how evidence becomes ambient
    // content, and this fixture's data field is deliberately private page text.
    expect(seen).not.toHaveProperty('data')
    expect(JSON.stringify(row)).not.toContain('private page content')
  })

  it('reports the verdict separately, and only on a row that earned it', () => {
    const row = onlyAction(verified())
    expect(row.phase).toBe('verified')
    expect(Object.keys(row.verification ?? {}).sort()).toEqual([
      'reason',
      'status',
      'verdictAt',
      'verificationId',
      'verifier',
    ])
    // The verification is nested in the action that owns it, so it does not repeat
    // the parent id: a second copy is a second thing that could disagree.
    expect(row.verification).not.toHaveProperty('actionId')
    // And on every other phase the field is null, so there is no arrangement in
    // which a row reads as verified without saying which verifier said so.
    expect(onlyAction(settledWithEvidence()).verification).toBeNull()
    expect(onlyAction(settledWithEvidence()).refusal).toBeNull()
    expect(onlyAction(refused()).verification).toBeNull()
    expect(onlyAction(refused()).result).toBeNull()
  })

  it('says nothing about authority anywhere except inside a refusal', () => {
    // A window that could see which capability an action used could read it as a
    // standing permission. The only capability id in the vocabulary is the one a
    // refusal names, because naming it is the refusal's whole content.
    for (const state of [runningWithEvidence(), settledWithEvidence(), verified()]) {
      const row = onlyAction(state) as unknown as Record<string, unknown>
      for (const forbidden of [
        'capabilityId',
        'capabilityRef',
        'scope',
        'input',
        'authority',
        'grant',
        'principal',
        'owner',
        'trusted',
        'provenance',
      ]) {
        expect(row).not.toHaveProperty(forbidden)
      }
    }
    const refusal = onlyAction(refused()).refusal
    expect(Object.keys(refusal ?? {}).sort()).toEqual(['capabilityId', 'code', 'reason', 'refusedAt'])
    expect(refusal?.capabilityId).toBe('browser.click')
  })
})

describe('verified cannot exist without the evidence that produced it', () => {
  it('needs a passing verdict in state, not a flag a caller set', () => {
    // The whole acceptance criterion from the state's side: the only route to
    // `'verified'` is a verification result whose status is `passed`.
    expect(handsPhaseOf(settledWithEvidence(), 'action-1')).toBe('observed')
    expect(handsPhaseOf(verified(), 'action-1')).toBe('verified')
    // A verification that was merely requested is not a verdict.
    expect(
      handsPhaseOf(
        recordVerificationResult(
          settledWithEvidence(),
          verification({ status: 'requested', reason: null, verdictAt: null }),
        ),
        'action-1',
      ),
    ).toBe('observed')
    // And a verifier that said no is not a verdict in the other direction.
    expect(
      handsPhaseOf(
        recordVerificationResult(
          settledWithEvidence(),
          verification({ status: 'failed', reason: 'the title did not match' }),
        ),
        'action-1',
      ),
    ).toBe('observed')
  })

  it('drops the row rather than show it verified with nothing behind it', () => {
    // `verifiedActions` and the verification results are two fields of one state,
    // and a hand-built state could disagree. When they do the derivation reads the
    // *evidence* and omits the row: emitting `phase: 'verified'` with a null
    // verification is precisely the failure this file exists to make impossible, so
    // it is not degraded into an empty verdict — it is not emitted at all.
    const lying: HandsState = { ...initialHandsState(), verifiedActions: new Set(['action-1']) }
    expect(handsPhaseOf(lying, 'action-1')).toBe('verified')
    const projection = projectHandsStatus(lying, BUILD)
    expect(projection.actions).toEqual([])
    expect(projection.counts.verified).toBe(0)
    expect(projection.counts.actions).toBe(0)
  })

  it('names the verifier that ruled, and says so plainly when it did not', () => {
    const named = projectHandsStatus(verified(), BUILD, (id) => (id === 'ver-1' ? 'title-match' : null))
    expect(named.actions[0]?.verification?.verifier).toBe('title-match')

    // #35's verification result retains the verdict but not the verifier, so a
    // builder with no resolver still gets a true sentence rather than a blank
    // field. `verified` is never a word with nothing behind it.
    const anonymous = onlyAction(verified())
    expect(anonymous.verification?.verifier).toBe(UNKNOWN_VERIFIER_NAME)
    expect(UNKNOWN_VERIFIER_NAME).toContain('did not record')
    expect(anonymous.verification?.status).toBe('passed')
  })

  it('lets a verifier rule on a failed action, because failure can be the intent', () => {
    // "It failed" and "the intent was satisfied" are different facts, and a verifier
    // asked to break a page has been satisfied by a failure. Which is why `verified`
    // is read from the verification and never inferred from the action status.
    const broken = settle(runningWithEvidence(), 'action-1', action({
      status: 'failed',
      settledAt: T2,
      durationMs: 2_000,
      reason: 'the element was not found',
    }))
    expect(handsPhaseOf(broken, 'action-1')).toBe('failed')
    expect(handsPhaseOf(recordVerificationResult(broken, verification()), 'action-1')).toBe('verified')
    expect(onlyAction(recordVerificationResult(broken, verification())).result?.status).toBe('failed')
  })

  it('lets a refusal win over a verdict on the same id, because nothing ran', () => {
    // If state somehow carries both, the refusal is the fact: nothing was
    // attempted, so a verdict attached to the id could not be about the same thing.
    // A surface shows the refusal rather than a passing grade for an action that
    // never happened.
    const both: HandsState = { ...refused(), verifiedActions: new Set(['action-1']) }
    expect(handsPhaseOf(both, 'action-1')).toBe('refused')
    const row = onlyAction(both)
    expect(row.refusal?.code).toBe('capability_unauthorized')
    expect(row.verification).toBeNull()
    expect(row.observations).toEqual([])
  })

  it('answers the check a boundary would actually run', () => {
    // The union makes most of this unrepresentable inside the type system, but a
    // payload arriving from outside is untrusted, so `carriesVerifierEvidence` is
    // how a host asks whether a verified row really handed over a passing verdict
    // with a verifier named. It is deliberately narrow: it checks the shape of the
    // evidence, never that the evidence is true.
    expect(carriesVerifierEvidence(onlyAction(verified()))).toBe(true)
    expect(carriesVerifierEvidence(onlyAction(settledWithEvidence()))).toBe(false)
    expect(carriesVerifierEvidence(onlyAction(runningWithEvidence()))).toBe(false)
    expect(carriesVerifierEvidence(onlyAction(refused()))).toBe(false)
  })

  it('makes the guarantee a property of the type, checked by tsc', () => {
    // Runtime tests cannot prove a union is closed, so these lines are the real test
    // and `npm run typecheck` is what runs them. Narrowing on the phase is what
    // hands a caller the evidence...
    const row = onlyAction(verified())
    if (row.phase !== 'verified') throw new Error('a verified row narrowed to something else')
    expect(row.verification.verifier).not.toBe('')

    const open: HandsUnverifiedActionView = {
      actionId: 'action-1',
      phase: 'observed',
      startedAt: T0,
      settledAt: T2,
      durationMs: 2_000,
      result: { status: 'completed', startedAt: T0, settledAt: T2, durationMs: 2_000 },
      observations: [],
      verification: null,
      refusal: null,
    }
    expect(open.phase).toBe('observed')

    // ...and the arms that promise no verdict cannot be given one. If any of these
    // four errors ever stops being an error, `npm run typecheck` fails this suite.
    //
    // All four objects exist at runtime — which is exactly why the type is the only
    // thing standing between a caller and a lie — so the assertion below is only
    // that each fixture says the thing it is forbidden to say. `tsc` is what
    // refuses them.
    // @ts-expect-error a verified row must carry the verdict that verified it
    const forgedA: HandsActionView = { ...open, phase: 'verified', verification: null }
    // @ts-expect-error an unverified row cannot carry a verdict at all
    const forgedB: HandsUnverifiedActionView = { ...open, verification: { status: 'passed' } }
    // @ts-expect-error a refused row is not also a failed execution
    const forgedC: HandsActionView = { ...open, phase: 'refused', result: open.result }
    // @ts-expect-error `completed` is not a phase; a settled action is observed or settled
    const forgedD: HandsActionView = { ...open, phase: 'completed' }
    // @ts-expect-error a row that is not a refusal always has a result behind it
    const forgedE: HandsUnverifiedActionView = { ...open, result: null }
    expect([forgedA.phase, forgedB.phase, forgedC.phase, forgedD.phase]).toEqual([
      'verified',
      'observed',
      'refused',
      'completed',
    ])
    expect(forgedE.result).toBeNull()
  })
})

describe('the projection reports each state truthfully', () => {
  it('reads running for an attempt that has not settled, evidence or not', () => {
    expect(handsPhaseOf(runningWithEvidence(), 'action-1')).toBe('running')
    const row = onlyAction(runningWithEvidence())
    expect(row.phase).toBe('running')
    // Partial evidence does not promote an in-flight action: it is still, and
    // visibly, in flight.
    expect(row.observations).toHaveLength(1)
    expect(row.result?.settledAt).toBeNull()
    expect(row.result?.durationMs).toBeNull()
    expect(row.verification).toBeNull()
  })

  it('reads observed for evidence with no verdict, and settled for neither', () => {
    expect(handsPhaseOf(settledWithEvidence(), 'action-1')).toBe('observed')
    expect(onlyAction(settledWithEvidence()).phase).toBe('observed')
    // The split is the point: `observed` can mean observed and nothing else, so a
    // surface can render "evidence came back, nobody checked" as its own state
    // rather than shading it into "done".
    const bare = recordActionResult(initialHandsState(), action({
      status: 'completed',
      settledAt: T2,
      durationMs: 2_000,
    }))
    expect(handsPhaseOf(bare, 'action-1')).toBe('settled')
    expect(onlyAction(bare).observations).toEqual([])
  })

  it('reads cancelled and timed_out as themselves, and never as failed', () => {
    const cancelled = settle(initialHandsState(), 'action-1', action({
      status: 'cancelled',
      settledAt: T2,
      durationMs: 500,
      reason: 'a caller stopped it',
    }))
    const timedOut = settle(initialHandsState(), 'action-1', action({
      status: 'timed_out',
      settledAt: T2,
      durationMs: 30_000,
      reason: 'it outran its budget',
    }))
    expect(handsPhaseOf(cancelled, 'action-1')).toBe('cancelled')
    expect(handsPhaseOf(timedOut, 'action-1')).toBe('timed_out')
    // The executor's own prose about why does not cross: the closed phase is the
    // honest word, and it differs from `failed` because nothing failed.
    expect(JSON.stringify(onlyAction(cancelled))).not.toContain('a caller stopped it')
    expect(JSON.stringify(onlyAction(timedOut))).not.toContain('outran its budget')
    expect(JSON.stringify(onlyAction(timedOut))).not.toContain('failed')
  })

  it('reports lane and counts that agree with the rows it shows', () => {
    let state = initialHandsState()
    state = recordActionResult(state, action({ actionId: 'a-running' }))
    state = recordActionResult(state, action({
      actionId: 'a-completed',
      status: 'completed',
      settledAt: T2,
    }))
    state = recordActionResult(state, action({ actionId: 'a-failed', status: 'failed', settledAt: T2 }))
    state = recordRefusal(state, {
      actionId: 'a-refused',
      code: 'capability_deferred',
      reason: HANDS_REFUSAL_REASONS.capability_deferred,
      capabilityId: null,
      refusedAt: T0,
    })
    const projection = projectHandsStatus(state, BUILD)

    expect(projection.health).toBe('ready')
    expect(projection.reason).toBeNull()
    expect(projection.sequence).toBe(0)
    expect(projection.observedAt).toBe(BUILD)
    expect(projection.lane).toBe('running')
    expect(projection.counts).toEqual({
      actions: 4,
      running: 1,
      observed: 0,
      settled: 1,
      verified: 0,
      refused: 1,
      failed: 1,
      cancelled: 0,
      timedOut: 0,
      observations: 0,
      verifications: 0,
    })
    // `actions` is the sum of the phases, so a surface can check the two against
    // each other instead of trusting either.
    const phases = HANDS_ACTION_PHASES.reduce((sum, phase) => sum + projection.counts[COUNT_KEY[phase]], 0)
    expect(phases).toBe(projection.counts.actions)
  })

  it('reports idle when nothing is in flight, and running only then', () => {
    const done = recordActionResult(initialHandsState(), action({
      status: 'completed',
      settledAt: T2,
      durationMs: 10,
    }))
    expect(projectHandsStatus(done, BUILD).lane).toBe('idle')
    expect(projectHandsStatus(runningWithEvidence(), BUILD).lane).toBe('running')
    // A lane is not idle because it was refused, and an action existing does not
    // make it running. Idle means exactly one thing: nothing in flight.
    expect(projectHandsStatus(refused(), BUILD).lane).toBe('idle')
  })

  it('is a pure fold: the same state gives the same projection, and state is untouched', () => {
    const state = verified()
    const snapshot = (): string => JSON.stringify({
      actions: [...state.actions.keys()],
      observations: [...state.observations.keys()],
      verifications: [...state.verifications.keys()],
      refusals: [...state.refusals.keys()],
      verified: [...state.verifiedActions],
    })
    const before = snapshot()
    const first = projectHandsStatus(state, BUILD, () => 'title-match')
    const second = projectHandsStatus(state, BUILD, () => 'title-match')
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(snapshot()).toBe(before)
    // And no clock: the instant is the caller's, and two calls with two different
    // instants differ in that one field and nowhere else.
    const later = projectHandsStatus(state, '2026-10-01T10:00:00.000Z', () => 'title-match')
    expect(later.observedAt).not.toBe(first.observedAt)
    expect({ ...later, observedAt: first.observedAt }).toEqual(first)
  })

  it('reports the code-owned ceilings rather than anything a caller chose', () => {
    const projection = projectHandsStatus(verified(), BUILD)
    expect(projection.limits).toBe(ABSENT_HANDS_STATUS_PROJECTION.limits)
    expect(Object.isFrozen(projection.limits)).toBe(true)
    // A view says what the bounds are; it has no field for raising them, and this
    // file has no function that takes a limit as an argument.
    const code = strippedSource('../../core/protocol/hands.ts')
    expect(code).not.toMatch(/HANDS_LIMITS\[/)
    expect(code).not.toMatch(/handsLimits\(/)
  })
})

describe('exact-key validation, for whoever forwards this later', () => {
  it('accepts the projection it declares and refuses one field more', () => {
    const projection = projectHandsStatus(verified(), BUILD)
    expect(Object.keys(projection).sort()).toEqual([...HANDS_STATUS_PROJECTION_KEY_NAMES].sort())
    expect(hasExactHandsStatusProjectionKeys(projection)).toBe(true)
    // The extra field is where a capability, a scope, an owner or an input would
    // arrive, so it fails rather than being quietly ignored.
    expect(hasExactHandsStatusProjectionKeys({ ...projection, input: { url: 'x' } })).toBe(false)
    expect(hasExactHandsStatusProjectionKeys({ ...projection, trusted: true })).toBe(false)
    // And so does a field left out: a projection that cannot report its health is
    // not a projection with a null health.
    const { health: _dropped, ...rest } = projection
    expect(hasExactHandsStatusProjectionKeys(rest)).toBe(false)
  })

  it('accepts every arm of the action view and refuses one field more', () => {
    for (const state of [runningWithEvidence(), verified(), refused()]) {
      const row = onlyAction(state)
      expect(Object.keys(row).sort()).toEqual([...HANDS_ACTION_VIEW_KEY_NAMES].sort())
      expect(hasExactHandsActionViewKeys(row)).toBe(true)
      expect(hasExactHandsActionViewKeys({ ...row, action: 'click' })).toBe(false)
      expect(hasExactHandsActionViewKeys({ ...row, verified: true })).toBe(false)
      expect(hasExactHandsActionViewKeys({ ...row, capabilityId: 'browser.click' })).toBe(false)
      const { verification: _dropped, ...rest } = row
      expect(hasExactHandsActionViewKeys(rest)).toBe(false)
    }
  })

  it('refuses a payload with no keys, and accepts the frozen absent one', () => {
    // The primitive this borrows is the same one the contract's envelope validator
    // uses, reached from the other direction: there it guards what Core admits,
    // here it guards what a host would forward.
    expect(hasExactHandsStatusProjectionKeys(ABSENT_HANDS_STATUS_PROJECTION)).toBe(true)
    expect(hasExactHandsStatusProjectionKeys({})).toBe(false)
    expect(hasExactHandsActionViewKeys({})).toBe(false)
    // An empty object is not a projection with nothing in it, and it is not an
    // action row with nothing on it. Both are refused for the same reason.
  })

  it('exposes the key lists frozen, so a boundary cannot state a different one', () => {
    // A host that forwards this projection needs the key set in order to check it,
    // and a second list in another file is the one place it could drift.
    expect(Object.isFrozen(HANDS_STATUS_PROJECTION_KEY_NAMES)).toBe(true)
    expect(Object.isFrozen(HANDS_ACTION_VIEW_KEY_NAMES)).toBe(true)
    expect(HANDS_STATUS_PROJECTION_KEY_NAMES).toHaveLength(8)
    expect(HANDS_ACTION_VIEW_KEY_NAMES).toHaveLength(9)
  })
})

describe('the HandsSource seam, which nothing fills yet', () => {
  it('is satisfiable by the smallest thing that can be read', () => {
    // If this suite can drive the whole seam with an object this small, the seam
    // really is this small — the same argument the Workforce and Context lanes made
    // by writing their fakes down first. A source is a reader with an optional
    // heartbeat; it cannot take an instruction, because it has no method that
    // accepts one.
    let current: HandsStatusProjection = ABSENT_HANDS_STATUS_PROJECTION
    const listeners = new Set<(projection: HandsStatusProjection) => void>()
    const source = {
      projection: () => current,
      subscribe: (listener: (projection: HandsStatusProjection) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    expect(source.projection().health).toBe('unavailable')
    const seen: HandsStatusProjection[] = []
    const dispose = source.subscribe((projection) => seen.push(projection))
    current = projectHandsStatus(verified(), BUILD, () => 'title-match')
    for (const listener of [...listeners]) listener(source.projection())
    expect(seen[0]?.health).toBe('ready')
    expect(seen[0]?.counts.verified).toBe(1)
    dispose()
    expect(listeners.size).toBe(0)
  })

  it('makes subscribe optional, because a source that only moves with Core has nothing to push', () => {
    const pullOnly: HandsSource = { projection: () => ABSENT_HANDS_STATUS_PROJECTION }
    expect(pullOnly.subscribe).toBeUndefined()
    // The only two members, so there is no third thing for a caller to reach for.
    expect(Object.keys(pullOnly)).toEqual(['projection'])
    expect(pullOnly.projection().health).toBe('unavailable')
  })

  it('declares two members, both reads, and no way to name an action', () => {
    // Enumerated from the source rather than asserted in prose, because the whole
    // claim is an absence and an absence has to be checked against something. The
    // declaration mentions no action, no verification, no refusal and no authority,
    // because a seam that could name one could be asked to act on it.
    const seam = seamSource()
    expect(seam).toContain('export interface HandsSource')
    expect(seam).toContain('projection(): HandsStatusProjection')
    expect(seam).toContain('subscribe?(')
    expect(seam).not.toMatch(/action|verif|refus|submit|execute|capability|authority|grant|scope/)
    // Only `projection()` returns anything, so the seam cannot hand out a handle.
    expect(seam).not.toMatch(/=>\s*Hands(ActionView|VerificationRequest|ScopedCapabilityRef)/)
  })
})