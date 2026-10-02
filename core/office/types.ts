import type { CoreStatus } from '../protocol/core-protocol'
import type { WorkProjection } from '../work/projection'
import type { WorkforceProjection } from '../workforce/types'

/**
 * THE OFFICE DOMAIN.
 *
 * A truthful spatial projection of real Work/Workforce/Core state. The Office is
 * not a simulation, a game board or a decorative dashboard: it is a read-only
 * view of what Core actually owns, arranged in space so a person can see the
 * whole picture at a glance.
 *
 * ## The one rule this file exists to protect
 *
 * > **Nothing in the Office is invented.** A station exists because a real Run,
 * > worker, approval or piece of history exists in Core. A station's state is
 * > the real state of the thing it represents. There is no idle animation, no
 * > fake progress, no phantom worker and no decorative activity.
 *
 * ## What crosses, and what deliberately does not
 *
 * Crosses: ids, statuses, kinds, counts, measured lengths, instants, closed
 * labels, and the deterministic layout positions derived from them.
 *
 * Does **not** cross:
 *
 * - **Step input, observation contents, message bodies, task titles, mission
 *   text.** The Office shows structure and state, never substance. A station
 *   says "this run is running and 2 of 3 steps verified"; it does not say what
 *   the steps were given or what they returned.
 * - **Any authority object, capability instance or policy.** The Office is a
 *   viewer. It has no method that grants, decides, cancels or redirects, and
 *   the projection has no field a renderer could write.
 * - **Any model call.** The Office is a pure function of Core state. It cannot
 *   reach a provider, and no code path here can be made to.
 *
 * ## Spatial zones
 *
 * The office is divided into zones, each with a closed vocabulary of what may
 * appear there:
 *
 * ```
 *   freya      Freya's own station — always present, shows her real Core state
 *   floor      Live runs — one station per non-terminal Run, capped
 *   workforce  Workers — one station per worker with real state, capped
 *   approvals  Pending approvals — one station per open request, capped
 *   history    Settled runs — a timeline of journaled metadata, capped
 * ```
 *
 * A zone is a region of the office floor with a deterministic grid. Stations
 * are placed in the order Core reports them, so the same state always produces
 * the same layout on every machine and every launch.
 */

/* --------------------------------------------------------------- zones */

/**
 * The spatial zones of the office.
 *
 * A closed vocabulary rather than free text, because a zone is a region of the
 * floor with a fixed grid and a fixed ceiling. A string would let a caller
 * describe a zone the layout has no region for.
 */
export const OFFICE_ZONES = ['freya', 'floor', 'workforce', 'approvals', 'history'] as const
export type OfficeZone = (typeof OFFICE_ZONES)[number]

export function isOfficeZone(value: unknown): value is OfficeZone {
  return typeof value === 'string' && (OFFICE_ZONES as readonly string[]).includes(value)
}

/* --------------------------------------------------------- station kinds */

/**
 * What a station represents.
 *
 * Closed, and each kind maps to exactly one Core domain: `freya` to CoreStatus,
 * `run` to a Work Run, `worker` to a Workforce worker, `approval` to a Work
 * approval. There is no `mission` kind because a Mission is not a thing that
 * sits in the office — it is an outcome, and its Runs are what execute.
 */
export const OFFICE_STATION_KINDS = ['freya', 'run', 'worker', 'approval'] as const
export type OfficeStationKind = (typeof OFFICE_STATION_KINDS)[number]

/* ------------------------------------------------------- presence states */

/**
 * What a station is doing, as the Office may show it.
 *
 * A closed vocabulary of *real* states. There is no `animating`, no `typing`,
 * no `thinking` and no `collaborating` — those would be invented activity. A
 * station is `working` only when the underlying Core state says something is
 * actually executing, and `idle` when it is not.
 *
 * `freya` stations use the same vocabulary so the whole office reads in one
 * language: Freya is `working` when a model request is in flight or a Run is
 * live, `idle` when she is not, `locked` when STOP ALL or a Governor refusal
 * is active, and `error` when the journal is corrupt or Core is degraded.
 */
export const OFFICE_PRESENCE_STATES = [
  'working',
  'idle',
  'waiting',
  'blocked',
  'locked',
  'error',
] as const
export type OfficePresenceState = (typeof OFFICE_PRESENCE_STATES)[number]

/* -------------------------------------------------------------- reasons */

