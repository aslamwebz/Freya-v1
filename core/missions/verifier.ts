import {
  MISSION_REASONS,
  type MissionReason,
  type MissionVerificationContext,
  type MissionVerificationOutcome,
  type MissionVerifier,
} from './types'

/**
 * MISSION VERIFIERS.
 *
 * ## Why this is a separately registered, code-owned component
 *
 * A Mission reaching `completed` is the most consequential thing the subsystem can
 * do: it is the durable record that an outcome was achieved. Nothing less than an
 * independent check may set it.
 *
 * So a verifier is an interface with exactly one implementation this phase
 * registers, and neither a renderer nor a model may supply one. The tempting
 * alternative — "just let the model say it's done" — is the precise failure the
 * Phase 6 brief names when it says verification is not optional: a capability that
 * reports success is not evidence of one, and a model that *believes* a Mission is
 * finished has not established that it is.
 *
 * ## What `mission.work.verified` can and cannot establish
 *
 * It establishes exactly one thing: **the required Work executions were
 * independently verified.**
 *
 * > Phase 7 can verify that the required Work executions completed with every step
 * > verified. **It cannot prove an arbitrary external-world outcome.** A Mission
 * > whose criteria are "the employer responded" is not established by this
 * > verifier, and no amount of Work running will establish it.
 *
 * That limitation is stated here, in the code, rather than left for a reader to
 * discover. A stronger verifier comes with the capabilities that can observe the
 * world — Phase 10's Hands, or a Relay — and none of those exist yet.
 *
 * ## Deterministic, bounded, and abortable
 *
 * The built-in verifier makes no model call, touches no network and reads no
 * clock, so Mission completion costs zero inference and cannot hang. It still
 * accepts an `AbortSignal` because the interface promises it, and because a future
 * verifier will need it.
 */

export const MISSION_WORK_VERIFIER_ID = 'mission.work.verified'

/**
 * The only verifier this phase ships.
 *
 * Deterministic and total: the same durable facts always produce the same verdict. That
 * is what makes Mission completion reproducible and testable, and it is why this can be
 * trusted to gate a terminal transition without a second opinion.
 *
 * ## Phase 47: evidence, not only Runs
 *
 * The Phase 7 verifier could only answer "were the required Runs verified?". A Mission
 * driven by autonomy completes through *steps and evidence* instead, so the verifier now
 * checks both, and refuses on either.
 *
 * The order is fixed and it is the order of how badly a failure misleads:
 *
 * ```
 * quantity → freshness → blockers → step coverage → evidence → Runs
 * ```
 *
 * A Mission asked for 100 and observed 40 is reported as `quantity_not_reached` rather
 * than as whatever the Run state happened to be — because "40 of 100" is the fact the
 * owner needs and "one Run completed with all steps verified" would be true and useless.
 */
export class WorkVerifiedMissionVerifier implements MissionVerifier {
  readonly id = MISSION_WORK_VERIFIER_ID

