import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABSENT_PERSONALITY_PROJECTION,
  NO_PERSONALITY_DOMAIN_REASON,
  type PersonalityProjection,
} from '../../core/protocol/personality'
import { projectPersonality } from '../../core/personality/projection'
import {
  createPersonalityMirror,
  personalityMirror,
  resetPersonalityMirror,
} from '../../src/platform/personalityClient'

/**
 * The renderer's Personality mirror.
 *
 * The properties worth a test are the boundary ones, and this lane's are
 * sharper than Workforce's because there is no command behind it at all:
 *
 *  1. It holds what Core pushed and cannot write any of it.
 *  2. Its one read takes **no arguments** — there is no second parameter in
 *     which a preference, a confidence or a cue could travel — and it never
 *     reaches for `coreSubmit`, which this lane does not use.
 *  3. It exposes no method that records, admits, forgets or chooses a cue, so
 *     a caller asking for one gets a missing method rather than a refusal it
 *     could learn to phrase differently.
 */

function projection(sequence = 3): PersonalityProjection {
  return projectPersonality({
    sequence,
    temperament: null,
    items: [],
    interpretation: null,
    expression: null,
    ledger: null,
  })
}

let coreSubmit: ReturnType<typeof vi.fn>
let corePersonality: ReturnType<typeof vi.fn>
let handlers: Set<(projection: PersonalityProjection) => void>

function push(projection: PersonalityProjection): void {
  for (const handler of [...handlers]) handler(projection)
}

beforeEach(() => {
  resetPersonalityMirror()
  handlers = new Set()
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: false }))
  corePersonality = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    corePersonality: corePersonality as never,
    onCorePersonality: ((next: (p: PersonalityProjection) => void) => {
      handlers.add(next)
      return () => {
        handlers.delete(next)
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetPersonalityMirror()
  delete window.freyaHost
})

describe('a mirror that holds only what Core sent', () => {
  it('is absent before anything has reported', () => {
    const mirror = createPersonalityMirror()
    expect(mirror.projection).toBeNull()
    const seen: (PersonalityProjection | null)[] = []
    mirror.subscribe((value) => seen.push(value))
    expect(seen).toEqual([null])
  })

  it('reads once and then follows pushes', async () => {
    const mirror = createPersonalityMirror()
    await mirror.attach()
    expect(corePersonality).toHaveBeenCalledTimes(1)
    expect(mirror.projection?.sequence).toBe(3)

    // A push overwrites wholesale — the renderer does not merge, because a
    // merged projection would be a second author of the same truth.
    push(projection(4))
    expect(mirror.projection?.sequence).toBe(4)
  })

  it('stays absent when the bridge throws instead of inventing a relationship', async () => {
    corePersonality.mockImplementation(async () => {
      throw new Error('no core')
    })
    const mirror = createPersonalityMirror()
    await mirror.attach()
    expect(mirror.projection).toBeNull()
    expect(mirror.projection?.items).toBeUndefined()
  })

  it('publishes Core’s absent projection when the host has no Core yet', async () => {
    corePersonality.mockImplementation(async () => null)
    const mirror = createPersonalityMirror()
    await mirror.attach()
    expect(mirror.projection?.health).toBe('unavailable')
    expect(mirror.projection?.reason).toBe('Core has not reported a Personality yet')
    expect(mirror.projection?.items).toEqual([])
  })

  it('repeats Core’s no-domain sentence without softening it', async () => {
    corePersonality.mockImplementation(async () => ({
      ...ABSENT_PERSONALITY_PROJECTION,
      reason: NO_PERSONALITY_DOMAIN_REASON,
    }))
    const mirror = createPersonalityMirror()
    await mirror.attach()
    expect(mirror.projection?.reason).toBe(NO_PERSONALITY_DOMAIN_REASON)
    expect(mirror.projection?.health).toBe('unavailable')
    // Not upgraded to a ready, empty record: "no relationship" and "no
    // domain" are different sentences and this mirror may not pick one.
    expect(mirror.projection?.health).not.toBe('ready')
  })

  it('carries no relationship record of its own', async () => {
    const mirror = createPersonalityMirror()
    await mirror.attach()
    // Whatever Core reports, the mirror repeats it: no local habit,
    // preference or inside joke is ever appended to fill a view in.
    expect(mirror.projection?.items).toEqual([])
    expect(mirror.projection?.counts.items).toBe(0)
  })

  it('stops publishing after reset', async () => {
    const mirror = personalityMirror()
    await mirror.attach()
    expect(mirror.projection).not.toBeNull()
    mirror.reset()
    expect(mirror.projection).toBeNull()
    expect(handlers.size).toBe(0)
  })

  it('keeps two attached components from unsubscribing each other', async () => {
    const mirror = createPersonalityMirror()
    const disposeA = await mirror.attach()
    const disposeB = await mirror.attach()
    expect(handlers.size).toBe(2)

    // The Personality window unmounting must not stop the status bar's cue
    // from following Core, whichever order the two unmount in.
    disposeA()
    expect(handlers.size).toBe(1)
    push(projection(9))
    expect(mirror.projection?.sequence).toBe(9)
    disposeB()
    expect(handlers.size).toBe(0)
  })

  it('does not let a late pull overwrite a newer push', async () => {
    const mirror = createPersonalityMirror()
    // A pull that resolves after a push arrived must not write an older Core
    // truth over a newer one.
    corePersonality.mockImplementation(async () => projection(99))
    await mirror.attach()
    push(projection(10))
    await mirror.read()
    expect(mirror.projection?.sequence).toBe(10)
  })
})

describe('the one read this lane makes', () => {
  it('takes no arguments at all, and submits no command', async () => {
    const mirror = personalityMirror()
    const outcome = await mirror.read()

    expect(outcome).toEqual({ operation: 'status', ok: true })
    // Zero arguments. There is no second argument carrying a key, a
    // confidence, a cue or a provenance — there is no second argument.
    expect(corePersonality.mock.calls[0]).toEqual([])
    expect(coreSubmit).not.toHaveBeenCalled()
  })

  it('resolves with a sentence when Core cannot be reached, rather than rejecting', async () => {
    corePersonality.mockImplementation(async () => {
      throw new Error('window reloaded')
    })
    const outcome = await personalityMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toContain('could not be reached')
  })

  it('resolves with a sentence when there is no bridge at all', async () => {
    delete window.freyaHost
    const outcome = await personalityMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/not available in this window/)
  })

  it('exposes no method that could record, admit, forget or choose a cue', () => {
    const mirror = personalityMirror()
    // The whole surface of the client: a getter, two reads and two pieces of
    // subscription plumbing. There is no `record`, no `admit`, no `forget`,
    // no `chooseCue` and no `submit` to be refused, because none exists.
    expect(Object.keys(mirror).sort()).toEqual([
      'attach',
      'projection',
      'read',
      'reset',
      'subscribe',
    ])
    expect(Object.keys(mirror).some((key) => /record|admit|forget|choose|submit|write/i.test(key))).toBe(
      false,
    )
    expect(mirror).not.toHaveProperty('record')
    expect(mirror).not.toHaveProperty('chooseCue')
  })

  it('never routes a command through this file at all', async () => {
    const mirror = personalityMirror()
    await mirror.attach()
    await mirror.read()
    // The lane's privilege is the pull and the subscription. `coreSubmit` was
    // placed on the bridge precisely so its absence of calls is observable.
    expect(coreSubmit).not.toHaveBeenCalled()
    expect(corePersonality).toHaveBeenCalled()
  })
})
