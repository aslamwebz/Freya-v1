import { degradedRequirements, evaluateRequirements, missingRequirements } from '../runtime/dependencies'
import { orderedRegistry } from '../runtime/registry'
import { STOP_ALL_EXEMPT_DOMAIN } from '../runtime/controller'
import type {
  RuntimeDependencyEvidence,
  RuntimeDomainDescriptor,
  RuntimeFacts,
  RuntimeProjection,
  RuntimeStatus,
} from '../runtime/types'
import {
  EMPTY_READINESS_COUNTS,
  type ReadinessEvidence,
  type ReadinessState,
} from './types'

/**
 * The capability inventory.
 *
 * Where Phase 40 asks "which of *this Core's* domains is running right now", this
 * asks the release question: *what does this build actually contain, and what
 * condition is each thing in?* The answer is derived from the one registry the
 * runtime already owns rather than a second hand-written list, because two lists
 * is how a release report starts lying.
 *
 * The derivation is deliberately a pure function of a descriptor plus a fact set
 * plus a supplied statement of what is physically present. It holds no clock, reads
 * no disk and starts nothing. Whoever has the facts — the qualification runner, a
 * test, a diagnostics surface — supplies them and gets the same answer every time.
 *
 * The precedence is fixed and stated rather than emergent:
 *
 *   1. Not in this build              -> `unavailable`
 *   2. Declared fail-closed            -> `blocked`
 *   3. STOP ALL latched               -> `blocked`
 *   4. A required dependency is absent -> `blocked`
 *   5. Declared blocked                -> `blocked`
 *   6. Core-owned and Core is not up   -> `blocked`
 *   7. Core-owned with a reduction     -> `degraded`
 *   8. Core-owned, all satisfied       -> `active`
 *   9. Activatable with a handler      -> `active`
 *  10. Activatable, dependencies met   -> `available`
 *
 * Steps 2 to 10 are the runtime controller's own precedence, reproduced against the
 * same requirements and the same exemption. That is not duplication by accident: the
 * inventory has to answer without a journal, and the controller has to answer
 * without a filesystem. `tests/qualification/agreement.test.ts` derives both across a
 * matrix of fact sets and fails the build if they ever disagree, so neither can drift
 * into being the more flattering of the two.
 */

/** What the caller knows about this build and this machine. */
export interface InventoryInput {
  /** The live facts, evaluated against. Required: an absent fact set has no answer. */
  readonly facts: RuntimeFacts
  /**
   * Ids whose implementation is physically present in this build.
   *
   * The runner checks the disk; a test writes the list by hand. A domain missing
   * from this list is `unavailable`, which is the whole point: a module that was
   * never in the tree cannot be reported as merely idle.
   */
  readonly presentModules?: readonly string[]
  /** Ids with an activation handler wired in this build. */
  readonly wiredHandlers?: readonly string[]
  /** Override the latch, so the inventory can describe a stop that is not in the facts. */
  readonly stopAllActive?: boolean
  /** Extra evidence per id: test suites, host seams, external tools, gate ids. */
  readonly evidence?: Readonly<Record<string, readonly ReadinessEvidence[]>>
  /** A subset of registry ids, for a report about one family. */
  readonly only?: readonly string[]
}

/** One capability as a release reader sees it. */
export interface CapabilityRecord {
  readonly id: string
  readonly family: RuntimeDomainDescriptor['family']
  readonly title: string
  /** The repository path or paths that implement it. Never resolved here. */
  readonly module: string
  readonly activation: RuntimeDomainDescriptor['activation']
  readonly readiness: ReadinessState
  /** A sentence explaining the state. Never a secret, never a metric. */
  readonly reason: string
  /** Labels of the required dependencies that are not satisfied. */
  readonly missing: readonly string[]
  /** Labels of the optional dependencies that are not satisfied. */
  readonly reduced: readonly string[]
  readonly dependencyEvidence: readonly RuntimeDependencyEvidence[]
  readonly evidence: readonly ReadinessEvidence[]
  readonly note: RuntimeDomainDescriptor['note']
}

/** The whole inventory, with the counts a summary line reads from. */
export interface CapabilityInventory {
  readonly counts: Readonly<Record<ReadinessState, number>>
  readonly capabilities: readonly CapabilityRecord[]
  /** Ids that are running in some form: `active` or `degraded`. */
  readonly running: readonly string[]
  /** Ids whose dependencies are met but which nothing started. */
  readonly available: readonly string[]
  readonly blocked: readonly CapabilityRecord[]
  readonly degraded: readonly CapabilityRecord[]
  readonly unavailable: readonly CapabilityRecord[]
  /** Every registry id, so a report can prove it did not quietly drop one. */
  readonly ids: readonly string[]
}