/**
 * Why a station is in the state it is, in Core's own words.
 *
 * Closed codes, for the reason every other subsystem uses them: a free-text
 * reason in a projection is a place for a thrown exception's message to end up
 * on screen, and the Office is the most user-facing surface in the system.
 */
export const OFFICE_REASONS = Object.freeze({
  workingRun: 'a run is executing',
  workingModel: 'a model request is in flight',
  workingAssignment: 'a worker holds an open assignment',
  idle: 'nothing is executing',
  waitingApproval: 'waiting for your approval',
  waitingExternal: 'waiting for an external condition',
  waitingQueued: 'queued, waiting to start',
  blocked: 'suspended by the owner',
  stopped: 'stopped',
  retired: 'retired',
  lockedStopAll: 'STOP ALL is latched',
  lockedGovernor: 'the Governor is refusing every request',
  errorJournal: 'the event journal is corrupt',
  errorDegraded: 'Core is degraded',
  unavailable: 'Core has not reported yet',
} as const)

export type OfficeReason = (typeof OFFICE_REASONS)[keyof typeof OFFICE_REASONS]

/* ---------------------------------------------------------------- limits */

/**
 * The ceilings of the Office.
 *
 * Code-owned and unraisable. The Office is a spatial view with a bounded number
 * of stations, and a ceiling that could be raised would be a ceiling that
 * eventually produces a floor plan nobody can read. A caller may narrow these
 * and may never raise them.
 */
export const OFFICE_LIMITS = Object.freeze({
  /** Live run stations shown on the floor. */
  maxFloorStations: 8,
  /** Worker stations shown in the workforce area. */
  maxWorkforceStations: 12,
  /** Pending approval stations shown in the approvals area. */
  maxApprovalStations: 6,
  /** History entries shown in the timeline. */
  maxHistoryEntries: 20,
  /** Presence requests held at once. */
  maxPresenceRequests: 8,
  /** Characters in a station label. */
  maxLabelChars: 64,
  /** Characters in a station detail sentence. */
  maxDetailChars: 200,
})

const OFFICE_LIMIT_NAMES: readonly (keyof typeof OFFICE_LIMITS)[] = [
  'maxFloorStations',
  'maxWorkforceStations',
  'maxApprovalStations',
  'maxHistoryEntries',
  'maxPresenceRequests',
  'maxLabelChars',
  'maxDetailChars',
]

