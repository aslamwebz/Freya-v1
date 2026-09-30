import type { CoreStatus, ModelUsage, ProviderStatus } from '../../core/protocol/core-protocol'
import type { PresenceState } from './presence'

/**
 * The desktop projection.
 *
 * One function, no React, no state. Every fact the shell shows about the system
 * is derived here from things that actually happened — Core's own status, the
 * durable events Core published, and the handful of local facts the shell is
 * genuinely authoritative about (is the microphone on, which rail is collapsed).
 *
 * It exists because the alternative was already visible in the shell: each panel
 * subscribed to Core, interpreted the raw fields for itself, and quietly
 * disagreed. Four panels each deciding what `governor.status: 'deny_all'` means
 * is three chances to be wrong and no single place to check the answer.
 *
 * Two rules this module keeps, because they are the ones that are easy to lose:
 *
 * - **Nothing here invents work.** If no subsystem has anything running, the
 *   projection says so in words. There is no placeholder mission, no agent at
 *   rest, no activity that did not happen.
 * - **Nothing here guesses a total.** A usage figure with unknown calls in it is
 *   presented as a lower bound, never as an exact number, because the number is
 *   real but it is not the whole number.
 */

/** How loudly something wants the user's attention. */
export type AttentionLevel = 'none' | 'low' | 'normal' | 'high' | 'urgent'

/** A status line. `tone` is presentation; `detail` is the sentence beneath it. */
export interface StatusFact {
  id: string
  label: string
  value: string
  detail: string
  tone: 'ok' | 'info' | 'warn' | 'bad'
}

export interface ProviderFact {
  id: string
  name: string
  model: string | null
  /** Human wording. A configured provider with no key is not "ready". */
  state: string
  live: boolean
  tone: 'ok' | 'info' | 'warn' | 'bad'
  detail: string
}

export interface UsageFact {
  /** How the known token figure must be read. Drives the label, not just a note. */
  exact: boolean
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  unknownUsageCalls: number
  /** "142 known · at least 3 unaccounted" style, ready to render. */
  label: string
}

/**
 * An activity row, in the shape the projection hands to the UI.
 *
 * Structurally identical to the protocol type it comes from; it exists so the
 * UI depends on the projection layer and not on the Core wire format.
 */
export interface ActivityFact {
  id: string
  /** What happened, in plain words. Never contains command text. */
  text: string
  at: number
  tone: 'neutral' | 'good' | 'busy' | 'warn' | 'bad'
  /** The durable sequence this came from, so a row can be traced to the log. */
  sequence: number
}

/** A thing that genuinely needs a decision or a repair from the person. */
export interface AttentionItem {
  id: string
  title: string
  detail: string
  severity: 'critical' | 'decision'
  /** A surface that can resolve it, when there is one. */
  action?: { label: string; surface: string }
}

/**
 * What the shell is actually doing.
 *
 * Deliberately empty, and that is the honest state rather than a gap. Phase 2
 * has no work subsystem: nothing is running, nothing is queued, and nothing
 * should be invented to fill this.
 */
export interface WorkFact {
  active: number
  empty: boolean
  summary: string
  detail: string
}

export interface DesktopProjection {
  /** The single derived presence state. Never stored in parallel elsewhere. */
  presence: PresenceState
  presenceDetail: string
  attention: AttentionLevel
  /** The system/attention status rows, in reading order. */
  system: StatusFact[]
  /**
   * Active cognition grants, as a number.
   *
   * A number rather than something parsed back out of the Governor row's
   * sentence: a panel that has to regex prose to render a count breaks the moment
   * the wording improves.
   */
  grantsActive: number
  providers: ProviderFact[]
  /** Session and durable usage, separately. They are not the same number. */
  usage: { session: UsageFact; durable: UsageFact }
  activity: ActivityFact[]
  attentionItems: AttentionItem[]
  work: WorkFact
  /** One sentence for the whole system, for the header. */
  headline: string
  /** True when Core has said anything at all. Drives "connecting" vs facts. */
  corePresent: boolean
}

