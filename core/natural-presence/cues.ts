/**
 * THE EMBODIMENT CUES — derived from real Core state, never invented.
 *
 * A cue is a projection of what Core knows: an attention directive, a work
 * count, a voice capture/synthesis status, a personality cue. It is not a
 * claim about what Freya is. The cue types are code-owned; a renderer may not
 * invent one, and the active list is bounded.
 */

import {
  EMBODIMENT_CUE_LABELS,
  PHASE26_PRESENCE_LIMITS,
  type EmbodimentCue,
  type EmbodimentCueList,
  type EmbodimentCueType,
} from './types'

/** The attention fact a cue may be derived from. */
export interface CueAttention {
  readonly present: boolean
  readonly importance: 'urgent' | 'normal'
}

/** The work counts a cue may be derived from. */
export interface CueWork {
  readonly running: number
  readonly waiting: number
  readonly awaitingApproval: number
}

/** Everything cue derivation reads. All facts Core holds. */
export interface CueInputs {
  readonly attention: CueAttention | null
  readonly work: CueWork | null
  readonly voiceCaptureActive: boolean
  readonly voiceSynthesisActive: boolean
  readonly personalityCueActive: boolean
  readonly now: string
}

/** An empty, bounded cue list. */
export function emptyEmbodimentCueList(): EmbodimentCueList {
  return { cues: [], maxEntries: PHASE26_PRESENCE_LIMITS.maxEmbodimentCues }
}

function cue(type: EmbodimentCueType, derivedFrom: string, now: string): EmbodimentCue {
  return {
    cueType: type,
    label: EMBODIMENT_CUE_LABELS[type].slice(0, PHASE26_PRESENCE_LIMITS.maxCueLabelChars),
    derivedFrom,
    active: true,
    activatedAt: now,
  }
}

/**
 * Derive the active embodiment cues from Core facts.
 *
 * Deterministic and ordered: attention, then work, then voice, then
 * personality. The result is bounded to the cue ceiling; a cue that would
 * exceed the bound is refused, not added. If STOP ALL is active, no cues are
 * derived at all: a stopped Core expresses nothing.
 */
export function deriveEmbodimentCues(inputs: CueInputs, stopAllActive = false): EmbodimentCueList {
  if (stopAllActive) return emptyEmbodimentCueList()

  const derived: EmbodimentCue[] = []

  if (inputs.attention !== null && inputs.attention.present) {
    derived.push(
      cue(
        inputs.attention.importance === 'urgent' ? 'attention-urgent' : 'attention-normal',
        'attention',
        inputs.now,
      ),
    )
  }

  const work = inputs.work
  if (work !== null) {
    if (work.awaitingApproval > 0) derived.push(cue('work-approval', 'work', inputs.now))
    if (work.running > 0) derived.push(cue('work-running', 'work', inputs.now))
    if (work.waiting > 0) derived.push(cue('work-waiting', 'work', inputs.now))
  }

  if (inputs.voiceCaptureActive) derived.push(cue('voice-listening', 'voice', inputs.now))
  if (inputs.voiceSynthesisActive) derived.push(cue('voice-speaking', 'voice', inputs.now))
  if (inputs.personalityCueActive) derived.push(cue('personality-cue', 'personality', inputs.now))

  const maxEntries = PHASE26_PRESENCE_LIMITS.maxEmbodimentCues
  const cues = derived.length > maxEntries ? derived.slice(0, maxEntries) : derived
  return { cues, maxEntries }
}
