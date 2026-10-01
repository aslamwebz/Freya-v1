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
 * The only verifier Phase 7 ships.
 *
 * Deterministic and total: the same Work state always produces the same verdict.
 * That is what makes Mission completion reproducible and testable, and it is why
 * this can be trusted to gate a terminal transition without a second opinion.
 */
export class WorkVerifiedMissionVerifier implements MissionVerifier {
  readonly id = MISSION_WORK_VERIFIER_ID

  async verify(
    context: MissionVerificationContext,
    signal: AbortSignal,
  ): Promise<MissionVerificationOutcome> {
    if (signal.aborted) return notEstablished(MISSION_REASONS.owner)

    // No child Run means nothing has been attempted. Establishing a Mission that
    // has never executed anything would be establishing a plan.
    const required = [...context.requiredRunIds]
    if (required.length === 0 || context.requiredRunIds.length === 0) {
      return notEstablished(MISSION_REASONS.no_child_runs)
    }

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

      const steps = context.runStepStatuses[runId]
      if (steps === undefined) return notEstablished(MISSION_REASONS.child_run_unverified)
      // "The Run completed" is not the same as "its steps were verified", and this
      // is where the two are kept apart: a Run can reach `completed` with steps
      // that were skipped, and a skipped step proves nothing.
      if (steps.total === 0 || steps.verified !== steps.total) {
        return notEstablished(MISSION_REASONS.child_run_unverified)
      }
      if (steps.failed > 0) return notEstablished(MISSION_REASONS.child_run_failed)
    }

    return {
      established: true,
      reason: MISSION_REASONS.verification_passed,
      // A count, never content: it may reach a projection and an activity row.
      summaryLength: required.length,
    }
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