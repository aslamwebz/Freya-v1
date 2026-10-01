// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import {
  WindowObservationService,
  WINDOW_OBSERVATION_LIMITS,
  createUnsupportedProvider,
  type ActiveWindowInfo,
  type ActiveWindowProvider,
  type WindowTimer,
} from '../../../../core/context/sources/window'
import { T0, at } from '../fixture'
import { FakeActiveWindowProvider, pollingOnly } from './fakeProvider'

/**
 * THE OBSERVATION SOURCE, MEASURED AGAINST A FAKE PROVIDER.
 *
 * Every acceptance claim of issue #30 lands in counters here: a disabled
 * source reads nothing, an unavailable or unsupported provider is *reported*
 * rather than worked around, a stale observation expires to a hard null, one
 * window held across many polls is one observation, and nothing on this path
 * can await — which is the same thing as saying nothing on this path can call
 * a model. The clock is mutable and the provider is scripted; whatever
 * happens is what the test made happen.
 */

/* The single mutable clock every service in this file reads. */
let clockNow: Date = T0
function setClock(instant: Date): void {
  clockNow = instant
}
beforeEach(() => {
  clockNow = T0
})
function makeClock(): () => Date {
  return () => clockNow
}

function front(
  provider: FakeActiveWindowProvider,
  appName: string,
  windowTitle: string | null = null,
  overrides: Partial<ActiveWindowInfo> = {},
): void {
  provider.queue(
    provider.info(appName, windowTitle, clockNow.toISOString(), overrides),
  )
}

function serviceFor(
  provider: ActiveWindowProvider,
  overrides: {
    cadenceMs?: number | null
    ttlMs?: number | null
    timer?: WindowTimer | null
    onObservation?: (observation: ActiveWindowInfo) => void
  } = {},
): WindowObservationService {
  clockNow = T0
  return new WindowObservationService({
    provider,
    clock: makeClock(),
    timer: null,
    ...overrides,
  })
}

interface FakeTimer extends WindowTimer {
  readonly requests: number[]
  cancelCount: number
  fire(): void
}

function fakeTimer(): FakeTimer {
  const timer: FakeTimer = {
    requests: [],
    cancelCount: 0,
    fire: () => undefined,
    schedule(run, everyMs) {
      timer.requests.push(everyMs)
      timer.fire = run
      return () => {
        timer.cancelCount += 1
      }
    },
  }
  return timer
}

describe('a disabled source does nothing', () => {
  it('never touches the provider before start', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider)
    service.poll()
    service.poll()
    expect(service.status()).toBe('disabled')
    expect(service.current()).toBeNull()
    expect(provider.calls).toEqual({ availability: 0, reads: 0, subscribe: 0, unsubscribe: 0 })
    expect(service.stats()).toMatchObject({ started: false, polls: 0, readings: 0, emitted: 0 })
  })

  it('holds nothing after stop, and unwinds the provider', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider)
    front(provider, 'Editor', 'notes.md')
    expect(service.start()).toBe('observed')
    expect(service.current()).not.toBeNull()
    expect(service.stop()).toBe('disabled')
    expect(service.current()).toBeNull()
    expect(service.status()).toBe('disabled')
    expect(provider.calls.unsubscribe).toBe(1)
    provider.queueReading(provider.unavailableReading())
    service.poll()
    expect(provider.calls.reads).toBe(1)
  })

  it('starting a started source changes nothing', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider)
    service.start()
    service.start()
    expect(provider.calls.subscribe).toBe(1)
  })

  it('the snapshot is state, not words', () => {
    const provider = new FakeActiveWindowProvider()
    front(provider, 'Editor', 'notes.md')
    const service = serviceFor(provider, { ttlMs: 60_000 })
    expect(service.snapshot().status).toBe('disabled')
    expect(service.snapshot().lastObservedAt).toBeNull()
    service.start()
    const snap = service.snapshot(at(10_000))
    expect(snap).toMatchObject({
      started: true,
      status: 'observed',
      providerId: 'fake-window',
      ttlMs: 60_000,
    })
    expect(snap.lastObservedAt).toBe(T0.toISOString())
    expect(JSON.stringify(snap)).not.toMatch(/notes\.md|Editor/)
  })
})

