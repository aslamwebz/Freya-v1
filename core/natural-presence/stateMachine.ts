/**
 * THE PRESENCE STATE MACHINE — Phase 26's derivation.
 *
 * One pure function: no I/O, no clock read, no model. It derives the presence
 * state from real Core facts only, in the same fixed order Phase 13 established.
 * A renderer never decides urgency, never invents a state, and never overrides
 * this derivation.
 */

import {
  PHASE26_PRESENCE_LIMITS,
  PHASE26_STATE_ANIMATION,
  type Phase26Animation,
  type Phase26PresenceState,
} from './types'

/**
 * Everything the state machine needs to derive one presence state.
 *
 * Every field is a fact Core holds. There is deliberately no field a model, an
 * event body or a context blob could set.
 */
export interface Phase26PresenceInput {
  /** STOP ALL is latched. Outranks everything. */
  readonly stopAllActive: boolean
  /** The journal cannot be trusted. */
  readonly integrityCorrupt: boolean
  /** Core is running but a subsystem has faulted. */
  readonly degraded: boolean
  /** A synthesis engine is producing audio right now. */
  readonly synthesisActive: boolean
  /** A microphone is open right now. */
  readonly captureActive: boolean
  /** A provider call is in flight. */
  readonly providerCallInFlight: boolean
  /** A Run is executing. */
  readonly runExecuting: boolean
  /** The one attention directive Core chose, or null. */
  readonly attentionDirective: unknown | null
  /** The one personality cue Core chose, or null. */
  readonly personalityCue: unknown | null
}

/**
 * Derive the presence state from Core facts.
 *
 * Pure and deterministic given the same input. The order is the contract:
 *
 *  1. STOP ALL → `error`
 *  2. Integrity corrupt → `error`
 *  3. Degraded → `degraded`
 *  4. Synthesis active → `speaking`
 *  5. Capture active → `listening`
 *  6. Provider call in flight → `working`
 *  7. Run executing → `working`
 *  8. Attention directive → `attention`
 *  9. Personality cue → `attention`
 * 10. Nothing → `idle`
 *
 * `thinking` stays in the vocabulary but is never derived. The only honest
 * live signal is `CoreStatus.activeProviderCalls`, and a provider call in
 * flight is `working`; Core holds no "cognition requested but no provider call
 * yet" fact. Inventing one would let a submitted command make Freya look busy,
 * so Phase 26 preserves Phase 13's position: `thinking` has no door.
 */
export function derivePhase26PresenceState(input: Phase26PresenceInput): Phase26PresenceState {
  if (input.stopAllActive) return 'error'
  if (input.integrityCorrupt) return 'error'
  if (input.degraded) return 'degraded'
  if (input.synthesisActive) return 'speaking'
  if (input.captureActive) return 'listening'
  if (input.providerCallInFlight) return 'working'
  if (input.runExecuting) return 'working'
  if (input.attentionDirective !== null) return 'attention'
  if (input.personalityCue !== null) return 'attention'
  return 'idle'
}

/** The animation for a presence state. Fixed by the protocol. */
export function phase26Animation(state: Phase26PresenceState): Phase26Animation {
  return PHASE26_STATE_ANIMATION[state]
}

/**
 * A short human line for each presence state.
 *
 * Never a mental-state claim. "Standing by" is a fact about what Freya is
 * doing; "feeling curious" would be a claim about what Freya is, and Core
 * cannot know that.
 */
export function phase26Detail(state: Phase26PresenceState, input: Phase26PresenceInput): string {
  const line = ((): string => {
    switch (state) {
      case 'idle':
        return 'Standing by.'
      case 'listening':
        return 'Listening.'
      case 'thinking':
        return 'Considering the request.'
      case 'speaking':
        return 'Speaking.'
      case 'working':
        return 'Working.'
      case 'attention':
        return 'Something needs you.'
      case 'error':
        return input.stopAllActive
          ? 'Stopped. Every model request is refused.'
          : 'Something failed. Review the system panel.'
      case 'degraded':
        return 'Core is degraded. A subsystem has faulted.'
    }
  })()
  return line.slice(0, PHASE26_PRESENCE_LIMITS.maxDetailChars)
}