function setOf(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(values ?? [])
}

/**
 * Derive one capability's readiness.
 *
 * Pure. The only inputs are the descriptor, the caller's facts and the caller's
 * statement of what is present.
 */
export function capabilityReadiness(
  descriptor: RuntimeDomainDescriptor,
  input: InventoryInput,
): { readiness: ReadinessState; reason: string; missing: readonly string[]; reduced: readonly string[] } {
  const facts = input.facts
  const evidence = evaluateRequirements(descriptor.requirements, facts)
  const missing = missingRequirements(evidence)
  const reduced = degradedRequirements(evidence)
  const stopAllActive = input.stopAllActive ?? facts.stopAllActive
  const present = setOf(input.presentModules).has(descriptor.id)

  if (!present) {
    return {
      readiness: 'unavailable',
      reason: `the implementation named by this domain is not in this build (${descriptor.module})`,
      missing,
      reduced,
    }
  }

  if (descriptor.activation === 'fail-closed') {
    return {
      readiness: 'blocked',
      reason: descriptor.note,
      missing,
      reduced,
    }
  }

  if (stopAllActive && descriptor.id !== STOP_ALL_EXEMPT_DOMAIN) {
    return {
      readiness: 'blocked',
      reason: 'STOP ALL is latched; nothing but the security spine is running',
      missing,
      reduced,
    }
  }

  if (missing.length > 0) {
    return {
      readiness: 'blocked',
      reason: `missing required dependency: ${missing.join('; ')}`,
      missing,
      reduced,
    }
  }

  if (descriptor.activation === 'blocked') {
    return {
      readiness: 'blocked',
      reason: descriptor.note,
      missing,
      reduced,
    }
  }

  if (descriptor.activation === 'core-owned') {
    if (facts.coreLifecycle !== 'ready' && facts.coreLifecycle !== 'degraded') {
      return {
        readiness: 'blocked',
        reason: `Core is ${facts.coreLifecycle}; it has not reached ready`,
        missing,
        reduced,
      }
    }
    if (reduced.length > 0) {
      return {
        readiness: 'degraded',
        reason: `running with reduced capability: ${reduced.join('; ')}`,
        missing,
        reduced,
      }
    }
    return {
      readiness: 'active',
      reason: 'owned and running under this Core',
      missing,
      reduced,
    }
  }

  if (setOf(input.wiredHandlers).has(descriptor.id)) {
    return {
      readiness: 'active',
      reason: 'activated by the runtime activation controller',
      missing,
      reduced,
    }
  }

  return {
    readiness: 'available',
    reason: 'dependencies satisfied; no activation handler is wired in this build',
    missing,
    reduced,
  }
}

/** The five-state readiness the runtime controller's status maps onto. */
export function readinessFromRuntimeStatus(status: RuntimeStatus): ReadinessState {
  switch (status) {
    case 'active':
      return 'active'
    case 'degraded':
      return 'degraded'
    case 'available':
      return 'available'
    case 'blocked':
    case 'disabled':
      return 'blocked'
    // `implemented` and `registered` are pre-activation bookkeeping states. Neither
    // means running, and neither means available: they mean nobody has asked yet.
    case 'implemented':
    case 'registered':
      return 'blocked'
    default: {
      const never: never = status
      return never
    }
  }
}

/**
 * Derive the whole inventory from the canonical registry.
 *
 * The predicted form: no Core, no journal, just a descriptor plus a fact set. Useful
 * for "what would happen if", and checked against the controller by
 * `tests/qualification/agreement.test.ts`.
 */
export function buildCapabilityInventory(input: InventoryInput): CapabilityInventory {
  const wanted = input.only === undefined ? null : setOf(input.only)
  const descriptors = orderedRegistry().filter(
    (descriptor) => wanted === null || wanted.has(descriptor.id),
  )

  const capabilities: CapabilityRecord[] = descriptors.map((descriptor) => {
    const derived = capabilityReadiness(descriptor, input)
    return {
      id: descriptor.id,
      family: descriptor.family,
      title: descriptor.title,
      module: descriptor.module,
      activation: descriptor.activation,
      readiness: derived.readiness,
      reason: derived.reason,
      missing: derived.missing,
      reduced: derived.reduced,
      dependencyEvidence: evaluateRequirements(descriptor.requirements, input.facts),
      evidence: input.evidence?.[descriptor.id] ?? [],
      note: descriptor.note,
    }
  })

  const counts: Record<ReadinessState, number> = { ...EMPTY_READINESS_COUNTS }
  for (const capability of capabilities) counts[capability.readiness] += 1

  const withReadiness = (state: ReadinessState): readonly CapabilityRecord[] =>
    capabilities.filter((capability) => capability.readiness === state)

  return {
    counts,
    capabilities,
    running: withReadiness('active').map((c) => c.id).concat(withReadiness('degraded').map((c) => c.id)),
    available: withReadiness('available').map((c) => c.id),
    blocked: withReadiness('blocked'),
    degraded: withReadiness('degraded'),
    unavailable: withReadiness('unavailable'),
    ids: capabilities.map((c) => c.id),
  }
}

