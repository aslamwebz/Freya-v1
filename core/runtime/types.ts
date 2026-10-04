/**
 * Runtime Activation (Phase 40) — the closed vocabularies.
 *
 * The whole lane hangs off one sentence:
 *
 * > Implemented is not available, and available is not active.
 *
 * A domain that exists in this repository has to be able to say, deterministically,
 * which of those it is, why, and what dependency would have to be satisfied before
 * it could move. Nothing here adds intelligence or permission; this is registration,
 * dependency checking, lifecycle ownership and honest status.
 *
 * Data only: no clock, no journal, no port, no `node:` import.
 */

/** The closed status vocabulary. Every domain is in exactly one of these. */
export const RUNTIME_STATUSES = [
  /** The module exists in the tree, but is not in the registry. */
  'implemented',
  /** In the registry, not yet evaluated against a fact set. */
  'registered',
  /** Every declared activation dependency is satisfied; it may be activated. */
  'available',
  /** Activated and running under this Core. */
  'active',
  /** Activated, but operating with a reduced capability whose reason is stated. */
  'degraded',
  /** A required dependency is missing, or a gate forbids activation. */
  'blocked',
  /** Deliberately turned off. Nothing in this phase sets this; it exists so a
   *  future host can be explicit rather than merely absent. */
  'disabled',
] as const

export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number]

/** The statuses that mean "this domain is not running". */
export const INACTIVE_RUNTIME_STATUSES: readonly RuntimeStatus[] = Object.freeze([
  'implemented',
  'registered',
  'available',
  'blocked',
  'disabled',
])

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return typeof value === 'string' && (RUNTIME_STATUSES as readonly string[]).includes(value)
}

/**
 * The closed dependency vocabulary.
 *
 * Each kind names one thing a domain may require before it can activate. The
 * point is not that every domain needs all of them; it is that a domain cannot
 * require something this list does not name, so "what does this need?" is a
 * question with a finite, auditable answer.
 */
export const RUNTIME_DEPENDENCY_KINDS = [
  /** The durable event journal is open and trustworthy. */
  'journal',
  /** A host-supplied adapter for this domain is present (browser, voice, ...). */
  'host-adapter',
  /** The one encrypted Vault is open. */
  'vault',
  /** A keyring secret for the named domain is present. */
  'keyring',
  /** At least one real model provider is configured. */
  'provider',
  /** An owner approval has been granted for the named subject. */
  'owner-approval',
  /** An active capability grant exists. */
  'capability-grant',
  /** A trusted, enrolled device exists. */
  'trusted-device',
  /** A network transport for device sync exists. */
  'transport',
  /** An external connector adapter is configured. */
  'external-connector',
  /** Budgeted units remain for this domain's bounded work. */
  'budget',
  /** A policy object is present for this domain. */
  'policy',
  /** A dedicated recovery journal seam is satisfied. */
  'recovery-journal',
  /** The long-horizon continuation subsystem is wired. */
  'continuation',
  /** A durable content store for this domain is open. */
  'store',
] as const

export type RuntimeDependencyKind = (typeof RUNTIME_DEPENDENCY_KINDS)[number]

export function isRuntimeDependencyKind(value: unknown): value is RuntimeDependencyKind {
  return typeof value === 'string' && (RUNTIME_DEPENDENCY_KINDS as readonly string[]).includes(value)
}

/** How a domain is allowed to move from available to active. */
export const RUNTIME_ACTIVATION_MODES = [
  /** Built and owned by Core's own composition root; activation is construction. */
  'core-owned',
  /** May be activated by the controller when every requirement is satisfied. */
  'activatable',
  /** Registered but never activated in this phase; a later phase must wire it. */
  'blocked',
  /** Fail-closed: no configuration in this phase may activate it. */
  'fail-closed',
] as const

export type RuntimeActivationMode = (typeof RUNTIME_ACTIVATION_MODES)[number]

/** Where a domain came from, for grouping and reporting. */
export const RUNTIME_DOMAIN_KINDS = ['core-owned', 'phase-runtime', 'framework', 'spine'] as const
export type RuntimeDomainKind = (typeof RUNTIME_DOMAIN_KINDS)[number]

/** The major runtime families named by the phase. */
export const RUNTIME_FAMILIES = [
  'mission-work',
  'mind-persona',
  'world-life',
  'memory-security',
  'long-horizon',
  'economic',
  'enterprise',
  'multi-device',
  'device-hands',
  'resilience',
  'sovereignty',
  'evolution',
  'threshold',
] as const

export type RuntimeFamily = (typeof RUNTIME_FAMILIES)[number]

/**
 * One thing a domain requires before activation.
 *
 * `degradeOnly` marks a dependency whose absence lowers the domain to `degraded`
 * rather than `blocked`: a connector-less Relay is still a running Relay, and
 * saying otherwise would overstate the failure.
 */
export interface RuntimeDependencyRequirement {
  readonly kind: RuntimeDependencyKind
  /** A sub-key, e.g. a keyring domain or a host-adapter name. Null when N/A. */
  readonly key: string | null
  readonly label: string
  /** When true, absence blocks activation. When false, absence degrades it. */
  readonly required: boolean
}

/** The measured answer to one requirement. */
export interface RuntimeDependencyEvidence {
  readonly kind: RuntimeDependencyKind
  readonly key: string | null
  readonly label: string
  readonly required: boolean
  readonly satisfied: boolean
  /** A sentence a person can read. Never a secret. */
  readonly detail: string
}