/** Apply caller-narrowed ceilings. Narrow only; a raise is refused, not clamped. */
export function officeLimits(
  overrides: Partial<Record<keyof typeof OFFICE_LIMITS, number>> = {},
): Readonly<Record<keyof typeof OFFICE_LIMITS, number>> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('office limits are malformed')
  }
  const merged: Record<string, number> = { ...OFFICE_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!OFFICE_LIMIT_NAMES.includes(key as keyof typeof OFFICE_LIMITS)) {
      throw new Error(`unknown office limit: ${key}`)
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`office limit ${key} is not a positive integer`)
    }
    if (value > OFFICE_LIMITS[key as keyof typeof OFFICE_LIMITS]) {
      throw new Error(`office limit ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as Record<keyof typeof OFFICE_LIMITS, number>)
}

/* -------------------------------------------------------------- geometry */

/**
 * A position on the office floor, in virtual units.
 *
 * The office floor is a fixed virtual space (1000 x 620 units). The renderer
 * scales it to fit the window, so a station's position is resolution-independent
 * and deterministic: the same state always produces the same layout.
 */
export interface OfficePosition {
  readonly x: number
  readonly y: number
}

/** The virtual dimensions of the office floor. */
export const OFFICE_FLOOR = Object.freeze({ width: 1000, height: 620 })

/** The size of one station cell, in virtual units. */
export const OFFICE_CELL = Object.freeze({ width: 120, height: 96 })

/** The gap between station cells, in virtual units. */
export const OFFICE_GAP = 16

/* -------------------------------------------------------------- stations */

/**
 * One station on the office floor.
 *
 * A station is a spatial representation of one real thing Core owns. It carries
 * the thing's id, its real state, and a deterministic position. It carries no
 * substance: no input, no content, no authority.
 */
export interface OfficeStation {
  readonly stationId: string
  readonly kind: OfficeStationKind
  readonly zone: OfficeZone
  /** The id of the underlying Core entity: runId, workerId, approvalId, or 'freya'. */
  readonly entityId: string
  /** A bounded label. Core's own word for the thing, never free text. */
  readonly label: string
  readonly state: OfficePresenceState
  /** Why it is in that state, as a closed code. */
  readonly reason: OfficeReason
  readonly position: OfficePosition
  /** One bounded sentence a person can read. Never content. */
  readonly detail: string
  /** The underlying status, for a drill-down panel. */
  readonly status: string
  /** Structural counts, for a drill-down panel. Never a fabricated percentage. */
  readonly counts: {
    readonly stepsTotal: number
    readonly stepsSettled: number
    readonly stepsVerified: number
    readonly stepsFailed: number
    readonly actions: number
    readonly attempts: number
  }
  /** Whether this station's thing is live in this process. */
  readonly live: boolean
  /** For runs: the current step's key, if one is running. */
  readonly activeStepKey: string | null
  /** For workers: how many open assignments they hold. */
  readonly openAssignments: number
  /** For approvals: the capability that asked and the risk. */
  readonly approval: {
    readonly capability: string
    readonly risk: string
    readonly requiredCapability: string
  } | null
}

/* -------------------------------------------------------------- history */

/**
 * One entry in the office history timeline.
 *
 * Journaled, verified metadata only. A history entry says what ran, when, how
 * it ended and whether it verified — never what it was given or what it
 * returned. The label is the run's kind and status, which are Core's own
 * words.
 */
export interface OfficeHistoryEntry {
  readonly entryId: string
  readonly runId: string
  readonly kind: string
  readonly status: string
  readonly createdAt: string
  readonly settledAt: string | null
  /** Structural progress, never a fabricated percentage. */
  readonly stepsTotal: number
  readonly stepsVerified: number
  readonly stepsFailed: number
  /** The durable sequence this came from, so a row can be traced to the log. */
  readonly sequence: number
}

/* ------------------------------------------------------ presence requests */

/**
 * A request that an agent join the desktop Presence.
 *
 * Bounded and Core-owned. The request carries a workerId and nothing else: no
 * principal, no authority, no capability, no expression. Core validates the
 * worker exists, journals the request as metadata, and the Office reports it as
 * pending. Whether and how the agent actually appears on the desktop is a
 * Presence concern (Phase 13), not the Office's — the Office can ask, and it
 * can show that it asked, and it can do nothing else.
 */
export interface OfficePresenceRequest {
  readonly workerId: string
  readonly requestedAt: string
  /** Whether this request has been answered by a Presence implementation. */
  readonly fulfilled: boolean
}

/* ------------------------------------------------------------- projection */

/**
 * The Office projection.
 *
 * The whole of what a window may know about the Office. It is a pure function
 * of Core's Work, Workforce and status projections plus the bounded set of
 * presence requests, so the same call serves the live view and any test.
 */
export interface OfficeProjection {
  /**
   * `unavailable` before Core has reported, `ready` once it has.
   *
   * Stated rather than implied, because "the office is empty" and "Core is not
   * up" render the same otherwise and they are very different things.
   */
  readonly health: 'unavailable' | 'ready'
  readonly reason: string | null
  /** Freya's station. Always present, even when Core is unavailable. */
  readonly freya: OfficeStation | null
  /** The stations on the floor, in deterministic order. */
  readonly stations: readonly OfficeStation[]
  /** The history timeline, newest first, capped. */
  readonly history: readonly OfficeHistoryEntry[]
  /** Pending presence requests, capped. */
  readonly presenceRequests: readonly OfficePresenceRequest[]
  readonly counts: {
    readonly runs: number
    readonly runsLive: number
    readonly workers: number
    readonly workersByIdle: number
    readonly workersWorking: number
    readonly workersBlocked: number
    readonly workersStopped: number
    readonly workersRetired: number
    readonly approvalsPending: number
    readonly floorStationsShown: number
    readonly floorStationsHidden: number
    readonly workforceStationsShown: number
    readonly workforceStationsHidden: number
    readonly approvalStationsShown: number
    readonly approvalStationsHidden: number
    readonly historyShown: number
    readonly historyHidden: number
  }
  /** The highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/** The inputs the Office projection is derived from. */
export interface OfficeProjectionInput {
  readonly work: WorkProjection | null
  readonly workforce: WorkforceProjection | null
  readonly core: CoreStatus | null
  readonly presenceRequests: readonly OfficePresenceRequest[]
}

export type { CoreStatus, WorkProjection, WorkforceProjection }
