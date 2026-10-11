import { isTruncationSignal } from '../model/provider'
import type { ModelFinishReason } from '../../shared/contracts/model'

/**
 * The Cognition Service: the only door from the rest of Freya to a provider.
 *
 * It owns the Governor, the Gateway and the Guard, and exposes none of them.
 * What it exposes instead is a pair of *authority* objects whose methods
 * reflect the authority of the principal they were issued to: the owner's has
 * grant governance on it, a worker's does not.
 *
 * The sequence is fixed and has no branches that skip a step:
 *
 *   append `cognition.requested`        (durable, before anything else)
 *   ask the Governor
 *     deny  -> append `cognition.denied` and return. The provider is untouched.
 *     allow -> append `cognition.allowed`, reserve the grant, then call once.
 *
 * There is no retry. A failure is one call, recorded once.
 */

export type CognitionOutcome =
  | {
      status: 'allowed'
      requestId: string
      text: string
      providerId: string
      model: string
      /**
       * Why the provider stopped generating, as it reported it.
       *
       * Optional because every producer of a `CognitionOutcome` — including the
       * test doubles several suites construct by hand — predates it, and making
       * it required would break a file this change does not own for no gain. What
       * is not optional is the *meaning*: read it with
       * {@link cognitionOutcomeTruncated}, never by testing the spelling here.
       */
      finishReason?: ModelFinishReason | null
      /**
       * Whether the answer was cut off by the output budget.
       *
       * The reason this service is the wrong place to decide anything about it.
       * Cognition's job is to report what the provider said; whether a cut-off
       * answer may be stored as an answer is the Mind's judgement, made where the
       * turn and the transcript are.
       */
      truncated?: boolean
    }
  | { status: 'denied'; requestId: string; reason: string }
  | {
      status: 'failed'
      requestId: string
      reason: string
      /**
       * Whether a provider had already been asked. Carried rather than left for
       * the caller to infer, because it decides whether the attempt may have cost
       * anything — and a caller that guessed wrong would record a paid call as a
       * free one.
       */
      providerContacted: boolean
    }
  /**
   * Stopped rather than unsuccessful.
   *
   * Its own outcome, because the two are not the same claim: a cancelled
   * request says nothing about whether the provider would have worked, and a
   * caller that saw `failed` would be reporting a defect that never happened.
   */
  | { status: 'cancelled'; requestId: string; reason: string; providerContacted: boolean }


/**
 * Whether an allowed outcome's answer was cut off before it finished.
 *
 * The one place the question is asked, so "did it get truncated?" is answered
 * identically by the Mind on the single-call path and by the tool loop — and so
 * neither of them can quietly disagree with the other about what truncation is.
 * Structural on the outcome, which is why it also accepts the plain result shape
 * a provider hands the gateway.
 *
 * False for every non-`allowed` status, and that is the whole truth of a denial
 * or a cancellation: nothing came back to have been cut off.
 *
 * Generic in its argument rather than a bare union so a caller may hand it a whole
 * {@link CognitionOutcome}, a subset of one, or anything else that has a `status`
 * and the two finish fields — which is what several call sites and test doubles in
 * other layers actually have.
 */
export function cognitionOutcomeTruncated<T extends {
  status: string
  finishReason?: ModelFinishReason | null
  truncated?: boolean
}>(outcome: T): boolean {
  return outcome.status === 'allowed' && isTruncationSignal(outcome)
}