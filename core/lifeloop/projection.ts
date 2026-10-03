import { LIFE_LOOP_SCHEMA_VERSION } from '../protocol/lifeloop'
import type {
  LifeLoopAssertionView,
  LifeLoopConclusionView,
  LifeLoopCountersView,
  LifeLoopDeadlineView,
  LifeLoopProjection,
  LifeLoopWakeView,
} from '../protocol/lifeloop'
import type { LifeLoopSnapshot } from './runtime'
import { describeRecovery } from './recovery'
import type { LifeLoopStatus } from './types'

/**
 * The life loop's projection.
 *
 * A pure function of the runtime's snapshot and the journal sequence it folded.
 * No clock, no randomness and no I/O — so two reads of the same durable state
 * produce deep-equal objects, which is what lets a surface say "this is what Freya
 * is doing" rather than "this is roughly what Freya was doing a moment ago".
 *
 * Every string that reaches a window is a closed code or one of the loop's own
 * fixed sentences. There is no field here a prompt, a provider's answer, the text
 * of an event or a refusal's free-form reason could hide in, which is the shape of
 * the read rather than a rendering choice.
 */
export interface LifeLoopProjectionInput {
  readonly sequence: number
  readonly snapshot: LifeLoopSnapshot
  /** ISO instant, injected, for the deadline countdown. */
  readonly now: string
  /**
   * Degradation to report, if any.
   *
   * Applied *after* the reading rather than instead of it, and that ordering is the
   * point. A stopped Freya is still idle, still holds the wake it was refused, and
   * still has a state a surface can name — so replacing those with zeroes would let
   * "I cannot tell you what the loop is doing" be rendered as "nothing is happening",
   * which is precisely the blur a stopped system must not make.
   */
  readonly degraded?: { readonly reason: string }
}

export function projectLifeLoop(input: LifeLoopProjectionInput): LifeLoopProjection {
  const { snapshot } = input
  const status = snapshot.status
  return {
    health: input.degraded === undefined ? 'ready' : 'degraded',
    reason: input.degraded?.reason ?? null,
    schemaVersion: LIFE_LOOP_SCHEMA_VERSION,
    sequence: input.sequence,
    state: status.state,
    isIdle: status.isIdle,
    isStopped: status.isStopped,
    isEnabled: snapshot.enabled,
    currentWake: wakeView(status.currentWake),
    currentDeadline: deadlineView(status.currentDeadline, input.now),
    counters: countersView(snapshot),
    conclusion: conclusionView(status.conclusion),
    lastRefusal:
      status.lastRefusal === null ? null : { code: status.lastRefusal.code, at: status.lastRefusal.at },
    refusedWakes: snapshot.refusedWakes,
    // One line, assembled from closed codes by the domain. Never the anomaly list:
    // a fold anomaly is a fact for the release gate, not for a person reading a
    // panel, and surfacing it here would put journal-internal detail on a surface
    // that has no way to act on it.
    recovery: describeSnapshotRecovery(snapshot),
    requiresOwnerAction: snapshot.recovery?.requiresOwnerAction === true,
    assertions: assertionView(snapshot),
    limits: snapshot.limits,
  }
}

/**
 * The frozen absent snapshot, imported rather than rebuilt.
 *
 * A surface that compares two absent reads must get identical objects, and a
 * second literal here would be one more thing to keep in step.
 */
function wakeView(wake: LifeLoopStatus['currentWake']): LifeLoopWakeView | null {
  if (wake === null) return null
  return {
    wakeId: wake.wakeId,
    source: wake.source,
    kind: wake.kind,
    goalRef: wake.goalRef,
    sourceRef: wake.sourceRef,
    occurredAt: wake.occurredAt,
    observedAt: wake.observedAt,
  }
}

function deadlineView(
  deadline: LifeLoopStatus['currentDeadline'],
  now: string,
): LifeLoopDeadlineView | null {
  if (deadline === null) return null
  const expiresAt = Date.parse(deadline.expiresAt)
  const current = Date.parse(now)
  const remaining = Number.isFinite(expiresAt) && Number.isFinite(current) ? expiresAt - current : 0
  return {
    type: deadline.type,
    expiresAt: deadline.expiresAt,
    // Never negative and never infinite. A malformed deadline reads as expired
    // rather than as a long time, which is the direction that fails closed.
    remainingMs: Math.max(0, remaining),
  }
}

function countersView(snapshot: LifeLoopSnapshot): LifeLoopCountersView {
  return {
    iteration: snapshot.status.iterationCount,
    actions: snapshot.status.actionCount,
    verifications: snapshot.status.verificationCount,
    cognitionRequests: snapshot.status.cognitionRequestCount,
    attempts: snapshot.status.attemptCount,
    maxAttempts: snapshot.limits.maxAttemptsPerUnit,
  }
}

function conclusionView(
  conclusion: LifeLoopStatus['conclusion'],
): LifeLoopConclusionView | null {
  if (conclusion === null) return null
  return {
    outcome: conclusion.outcome,
    escalation: conclusion.escalation,
    attentionSuppressed: conclusion.attentionSuppressed,
  }
}

function describeSnapshotRecovery(snapshot: LifeLoopSnapshot): string | null {
  const report = snapshot.recovery
  if (report === null) return null
  // The domain assembles this from closed codes, and it is the only place the
  // recovery reasons are worded. It is safe to render because it cannot contain
  // anything but a code and a fixed sentence — which is the property that let it be
  // written for a log line in the first place.
  return describeRecovery(report)
}

function assertionView(snapshot: LifeLoopSnapshot): LifeLoopAssertionView {
  const checks = snapshot.assertions?.checks
  return {
    noModelCallWithoutWake: checks?.noModelCallWithoutWake ?? true,
    noContinuousPolling: checks?.noContinuousPolling ?? true,
    noHiddenReasoning: checks?.noHiddenReasoning ?? true,
    noUnrestrictedLoops: checks?.noUnrestrictedLoops ?? true,
    noAuthorityEscalation: checks?.noAuthorityEscalation ?? true,
    noIdleModelCall: checks?.noIdleModelCall ?? true,
    noBackgroundReasoning: checks?.noBackgroundReasoning ?? true,
    noHiddenDurableState: checks?.noHiddenDurableState ?? true,
  }
}