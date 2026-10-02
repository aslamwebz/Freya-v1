import type {
  ActiveWindowAvailability,
  ActiveWindowInfo,
  ActiveWindowProvider,
  ActiveWindowReading,
  WindowObservationReach,
} from '../../../../core/context/sources/window'

/**
 * THE DETERMINISTIC FAKE OBSERVATION PROVIDER.
 *
 * Every acceptance claim in this lane — "disabled does nothing", "stale
 * window state expires", "zero model calls while idle", "an invalid reading
 * cannot corrupt the source" — is measured against this object's counters:
 * it remembers every call the source made, scripts readings in a fixed
 * order, and fails on demand. It has no clock and no threads: whatever
 * happens is what the test made happen.
 */

export interface FakeActiveWindowProviderOptions {
  readonly providerId?: string
  readonly reach?: WindowObservationReach
  readonly availability?: ActiveWindowAvailability
}

export class FakeActiveWindowProvider implements ActiveWindowProvider {
  readonly providerId: string
  readonly reach: WindowObservationReach

  availabilityState: ActiveWindowAvailability
  throwOnAvailability = false
  readonly calls = { availability: 0, reads: 0, subscribe: 0, unsubscribe: 0 }

  private readonly script: (ActiveWindowReading | Error)[] = []
  private listeners: ((reading: ActiveWindowReading) => void)[] = []
  private counter = 0

  constructor(options: FakeActiveWindowProviderOptions = {}) {
    this.providerId = options.providerId ?? 'fake-window'
    this.reach = options.reach ?? 'system'
    this.availabilityState = options.availability ?? 'ready'
  }

  availability(): ActiveWindowAvailability {
    this.calls.availability += 1
    if (this.throwOnAvailability) throw new Error('fake availability exploded')
    return this.availabilityState
  }

  read(): ActiveWindowReading {
    this.calls.reads += 1
    if (this.script.length > 0) {
      const next = this.script.shift()
      if (next instanceof Error) throw next
      if (next !== undefined) return next
    }
    return this.unavailableReading('fake provider: script exhausted')
  }

  subscribe(listener: (reading: ActiveWindowReading) => void): () => void {
    this.calls.subscribe += 1
    this.listeners.push(listener)
    return () => {
      this.calls.unsubscribe += 1
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /** Push an event to the subscribed source, as a focus-change provider would. */
  emit(reading: ActiveWindowReading): void {
    for (const listener of [...this.listeners]) listener(reading)
  }

  /* ------------------------------------------------------------- scripting */

  /** Queue the next `window` of this fake's script. */
  queue(info: ActiveWindowInfo): void {
    this.script.push({ availability: 'ready', window: info, reason: null })
  }

  queueReading(reading: ActiveWindowReading): void {
    this.script.push(reading)
  }

  queueThrow(message: string): void {
    this.script.push(new Error(message))
  }

  /* ------------------------------------------------------------- builders */

  info(
    appName: string,
    windowTitle: string | null,
    observedAt: string,
    overrides: Partial<ActiveWindowInfo> = {},
  ): ActiveWindowInfo {
    this.counter += 1
    return {
      providerId: this.providerId,
      observationId: `obs-${String(this.counter).padStart(4, '0')}`,
      observedAt,
      reach: this.reach,
      appName,
      appIdentifier: null,
      windowTitle,
      isFullscreen: false,
      ...overrides,
    }
  }

  unavailableReading(reason = 'fake provider: nothing in front'): ActiveWindowReading {
    return { availability: 'unavailable', window: null, reason }
  }
}

/** A provider without the optional event half, for cadence tests. */
export function pollingOnly(provider: FakeActiveWindowProvider): ActiveWindowProvider {
  return {
    providerId: provider.providerId,
    reach: provider.reach,
    availability: () => provider.availability(),
    read: () => provider.read(),
  }
}
