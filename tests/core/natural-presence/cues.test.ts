// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  deriveEmbodimentCues,
  emptyEmbodimentCueList,
  PHASE26_PRESENCE_LIMITS,
  type CueInputs,
} from '../../../core/natural-presence'

const NOW = '2026-10-01T12:00:00.000Z'

function inputs(over: Partial<CueInputs> = {}): CueInputs {
  return {
    attention: null,
    work: null,
    voiceCaptureActive: false,
    voiceSynthesisActive: false,
    personalityCueActive: false,
    now: NOW,
    ...over,
  }
}

function types(over: Partial<CueInputs>): string[] {
  return deriveEmbodimentCues(inputs(over)).cues.map((cue) => cue.cueType)
}

describe('cue derivation', () => {
  it('cue.attention-urgent: an urgent attention directive', () => {
    expect(types({ attention: { present: true, importance: 'urgent' } })).toContain('attention-urgent')
  })

  it('cue.attention-normal: a normal attention directive', () => {
    expect(types({ attention: { present: true, importance: 'normal' } })).toContain('attention-normal')
  })

  it('cue.work-running: a running run', () => {
    expect(types({ work: { running: 1, waiting: 0, awaitingApproval: 0 } })).toContain('work-running')
  })

  it('cue.work-waiting: a waiting run', () => {
    expect(types({ work: { running: 0, waiting: 1, awaitingApproval: 0 } })).toContain('work-waiting')
  })

  it('cue.work-approval: a run awaiting approval', () => {
    expect(types({ work: { running: 0, waiting: 0, awaitingApproval: 1 } })).toContain('work-approval')
  })

  it('cue.voice-listening: voice capture active', () => {
    expect(types({ voiceCaptureActive: true })).toContain('voice-listening')
  })

  it('cue.voice-speaking: voice synthesis active', () => {
    expect(types({ voiceSynthesisActive: true })).toContain('voice-speaking')
  })

  it('cue.personality-cue: a personality cue is active', () => {
    expect(types({ personalityCueActive: true })).toContain('personality-cue')
  })

  it('derivation is deterministic and ordered', () => {
    const first = deriveEmbodimentCues(
      inputs({
        attention: { present: true, importance: 'urgent' },
        work: { running: 1, waiting: 1, awaitingApproval: 1 },
        voiceCaptureActive: true,
        personalityCueActive: true,
      }),
    )
    const second = deriveEmbodimentCues(
      inputs({
        attention: { present: true, importance: 'urgent' },
        work: { running: 1, waiting: 1, awaitingApproval: 1 },
        voiceCaptureActive: true,
        personalityCueActive: true,
      }),
    )
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.cues.map((c) => c.cueType)).toEqual([
      'attention-urgent',
      'work-approval',
      'work-running',
      'work-waiting',
      'voice-listening',
      'personality-cue',
    ])
  })
})

describe('cue lifecycle', () => {
  it('cue.deactivation: no source means no cue', () => {
    expect(deriveEmbodimentCues(inputs()).cues).toEqual([])
  })

  it('STOP ALL deactivates every cue', () => {
    const cues = deriveEmbodimentCues(
      inputs({ attention: { present: true, importance: 'urgent' }, voiceCaptureActive: true }),
      true,
    )
    expect(cues.cues).toEqual([])
  })

  it('cue.bounded: the list never exceeds 8', () => {
    const list = deriveEmbodimentCues(
      inputs({
        attention: { present: true, importance: 'urgent' },
        work: { running: 1, waiting: 1, awaitingApproval: 1 },
        voiceCaptureActive: true,
        voiceSynthesisActive: true,
        personalityCueActive: true,
      }),
    )
    expect(list.cues.length).toBeLessThanOrEqual(PHASE26_PRESENCE_LIMITS.maxEmbodimentCues)
    expect(list.maxEntries).toBe(PHASE26_PRESENCE_LIMITS.maxEmbodimentCues)
  })

  it('emptyEmbodimentCueList is bounded and empty', () => {
    expect(emptyEmbodimentCueList().cues).toEqual([])
    expect(emptyEmbodimentCueList().maxEntries).toBe(PHASE26_PRESENCE_LIMITS.maxEmbodimentCues)
  })
})