/** A canonical registry entry. */
export interface RuntimeDomainDescriptor {
  /** Stable, namespaced id, e.g. `core.missions`. */
  readonly id: string
  readonly family: RuntimeFamily
  /** A human title. */
  readonly title: string
  /** The repository path that implements it. */
  readonly module: string
  readonly kind: RuntimeDomainKind
  readonly activation: RuntimeActivationMode
  readonly requirements: readonly RuntimeDependencyRequirement[]
  /** Deterministic activation order. Lower starts first, higher stops first. */
  readonly order: number
  /** Why this domain is in the state it is, when that is not obvious. */
  readonly note: string
}

/**
 * The live facts the controller evaluates dependencies against.
 *
 * This is deliberately a plain data snapshot rather than a set of callbacks: the
 * controller can be tested with a hand-written fact set, and a domain can never
 * pull a fact it was not handed.
 */
export interface RuntimeFacts {
  /** Core's own lifecycle at the instant of evaluation. */
  readonly coreLifecycle: string
  readonly journalTrustworthy: boolean
  readonly stopAllActive: boolean
  readonly vaultOpen: boolean
  /** Keyring domains whose secret is present, e.g. 'conversation', 'brain'. */
  readonly keyringKeys: readonly string[]
  readonly providerConfigured: boolean
  readonly providerCount: number
  /** Host adapter names present, e.g. 'research', 'relay', 'voice', 'window'. */
  readonly hostAdapters: readonly string[]
  /** External connector names present, e.g. 'email', 'calendar', 'github'. */
  readonly connectors: readonly string[]
  /** Owner approval subjects granted. */
  readonly ownerApprovals: readonly string[]
  /** Capability names with an active grant. */
  readonly capabilityGrants: readonly string[]
  readonly trustedDevices: number
  readonly transportAvailable: boolean
  readonly budgetRemainingUnits: number
  readonly policyPresent: boolean
  /** Whether a dedicated recovery-journal seam is satisfied. */
  readonly recoveryJournalReady: boolean
  /** Whether the long-horizon continuation subsystem is wired. */
  readonly continuationReady: boolean
}

/** A domain's journaled state. */
export interface RuntimeDomainState {
  readonly id: string
  readonly status: RuntimeStatus
  readonly reason: string
  /** Labels of the requirements that are not satisfied. */
  readonly missing: readonly string[]
  readonly evidence: readonly RuntimeDependencyEvidence[]
  readonly requestedAt: string | null
  readonly decidedAt: string | null
  readonly activatedAt: string | null
  readonly changedAt: string | null
  /** The last decision outcome, for the "last activation result" question. */
  readonly lastOutcome: 'allowed' | 'blocked' | 'stopped' | 'reconciled' | null
}

/** One domain, as a reader sees it. */
export interface RuntimeDomainView {
  readonly id: string
  readonly family: RuntimeFamily
  readonly title: string
  readonly module: string
  readonly kind: RuntimeDomainKind
  readonly activation: RuntimeActivationMode
  readonly status: RuntimeStatus
  readonly reason: string
  readonly missing: readonly string[]
  readonly evidence: readonly RuntimeDependencyEvidence[]
  readonly activatedAt: string | null
  readonly changedAt: string | null
  readonly lastOutcome: RuntimeDomainState['lastOutcome']
  readonly note: string
}

export const RUNTIME_LIFECYCLES = ['unstarted', 'evaluating', 'active', 'stopped-all', 'stopped'] as const
export type RuntimeLifecycle = (typeof RUNTIME_LIFECYCLES)[number]

/** The whole status projection a diagnostics surface reads. */
export interface RuntimeProjection {
  readonly lifecycle: RuntimeLifecycle
  readonly generatedAt: string
  readonly stopAllActive: boolean
  readonly counts: Readonly<Record<RuntimeStatus, number>>
  readonly domains: readonly RuntimeDomainView[]
  /** Ids of domains that are active or degraded. */
  readonly active: readonly string[]
  readonly blocked: readonly { readonly id: string; readonly reason: string; readonly missing: readonly string[] }[]
  readonly degraded: readonly { readonly id: string; readonly reason: string }[]
  readonly lastStopReason: string | null
  readonly lastReconciledAt: string | null
  readonly recoveredDomains: readonly string[]
}

/** The durable journal entry the controller folds. */
export interface RuntimeJournalEntry {
  readonly sequence: number
  readonly type: RuntimeEventType
  readonly payload: RuntimePayload
  readonly recordedAt: string
}

export type RuntimePayload = Readonly<Record<string, string | number | boolean | null | readonly string[]>>

export const RUNTIME_EVENT_TYPES = [
  'runtime.activation.decided',
  'runtime.activation.changed',
  'runtime.activation.stopped',
  'runtime.activation.reconciled',
] as const

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number]

/** The fold's state, derived only from `runtime.*` journal entries. */
export interface RuntimeFoldState {
  readonly lastSequence: number
  readonly domains: ReadonlyMap<string, RuntimeDomainState>
  readonly stopAllLatched: boolean
  readonly lastStopReason: string | null
  readonly lastReconciledAt: string | null
  readonly recoveredDomains: readonly string[]
}

export const EMPTY_COUNTS: Readonly<Record<RuntimeStatus, number>> = Object.freeze({
  implemented: 0,
  registered: 0,
  available: 0,
  active: 0,
  degraded: 0,
  blocked: 0,
  disabled: 0,
})