/**
 * A one-line summary that counts only.
 *
 * It never names a capability and never carries a metric, because a summary that
 * can be mistaken for the detail is how a blocked subsystem gets reported as
 * shipped.
 */
export function inventorySummary(inventory: CapabilityInventory): string {
  const { counts } = inventory
  return [
    `${counts.active} active`,
    `${counts.degraded} degraded`,
    `${counts.available} available`,
    `${counts.blocked} blocked`,
    `${counts.unavailable} unavailable`,
  ].join(', ')
}

/* ======================================================================== *
 * The live form
 * ======================================================================== */

/** What the projection-driven builder needs beyond the projection itself. */
export interface ProjectedInventoryInput {
  /**
   * Ids whose implementation is physically present in this build.
   *
   * Same contract as `InventoryInput.presentModules`, and the same reason: an
   * implementation that is not in the tree cannot be reported as merely idle.
   */
  readonly presentModules?: readonly string[]
  readonly evidence?: Readonly<Record<string, readonly ReadinessEvidence[]>>
  readonly only?: readonly string[]
}

/**
 * Derive the inventory from a **live** runtime projection.
 *
 * This is the form the release report uses, and it is deliberately *not* a
 * re-derivation. It reads:
 *
 *   - the status the activation controller actually decided, and
 *   - the dependency evidence the controller actually measured,
 *
 * straight out of the projection. It never re-evaluates a requirement against a fact
 * set it assembled itself, because a report that recomputes the answer is a second
 * answer, and two answers is how a release document starts describing a runtime that
 * does not exist.
 *
 * The one thing it adds is the presence check, because the controller has no notion of
 * a module being absent from a build — a domain is registered by being in the registry
 * whether or not its files shipped. `unavailable` is a build-level fact and only the
 * build can supply it.
 */
export function buildInventoryFromProjection(
  projection: RuntimeProjection,
  input: ProjectedInventoryInput,
): CapabilityInventory {
  const present = setOf(input.presentModules)
  const wanted = input.only === undefined ? null : setOf(input.only)
  const views = new Map(projection.domains.map((view) => [view.id, view]))

  const capabilities: CapabilityRecord[] = orderedRegistry()
    .filter((descriptor) => wanted === null || wanted.has(descriptor.id))
    .map((descriptor) => {
      const view = views.get(descriptor.id)
      const missing = (view?.missing ?? []).filter((label) =>
        descriptor.requirements.some(
          (requirement) => requirement.required && requirement.label === label,
        ),
      )
      const reduced = (view?.evidence ?? [])
        .filter((item) => !item.required && !item.satisfied)
        .map((item) => item.label)

      const readiness: ReadinessState = !present.has(descriptor.id)
        ? 'unavailable'
        : view === undefined
          ? 'blocked'
          : readinessFromRuntimeStatus(view.status)

      const reason = !present.has(descriptor.id)
        ? `the implementation named by this domain is not in this build (${descriptor.module})`
        : view === undefined
          ? 'the live runtime projection does not contain this registered domain, so nothing can be claimed for it'
          : view.reason

      return {
        id: descriptor.id,
        family: descriptor.family,
        title: descriptor.title,
        module: descriptor.module,
        activation: descriptor.activation,
        readiness,
        reason,
        missing,
        reduced,
        dependencyEvidence: view?.evidence ?? [],
        evidence: input.evidence?.[descriptor.id] ?? [],
        note: descriptor.note,
      }
    })

  const counts: Record<ReadinessState, number> = { ...EMPTY_READINESS_COUNTS }
  for (const capability of capabilities) counts[capability.readiness] += 1

  const withReadiness = (state: ReadinessState): readonly CapabilityRecord[] =>
    capabilities.filter((capability) => capability.readiness === state)

  return {
    counts,
    capabilities,
    running: withReadiness('active')
      .map((c) => c.id)
      .concat(withReadiness('degraded').map((c) => c.id)),
    available: withReadiness('available').map((c) => c.id),
    blocked: withReadiness('blocked'),
    degraded: withReadiness('degraded'),
    unavailable: withReadiness('unavailable'),
    ids: capabilities.map((c) => c.id),
  }
}