describe('truthful provider states', () => {
  it('an unsupported provider is answered before anything is read', () => {
    const provider = createUnsupportedProvider({
      providerId: 'os-foreground',
      reach: 'system',
      reason: 'no native foreground source in this build',
    })
    const service = serviceFor(provider)
    expect(service.start()).toBe('unsupported')
    service.poll()
    service.poll()
    expect(service.status()).toBe('unsupported')
    expect(service.current()).toBeNull()
    expect(service.stats()).toMatchObject({ started: false, readings: 0, emitted: 0 })
  })

  it('an unavailable provider opens the lane but is never read', () => {
    const provider = new FakeActiveWindowProvider({ availability: 'unavailable' })
    const service = serviceFor(provider)
    expect(service.start()).toBe('unavailable')
    expect(provider.calls.reads).toBe(0)
    provider.availabilityState = 'ready'
    front(provider, 'Editor', 'notes.md')
    service.poll()
    expect(service.status()).toBe('observed')
    expect(provider.calls.reads).toBe(1)
  })

  it('unsupported discovered mid-run halts the lane instead of retrying a cannot', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider)
    front(provider, 'Editor', 'notes.md')
    service.start()
    provider.availabilityState = 'unsupported'
    service.poll()
    expect(service.status()).toBe('unsupported')
    expect(service.current()).toBeNull()
    expect(provider.calls.unsubscribe).toBe(1)
    provider.availabilityState = 'ready'
    service.poll()
    expect(provider.calls.reads).toBe(1)
  })

  it('a provider that throws is reported unavailable, then trusted again when it recovers', () => {
    const provider = new FakeActiveWindowProvider()
    provider.throwOnAvailability = true
    const service = serviceFor(provider)
    expect(service.start()).toBe('unavailable')
    provider.throwOnAvailability = false
    front(provider, 'Editor', 'notes.md')
    service.poll()
    expect(service.status()).toBe('observed')
    expect(service.stats().failures).toBe(1)
  })

  it('a throwing read keeps the last honest observation rather than a guess', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider, { ttlMs: WINDOW_OBSERVATION_LIMITS.maxTtlMs })
    front(provider, 'Editor', 'notes.md')
    service.start()
    provider.queueThrow('the display server blinked')
    service.poll()
    expect(service.status()).toBe('unavailable')
    expect(service.current()?.appName).toBe('Editor')
    front(provider, 'Editor', 'notes.md')
    service.poll()
    expect(service.status()).toBe('observed')
  })
})

describe('bounded cadence and event subscription', () => {
  it('a cadence request is clamped to the lane floor and ceiling', () => {
    const provider = new FakeActiveWindowProvider()
    expect(serviceFor(pollingOnly(provider), { cadenceMs: 1 }).cadenceMs).toBe(
      WINDOW_OBSERVATION_LIMITS.minCadenceMs,
    )
    expect(serviceFor(pollingOnly(provider), { cadenceMs: 10 ** 9 }).cadenceMs).toBe(
      WINDOW_OBSERVATION_LIMITS.maxCadenceMs,
    )
    expect(serviceFor(pollingOnly(provider), { cadenceMs: 0 }).cadenceMs).toBe(0)
  })

  it('an event-capable provider defaults to events only', () => {
    const provider = new FakeActiveWindowProvider()
    expect(serviceFor(provider).cadenceMs).toBe(0)
  })

  it('a polling provider only ever wakes on the host-supplied timer', () => {
    const base = new FakeActiveWindowProvider()
    const timer = fakeTimer()
    front(base, 'Editor', 'notes.md')
    const service = new WindowObservationService({
      provider: pollingOnly(base),
      clock: makeClock(),
      cadenceMs: 30_000,
      timer,
    })
    service.start()
    expect(service.cadenceMs).toBe(30_000)
    expect(timer.requests).toEqual([30_000])
    expect(base.calls.reads).toBe(1)
    front(base, 'Browser', 'Search')
    timer.fire()
    expect(base.calls.reads).toBe(2)
    service.stop()
    expect(timer.cancelCount).toBe(1)
  })

  it('without a timer the lane never self-schedules; the host drives polls', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, { onObservation: (info) => seen.push(info) })
    service.start()
    front(provider, 'Editor', 'notes.md')
    service.poll()
    expect(seen).toHaveLength(1)
  })

  it('one window across many polls is one observation', () => {
    const provider = new FakeActiveWindowProvider()
    let emissions = 0
    const service = serviceFor(provider, {
      ttlMs: WINDOW_OBSERVATION_LIMITS.maxTtlMs,
      onObservation: () => {
        emissions += 1
      },
    })
    front(provider, 'Editor', 'notes.md')
    service.start()
    front(provider, 'Editor', 'notes.md')
    service.poll()
    front(provider, 'Editor', 'notes.md')
    service.poll()
    expect(emissions).toBe(1)
    expect(service.stats()).toMatchObject({ readings: 3, emitted: 1 })
  })

  it('a changed window is a new span and fires again', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, {
      ttlMs: WINDOW_OBSERVATION_LIMITS.maxTtlMs,
      onObservation: (info) => seen.push(info),
    })
    front(provider, 'Editor', 'notes.md')
    service.start()
    front(provider, 'Browser', 'Search')
    service.poll()
    expect(seen.map((info) => info.appName)).toEqual(['Editor', 'Browser'])
    expect(service.stats().emitted).toBe(2)
  })

  it('an event reading drives the lane with no poll at all', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, { onObservation: (info) => seen.push(info) })
    service.start()
    provider.emit({ availability: 'ready', window: provider.info('Editor', 'notes.md', clockNow.toISOString()), reason: null })
    expect(seen).toHaveLength(1)
  })

  it('a focus hole is not an event: a null reading ages the hold by TTL only', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider, { ttlMs: 60_000 })
    front(provider, 'Editor', 'notes.md')
    service.start()
    provider.queueReading(provider.unavailableReading())
    service.poll(at(30_000))
    expect(service.current(at(30_000))).not.toBeNull()
    service.poll(at(60_000))
    expect(service.current(at(60_000))).toBeNull()
    expect(service.status(at(60_000))).toBe('stale')
  })
})