  async verify(
    context: MissionVerificationContext,
    signal: AbortSignal,
  ): Promise<MissionVerificationOutcome> {
    if (signal.aborted) return notEstablished(MISSION_REASONS.owner)

    // 1. A requested quantity is a promise to the owner, and only observed results count
    //    against it. `reported` is deliberately absent from this comparison: a capability
    //    claiming twelve findings is not twelve findings.
    //
    //    This runs first because a Mission short of its quantity cannot become
    //    sufficient by having a nicer step picture.
    if (context.requestedQuantity !== null) {
      if (context.observedResults < context.requestedQuantity) {
        return notEstablished(MISSION_REASONS.quantity_not_reached)
      }
    }

    // 2. Freshness. An outcome backed entirely by expired observations is not
    //    established *now*, even though it was established once. This is why the engine
    //    passes expired and observed separately rather than a single total.
    if (context.expiredObservedResults > 0) {
      return notEstablished(MISSION_REASONS.verification_expired)
    }

    // 3. Blockers and pending approvals. Completion is "nothing is outstanding", not "the
    //    evidence looks good enough" — so an applied blocker or an unanswered gate refuses
    //    even when the counts would otherwise pass.
    if (context.blocked) return notEstablished(MISSION_REASONS.dependency_unverified)
    if (context.approvalPending) return notEstablished(MISSION_REASONS.approval_pending)

    // 4. Step coverage. A skipped or cancelled step is not evidence, and a Mission cannot
    //    be complete while part of its own plan was abandoned.
    const steps = context.stepCounts
    if (steps.total > 0) {
      if (steps.skipped > 0 || steps.cancelled > 0) {
        return notEstablished(MISSION_REASONS.child_run_unverified)
      }
      if (steps.failed > 0) return notEstablished(MISSION_REASONS.step_failed)
      if (steps.blocked > 0 || steps.pending > 0) {
        return notEstablished(MISSION_REASONS.dependency_unverified)
      }
      // `delegated` and `running` are *not* refusals on their own: a Mission whose steps
      // are all verified and one of which is still winding down is established. What
      // matters is that nothing is outstanding, which the three checks above cover.
    }

    // 5. Child Runs. Still checked, still first-refused, and still required when they were
    //    *named* — a caller that asserted specific Runs matter has been answered about
    //    those Runs, not about the Mission in general.
    const required = [...context.requiredRunIds]
    let verifiedRunSteps = 0
    for (const runId of required) {
      if (signal.aborted) return notEstablished(MISSION_REASONS.owner)

      const status = context.runStatuses[runId]
      if (status === undefined) return notEstablished(MISSION_REASONS.child_run_failed)
      // A failed or cancelled Run is not evidence about the outcome; it is evidence
      // that one attempt did not produce it. Another Run may still succeed, which
      // is why this returns "not established" rather than failing the Mission.
      if (status === 'failed') return notEstablished(MISSION_REASONS.child_run_failed)
      if (status === 'cancelled') return notEstablished(MISSION_REASONS.child_run_cancelled)
      if (status === 'non_terminal') return notEstablished(MISSION_REASONS.child_run_unverified)

      const runSteps = context.runStepStatuses[runId]
      if (runSteps === undefined) return notEstablished(MISSION_REASONS.child_run_unverified)
      // "The Run completed" is not the same as "its steps were verified", and this
      // is where the two are kept apart: a Run can reach `completed` with steps
      // that were skipped, and a skipped step proves nothing.
      if (runSteps.total === 0 || runSteps.verified !== runSteps.total) {
        return notEstablished(MISSION_REASONS.child_run_unverified)
      }
      if (runSteps.failed > 0) return notEstablished(MISSION_REASONS.child_run_failed)
      verifiedRunSteps += runSteps.verified
    }

    // 6. Something must actually be behind this.
    //
    //    Refused unless *one* of the three routes to an outcome has something in it:
    //    observed evidence, a verified plan step, or a verified Run step. The
    //    disjunction is the whole point — Phase 7 could complete a Mission with nothing
    //    but a verified Run, Phase 47 can complete one with nothing but observations, and
    //    a Mission with **neither** is a plan that was never carried out.
    //
    //    This check sits *after* the Run loop rather than before it so that a failed Run
    //    is reported as a failed Run rather than as "no evidence" — the more specific
    //    answer is the more useful one.
    if (context.observedResults === 0 && steps.verified === 0 && verifiedRunSteps === 0) {
      return notEstablished(MISSION_REASONS.no_evidence)
    }

    return established(Math.max(context.observedResults, verifiedRunSteps))
  }
}

/** A pass. `summaryLength` is a count, never content: it may reach a projection. */
function established(what: number): MissionVerificationOutcome {
  return {
    established: true,
    reason: MISSION_REASONS.verification_passed,
    summaryLength: what,
  }
}

function notEstablished(reason: MissionReason): MissionVerificationOutcome {
  return { established: false, reason }
}

/**
 * The set of verifiers Core will accept.
 *
 * Closed and code-owned. A verifier named by anything other than this registry is
 * refused, so there is no path by which a caller supplies the thing that decides
 * whether an outcome was achieved.
 */
export class MissionVerifierRegistry {
  private readonly verifiers = new Map<string, MissionVerifier>()

  constructor(verifiers: readonly MissionVerifier[] = [new WorkVerifiedMissionVerifier()]) {
    for (const verifier of verifiers) this.register(verifier)
  }

  register(verifier: MissionVerifier): void {
    if (typeof verifier.id !== 'string' || verifier.id.length === 0) {
      throw new Error('a Mission verifier needs an id')
    }
    if (typeof verifier.verify !== 'function') {
      throw new Error(`Mission verifier ${verifier.id} does not implement verify()`)
    }
    this.verifiers.set(verifier.id, verifier)
  }

  get(id: string): MissionVerifier | undefined {
    return this.verifiers.get(id)
  }

  ids(): readonly string[] {
    return [...this.verifiers.keys()].sort()
  }
}