export interface ProjectionInput {
  /** Core's own projection, or null before it has ever reported. */
  core: CoreStatus | null
  activity: ActivityFact[]
  /**
   * Local facts the shell is authoritative about. `listening` is only ever true
   * because a person pressed the microphone control in this window.
   */
  listening: boolean
  /**
   * Real provider work in flight, counted from durable events.
   *
   * This is the *only* thing that can justify a `working` presence. It is zero
   * while Freya is idle, which is why idle Freya cannot look busy.
   */
  inFlightProviderCalls: number
  now: number
}

const NEUTRAL: StatusFact['tone'] = 'info'

/** The provider requests Core has started and not yet finished answering. */
export function countInFlightProviderCalls(activity: ActivityFact[]): number {
  let started = 0
  for (const item of activity) {
    if (item.id.startsWith('model.request.started:')) started += 1
    else if (
      item.id.startsWith('model.request.completed:') ||
      item.id.startsWith('model.request.failed:')
    ) {
      started -= 1
    }
  }
  return started < 0 ? 0 : started
}

/**
 * Presence, derived.
 *
 * Ordered by how much the condition matters, not by how likely it is. A journal
 * that cannot be trusted outranks a microphone that is switched on, because the
 * whole point of failing closed is that other signals do not soften it.
 *
 * `thinking` and `working` are reachable *only* from real in-flight provider
 * work. There is no other door into them, which is why a submitted command
 * cannot put Freya into `working`: recording a command is not doing work.
 */
export function derivePresence(input: ProjectionInput): {
  state: PresenceState
  detail: string
} {
  const { core, listening, inFlightProviderCalls } = input

  if (core === null) {
    return { state: 'idle', detail: 'Starting Freya.' }
  }

  if (core.integrity.integrity === 'corrupt' || core.lifecycle === 'degraded') {
    return {
      state: 'error',
      detail:
        core.integrity.integrity === 'corrupt'
          ? 'The event journal is corrupt. Cognition is refused until it is dealt with.'
          : 'Core is degraded. Review the journal and the system panel.',
    }
  }

  if (core.stopAll.active) {
    return { state: 'locked', detail: 'Stopped. Every model request is refused.' }
  }

  // Refusing for any reason other than STOP ALL still means Freya cannot act.
  if (core.governor.status === 'deny_all') {
    return { state: 'locked', detail: 'The Governor is refusing every request.' }
  }

  if (core.lifecycle === 'booting') {
    return { state: 'idle', detail: 'Core is starting.' }
  }

  if (listening) {
    return { state: 'listening', detail: 'Microphone open.' }
  }

  if (inFlightProviderCalls > 0) {
    return { state: 'working', detail: 'A model request is in flight.' }
  }

  return { state: 'idle', detail: 'Standing by.' }
}

/**
 * Attention, derived.
 *
 * Deliberately not a count of notifications. It is the highest severity of the
 * things that genuinely need a person, because a badge that counts "things that
 * happened" is a badge that gets ignored, and one that counts "things you must
 * look at" is not.
 */
export function deriveAttention(items: AttentionItem[], core: CoreStatus | null): AttentionLevel {
  if (items.some((item) => item.severity === 'critical')) return 'urgent'
  if (items.some((item) => item.severity === 'decision')) return 'high'
  if (core !== null && core.providers.some((provider) => provider.status === 'faulted')) {
    return 'normal'
  }
  if (core === null) return 'normal'
  return 'none'
}

function fact(
  id: string,
  label: string,
  value: string,
  detail: string,
  tone: StatusFact['tone'] = NEUTRAL,
): StatusFact {
  return { id, label, value, detail, tone }
}

function providerFact(provider: ProviderStatus): ProviderFact {
  // A provider that is configured but has no key is not ready, and saying
  // "ready" there would be the most reassuring possible lie in this window.
  const missingKey = provider.status === 'configured' && !provider.liveEnabled
  // Every ProviderStatusKind is named, so the shell cannot fall through to a
  // raw enum value and show "unconfigured" to a person as though it were a
  // status word.
  const state =
    provider.status === 'configured'
      ? missingKey
        ? 'no key'
        : 'live'
      : provider.status === 'faulted'
        ? 'faulted'
        : provider.status === 'unconfigured'
          ? 'no API key'
          : provider.status === 'disabled'
            ? 'disabled'
            : provider.status

  const tone: ProviderFact['tone'] =
    provider.status === 'faulted'
      ? 'bad'
      : provider.status === 'disabled'
        ? 'bad'
        : provider.status === 'unconfigured' || missingKey
          ? 'warn'
          : provider.liveEnabled
            ? 'ok'
            : NEUTRAL

  return {
    id: provider.id,
    name: provider.id,
    model: provider.model,
    state,
    live: provider.liveEnabled,
    tone,
    detail: provider.detail || (missingKey ? 'No API key is configured.' : ''),
  }
}