describe('stale window state expires', () => {
  it('the TTL boundary turns observed into stale and drops the strings', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider, { ttlMs: 60_000 })
    front(provider, 'Editor', 'notes.md')
    service.start()
    expect(service.current(at(59_999))).not.toBeNull()
    expect(service.current(at(60_000))).toBeNull()
    expect(service.status(at(60_000))).toBe('stale')
    expect(service.stats().expired).toBe(1)
  })

  it('the same window after expiry is a new observation, not a resurrection', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, {
      ttlMs: 60_000,
      onObservation: (info) => seen.push(info),
    })
    front(provider, 'Editor', 'notes.md')
    service.start()
    service.poll(at(60_000))
    setClock(at(61_000))
    front(provider, 'Editor', 'notes.md')
    const before = seen.length
    service.poll()
    expect(seen.length).toBe(before + 1)
    const last = seen[seen.length - 1]
    expect(last?.observationId).not.toBe(seen[0]?.observationId)
  })

  it('a refresh while current keeps one span alive and emits nothing new', () => {
    const provider = new FakeActiveWindowProvider()
    let emissions = 0
    const service = serviceFor(provider, {
      ttlMs: 60_000,
      onObservation: () => {
        emissions += 1
      },
    })
    front(provider, 'Editor', 'notes.md')
    service.start()
    setClock(at(50_000))
    provider.queue(provider.info('Editor', 'notes.md', at(50_000).toISOString()))
    service.poll()
    expect(emissions).toBe(1)
    expect(service.current(at(109_999))).not.toBeNull()
    expect(service.current(at(110_000))).toBeNull()
  })

  it('a reading that was already stale when it arrived is dropped, not emitted', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, {
      ttlMs: 60_000,
      onObservation: (info) => seen.push(info),
    })
    service.start()
    provider.queue(provider.info('Editor', 'notes.md', T0.toISOString()))
    service.poll(at(5 * 60_000))
    expect(seen).toHaveLength(0)
    expect(service.current(at(5 * 60_000))).toBeNull()
  })

  it('an unusable clock judges nothing and destroys nothing', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider, { ttlMs: 60_000 })
    front(provider, 'Editor', 'notes.md')
    service.start()
    expect(service.current(new Date(Number.NaN))).toBeNull()
    expect(service.current(at(30_000))).not.toBeNull()
  })
})

describe('a dishonest provider cannot corrupt the source', () => {
  it('drops a reading reported under somebody else’s name', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider)
    service.start()
    provider.queue(provider.info('Editor', 'notes.md', clockNow.toISOString(), { providerId: 'someone-else' }))
    service.poll()
    expect(service.current()).toBeNull()
    expect(service.stats().dropped).toBe(1)
  })

  it('drops a reading with no app name and one with an unreachable reach', () => {
    const provider = new FakeActiveWindowProvider()
    const service = serviceFor(provider)
    service.start()
    provider.queue(provider.info('   ', null, clockNow.toISOString()))
    service.poll()
    provider.queue(provider.info('Editor', null, clockNow.toISOString(), { reach: 'everything' as never }))
    service.poll()
    expect(service.stats()).toMatchObject({ dropped: 2, emitted: 0 })
    expect(service.current()).toBeNull()
  })

  it('scrubs control characters, collapses whitespace, and bounds the title', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, { onObservation: (info) => seen.push(info) })
    service.start()
    provider.queue(
      provider.info('Ter\u0000minal', `evil\u0000title\nwith   spaces  ${'— and a long tail. '.repeat(12)}`, clockNow.toISOString()),
    )
    service.poll()
    const held = seen[0]
    if (held === undefined) throw new Error('expected the cleaned observation to be emitted')
    expect(held.appName).toBe('Ter minal')
    const title = held.windowTitle ?? ''
    expect(title).not.toMatch(/\p{Cc}/u)
    expect(title).not.toMatch(/ {2}/u)
    expect(title.startsWith('evil title with spaces')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(WINDOW_OBSERVATION_LIMITS.maxTitleChars)
  })

  it('pins a future claimed instant to the read instant instead of trusting it', () => {
    const provider = new FakeActiveWindowProvider()
    const seen: ActiveWindowInfo[] = []
    const service = serviceFor(provider, { onObservation: (info) => seen.push(info) })
    service.start()
    provider.queue(provider.info('Editor', 'notes.md', at(10 * 60_000).toISOString()))
    service.poll()
    expect(seen[0]?.observedAt).toBe(T0.toISOString())
  })
})
