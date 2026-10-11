/**
 * The presence state machine.
 *
 * One pure function, no I/O, no clock read, no model. It derives the presence
 * state from Core projections only: Core's status, the attention directive,
 * the work projection, the personality cue, and the voice capture/synthesis
 * status.
 *
 * ## The derivation order
 *
 * Ordered by how much the condition matters, not by how likely it is:
 *
 * 1. **STOP ALL** → `error`. Every model request is refused.
 * 2. **Integrity corrupt** → `error`. The journal cannot be trusted.
 * 3. **Degraded** → `degraded`. Core is running but a subsystem has faulted.
 * 4. **Voice synthesis active** → `speaking`. Freya is producing audio.
 * 5. **Voice capture active** → `listening`. A microphone is open.
 * 6. **Provider call in flight** → `working`. A model request is executing.
 * 7. **Run executing** → `working`. A capability is running.
 * 8. **Attention directive** → `attention`. Core chose to cue.
 * 9. **Personality cue** → `attention`. Core chose to express a cue.
 * 10. **Idle** → `idle`. Nothing is happening.
 *
 * The renderer never decides urgency, never invents a state, and never
 * overrides this derivation. A renderer that wanted to show `working` while
 * nothing is running would be a renderer that could lie about what Freya is
 * doing — which is the one thing a presence renderer must never do.
 */

import type { CoreStatus } from '../../shared/contracts/projections/core'
import type { AttentionProjection, AttentionDirectiveView } from '../protocol/attention'
import type { WorkProjection } from '../work/projection'
import type { PersonalityProjection, PersonalityCueView } from '../protocol/personality'
import type { VoiceProjection } from '../protocol/conversation'
import {
  PRESENCE_STATE_ANIMATION,
  canTransitionPresence,
  type PresenceAnimation,
  type PresenceFrame,
  type PresenceProtocolState,
  type PresenceWorkSummary,
  PRESENCE_SCHEMA_VERSION,
} from './protocol'

/** Everything the state machine needs to derive one presence frame. */
export interface PresenceInput {
  /** Core's own status, or null before it has reported. */
  readonly core: CoreStatus | null
  /** The attention projection, or null before Core has reported one. */
  readonly attention: AttentionProjection | null
  /** The work projection, or null before Core has reported one. */
  readonly work: WorkProjection | null
  /** The personality projection, or null before Core has reported one. */
  readonly personality: PersonalityProjection | null
  /** The voice projection, or null before Core has reported one. */
  readonly voice: VoiceProjection | null
  /**
   * Whether a synthesis engine is producing audio right now.
   *
   * Set by the host from a real signal, never by a renderer. False when no
   * synthesis engine exists, because "no engine" and "engine is running" are
   * different facts and the first must not be presented as the second.
   */
  readonly synthesisActive: boolean
  /** Current Core event sequence, for freshness. */
  readonly sequence: number
}

/**
 * Derive the presence state from Core projections.
 *
 * Pure and deterministic given the same input. No clocks, no randomness, no
 * reading of globals. That is what lets it be tested against a table of cases
 * instead of being eyeballed in a window.
 */
export function derivePresenceState(input: PresenceInput): PresenceProtocolState {
  const { core, attention, work, personality, voice } = input

  if (core === null) return 'idle'

  // STOP ALL outranks everything: a stopped Freya is not a working Freya.
  if (core.stopAll.active) return 'error'

  // An untrustworthy journal outranks everything except STOP ALL.
  if (core.integrity.integrity === 'corrupt') return 'error'

  // A degraded Core is still running, but a subsystem has faulted.
  if (core.lifecycle === 'degraded') return 'degraded'

  // Voice synthesis: Freya is speaking. This outranks capture because a
  // person hearing Freya speak needs to see that Freya is speaking, not that
  // a microphone happens to be open.
  if (input.synthesisActive) return 'speaking'

  // Voice capture: a microphone is open.
  if (voice?.capturing === true) return 'listening'

  // A provider call in flight: a model request is executing.
  if (core.activeProviderCalls > 0) return 'working'

  // A Run is executing: a capability is running.
  if (work !== null && work.counts.running > 0) return 'working'

  // An attention directive: Core chose to cue.
  if (attention !== null && attention.directive !== null) return 'attention'

  // A personality cue: Core chose to express.
  if (personality !== null && personality.presenceCue !== null) return 'attention'

  return 'idle'
}

/**
 * Derive the work summary for the presence card.
 *
 * Null when no work is running. The renderer shows the summary only when
 * there is something to summarize; an empty card is not a card.
 */
export function deriveWorkSummary(work: WorkProjection | null): PresenceWorkSummary | null {
  if (work === null) return null
  if (work.counts.running === 0 && work.counts.waiting === 0 && work.counts.awaitingApproval === 0) {
    return null
  }
  const label =
    work.counts.awaitingApproval > 0
      ? 'a run is waiting for your decision'
      : work.counts.running > 0
        ? 'a run is executing'
        : 'a run is waiting'
  return {
    running: work.counts.running,
    waiting: work.counts.waiting,
    awaitingApproval: work.counts.awaitingApproval,
    label,
  }
}

/**
 * Build one presence frame from Core projections.
 *
 * The only constructor of a presence frame. A renderer never builds a frame
 * itself; it receives one from the host and draws it.
 */
export function buildPresenceFrame(input: PresenceInput, stateSince: number): PresenceFrame {
  const state = derivePresenceState(input)
  const attention = input.attention?.directive ?? null
  const personalityCue = input.personality?.presenceCue ?? null
  const work = deriveWorkSummary(input.work)

  return {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    state,
    animation: PRESENCE_STATE_ANIMATION[state],
    stateSince,
    detail: presenceDetail(state, input),
    voiceCapture: {
      active: input.voice?.capturing ?? false,
      available: input.voice?.transcription.available ?? false,
      sessionId: input.voice?.sessionId ?? null,
    },
    voiceSynthesis: {
      active: input.synthesisActive,
      available: input.voice?.synthesis.available ?? false,
      label: null,
    },
    attention,
    personalityCue,
    work,
    sequence: input.sequence,
  }
}

/**
 * A short human line for each presence state.
 *
 * Never a mental-state claim. "Standing by" is a fact about what Freya is
 * doing; "feeling curious" would be a claim about what Freya is, and Core
 * cannot know that.
 */
function presenceDetail(state: PresenceProtocolState, input: PresenceInput): string {
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
      return input.work !== null && input.work.counts.awaitingApproval > 0
        ? 'Waiting on your decision.'
        : 'Working.'
    case 'attention':
      return 'Something needs you.'
    case 'error':
      return input.core?.stopAll.active
        ? 'Stopped. Every model request is refused.'
        : 'Something failed. Review the system panel.'
    case 'degraded':
      return 'Core is degraded. A subsystem has faulted.'
  }
}

/**
 * The animation for a presence state.
 *
 * Fixed by the protocol. A renderer may not choose a different animation for
 * a state.
 */
export function presenceAnimation(state: PresenceProtocolState): PresenceAnimation {
  return PRESENCE_STATE_ANIMATION[state]
}

/**
 * Whether a presence state transition is legal.
 *
 * Delegates to the protocol's transition table. A renderer may not invent a
 * transition.
 */
export function canTransitionPresenceState(
  from: PresenceProtocolState,
  to: PresenceProtocolState,
): boolean {
  if (from === to) return true
  return canTransitionPresence(from, to)
}

export type { AttentionDirectiveView, PersonalityCueView }