/**
 * Usage, presented honestly.
 *
 * The exactness flag is not decoration: a caller must be able to see at a glance
 * that a figure is a floor and not a total, without reading a tooltip.
 */
export function usageFact(usage: ModelUsage): UsageFact {
  const exact = usage.unknownUsageCalls === 0
  const knownInput = usage.inputTokens
  const knownOutput = usage.outputTokens

  const knownTotal =
    knownInput === null && knownOutput === null
      ? null
      : (knownInput ?? 0) + (knownOutput ?? 0)

  const label = exact
    ? knownTotal === null
      ? `${usage.calls} calls · nothing reported`
      : `${usage.calls} calls · ${knownTotal.toLocaleString()} tokens reported`
    : `${usage.calls} calls · at least ${(knownTotal ?? 0).toLocaleString()} tokens · ${usage.unknownUsageCalls} unaccounted`

  return {
    exact,
    calls: usage.calls,
    inputTokens: knownInput,
    outputTokens: knownOutput,
    unknownUsageCalls: usage.unknownUsageCalls,
    label,
  }
}

/** The system rows. Human wording first; the raw values live in Security. */
export function systemFacts(core: CoreStatus | null): StatusFact[] {
  if (core === null) {
    return [fact('core', 'Core', 'connecting', 'No status has arrived from Core yet.', 'warn')]
  }

  const facts: StatusFact[] = [
    fact(
      'core',
      'Core',
      core.lifecycle === 'ready' ? 'Ready' : core.lifecycle === 'degraded' ? 'Degraded' : 'Booting',
      core.coreStartedAt
        ? `Running since ${new Date(core.coreStartedAt).toLocaleTimeString()} · event ${core.eventSequence}`
        : 'Core has not reported a start time yet.',
      core.lifecycle === 'ready' ? 'ok' : core.lifecycle === 'degraded' ? 'bad' : 'warn',
    ),
  ]

  facts.push(
    fact(
      'security',
      'Security',
      core.stopAll.active ? 'Stopped' : 'Running',
      core.stopAll.active
        ? 'Every model request is refused. Resume from Security.'
        : 'Guard is deny-by-default and STOP ALL is not latched.',
      core.stopAll.active ? 'bad' : 'ok',
    ),
  )

  const integrity = core.integrity
  facts.push(
    fact(
      'journal',
      'Journal',
      integrity.integrity === 'ok'
        ? 'Healthy'
        : integrity.integrity === 'torn'
          ? 'Recovered a torn write'
          : 'Integrity fault',
      integrity.integrity === 'ok'
        ? `${integrity.eventsRead} events read in full.`
        : integrity.integrity === 'torn'
          ? `A torn final write dropped ${integrity.bytesDiscarded} bytes. The rest of the log is intact.`
          : `${integrity.reason}. Cognition stays refused until this is dealt with.`,
      integrity.integrity === 'ok' ? 'ok' : integrity.integrity === 'torn' ? 'warn' : 'bad',
    ),
  )

  facts.push(
    fact(
      'governor',
      'Governor',
      core.governor.status === 'ready'
        ? core.governor.grantsActive > 0
          ? `${core.governor.grantsActive} grant${core.governor.grantsActive === 1 ? '' : 's'} active`
          : 'Allowing explicit user turns'
        : core.governor.status === 'deny_all'
          ? 'Refusing everything'
          : 'No answer yet',
      core.governor.status === 'deny_all'
        ? 'No request can be authorised, whatever the reason.'
        : `${core.governor.grantsActive} active grant${core.governor.grantsActive === 1 ? '' : 's'}.`,
      core.governor.status === 'ready'
        ? 'ok'
        : core.governor.status === 'deny_all'
          ? 'bad'
          : 'warn',
    ),
  )

  // Value and sentence are derived together, so they cannot disagree — which is
  // how "No API key" once appeared beside a sentence about being unable to call
  // a provider.
  const live = core.providers.filter((provider) => provider.liveEnabled)
  const unreachable = core.providers.filter(
    (provider) => provider.status === 'disabled' || provider.status === 'faulted',
  )
  const models: Pick<StatusFact, 'value' | 'detail'> =
    core.providers.length === 0
      ? {
          value: 'No provider',
          detail: 'No model provider is registered, so no model call can be made.',
        }
      : live.length > 0
        ? {
            value: live.length === 1 ? 'Live' : `${live.length} live`,
            detail: 'A provider is registered and configured.',
          }
        : unreachable.length > 0
          ? {
              value: 'Unavailable',
              detail:
                'A provider is registered but reports itself unusable, so no model request would succeed.',
            }
          : {
              value: 'No API key',
              detail:
                'A provider is registered but has no API key, so any model request would be refused.',
            }
  facts.push(fact('models', 'Models', models.value, models.detail, live.length > 0 ? 'ok' : 'warn'))

  return facts
}

function attentionItems(core: CoreStatus | null): AttentionItem[] {
  if (core === null) return []
  const items: AttentionItem[] = []

  if (core.integrity.integrity === 'corrupt') {
    items.push({
      id: 'integrity',
      title: 'Event journal is corrupt',
      detail:
        'Freya cannot vouch for its own history, so every model request is refused and it stays that way across restarts. The damaged bytes are quarantined beside the log.',
      severity: 'critical',
      action: { label: 'Open Security', surface: 'security' },
    })
  }

  if (core.stopAll.active) {
    items.push({
      id: 'stop-all',
      title: 'Freya is stopped',
      detail: 'Every model request is refused. Resuming needs two deliberate presses in Security.',
      severity: 'decision',
      action: { label: 'Open Security', surface: 'security' },
    })
  }

  const faulted = core.providers.filter((provider) => provider.status === 'faulted')
  for (const provider of faulted) {
    items.push({
      id: `provider:${provider.id}`,
      title: `${provider.id} is faulted`,
      detail: provider.detail || 'The provider reported that it cannot be used.',
      severity: 'decision',
    })
  }

  if (core.faults.length > 0 && !core.stopAll.active && core.integrity.integrity !== 'corrupt') {
    items.push({
      id: 'faults',
      title: 'Core reported a fault',
      detail: core.faults[0] ?? 'Core reported a fault.',
      severity: 'decision',
      action: { label: 'Open Security', surface: 'security' },
    })
  }

  return items
}

/**
 * The projection.
 *
 * Pure and deterministic given the same input: no clocks beyond the `now` passed
 * in, no randomness, no reading of globals. That is what lets it be tested
 * against a table of cases instead of being eyeballed in a window.
 */
export function projectDesktop(input: ProjectionInput): DesktopProjection {
  const core = input.core
  const presence = derivePresence(input)
  const items = attentionItems(core)
  const attention = deriveAttention(items, core)

  const work: WorkFact = {
    active: 0,
    empty: true,
    summary: 'No active work',
    detail:
      'No subsystem has work in flight. Freya acts when you ask it to, and does nothing on its own.',
  }

  const system = systemFacts(core)

  const headline =
    core === null
      ? 'Connecting to Core'
      : presence.state === 'error'
        ? 'Needs attention'
        : presence.state === 'locked'
          ? core.stopAll.active
            ? 'Stopped'
            : 'Locked'
          : presence.state === 'working'
            ? 'Working'
            : 'Standing by'

  return {
    presence: presence.state,
    presenceDetail: presence.detail,
    attention,
    system,
    grantsActive: core?.governor.grantsActive ?? 0,
    providers: (core?.providers ?? []).map(providerFact),
    usage: {
      session: usageFact(
        core?.sessionUsage ?? { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
      ),
      durable: usageFact(
        core?.durableUsage ?? { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
      ),
    },
    activity: input.activity,
    attentionItems: items,
    work,
    headline,
    corePresent: core !== null,
  }
}
