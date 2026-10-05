import type { GateDeclaration, GateResult } from './gates'
import { blockingPrerequisites, normaliseGateState, RELEASE_GATES, requiredGates } from './gates'
import type { CapabilityInventory } from './inventory'
import { SHIPPING_SCOPE, satisfiesShippingClaim, shippingClaimFor } from './scope'
import { GATE_STATES, type GateState, type Verdict } from './types'

/**
 * The verdict.
 *
 * One rule, stated once and enforced by a function rather than by convention:
 *
 * > The release ships only if every required gate executed here and proved its claim,
 * > and every capability the release declared `shipping` is genuinely running.
 *
 * Everything else is a non-pass and a non-ship. In particular:
 *
 *   - `not-run` is not `pass`. A gate nobody executed cannot clear a release, which
 *     is the specific failure this phase exists to prevent.
 *   - `unavailable` is not `pass`. A gate whose tool is not installed has measured
 *     nothing, and "we could not check" must never be reported as "it is fine".
 *   - `blocked` is not `pass`. A gate that could not run because a foundation failed
 *     has measured nothing either.
 *   - `degraded` is not `pass` for a required gate. It is the right state for a
 *     capability, but a gate either proved its sentence or it did not.
 *
 * The report therefore records three separate things: the verdict, every gate with
 * its own state, and every capability with its readiness and shipping claim. A reader
 * who disagrees with the verdict can find the exact sentence they disagree with.
 */

export interface GateVerdict {
  readonly id: string
  readonly title: string
  readonly claim: string
  readonly kind: GateDeclaration['kind']
  readonly required: boolean
  readonly state: GateState
  /** The command that ran, or null. Present even when the state is `not-run`. */
  readonly command: readonly string[] | null
  readonly exitCode: number | null
  readonly durationMs: number | null
  readonly detail: string
  /** Ids of prerequisites that were not passing, when the gate could not run. */
  readonly blockedBy: readonly string[]
  /** The capabilities this gate is the evidence for. */
  readonly capabilities: readonly string[]
  readonly output: readonly string[]
}

export interface CapabilityVerdict {
  readonly id: string
  readonly title: string
  readonly family: string
  readonly readiness: string
  readonly claim: string
  /** True when the release said this capability ships. */
  readonly shipping: boolean
  /** Whether readiness satisfies the shipping claim. */
  readonly meetsClaim: boolean
  readonly reason: string
  readonly missing: readonly string[]
  readonly reduced: readonly string[]
}

export interface VerdictReason {
  /** The closed reason kind, so a machine can group them. */
  readonly kind: 'gate-failed' | 'gate-not-passing' | 'gate-unavailable' | 'gate-blocked' | 'gate-not-run' | 'capability-not-shipping' | 'capability-missing' | 'scope-incomplete'
  readonly subject: string
  readonly detail: string
}

export interface QualificationReport {
  readonly schemaVersion: 1
  readonly verdict: Verdict
  /** Counts across every declared gate. */
  readonly gateCounts: Readonly<Record<GateState, number>>
  readonly gates: readonly GateVerdict[]
  readonly capabilities: readonly CapabilityVerdict[]
  /** Every reason the verdict is what it is. Empty when the verdict is `ship`. */
  readonly reasons: readonly VerdictReason[]
  /** The declared shipping scope, in full, so the report cannot under-report it. */
  readonly scope: readonly { readonly id: string; readonly claim: string; readonly reason: string }[]
  /** Capability readiness counts, from the inventory the caller supplied. */
  readonly readinessCounts: Readonly<Record<string, number>>
  /** True when every capability in the inventory has a shipping declaration. */
  readonly scopeComplete: boolean
}

export interface QualifyInput {
  readonly results: readonly GateResult[]
  readonly inventory: CapabilityInventory
  /** An ISO timestamp. Supplied by the caller so the report stays a pure function. */
  readonly generatedAt: string
  /** Revision the report was produced from. Never a secret. */
  readonly revision: string
}

function emptyGateCounts(): Record<GateState, number> {
  const counts = {} as Record<GateState, number>
  for (const state of GATE_STATES) counts[state] = 0
  return counts
}

/**
 * Build the verdict from gate results and the capability inventory.
 *
 * Pure: same inputs, same report, no clock and no I/O. Every caller — the runner, a
 * test, a diagnostics surface — sees the same answer, which is what makes the report
 * arguable rather than decorative.
 */
export function qualify(input: QualifyInput): QualificationReport {
  const byId = new Map(input.results.map((result) => [result.id, result]))
  const gateCounts = emptyGateCounts()

  const gates: GateVerdict[] = RELEASE_GATES.map((declaration) => {
    const raw = byId.get(declaration.id)
    // Normalisation is what stops a `pass` without evidence from surviving.
    const result = raw === undefined ? undefined : normaliseGateState(raw)
    const state: GateState = result?.state ?? 'not-run'
    gateCounts[state] += 1

    const declared = raw !== undefined
    const blockers = declared ? blockingPrerequisites(declaration, input.results) : [...declaration.requires]

    return {
      id: declaration.id,
      title: declaration.title,
      claim: declaration.claim,
      kind: declaration.kind,
      required: declaration.required,
      state,
      command: result?.command ?? declaration.command,
      exitCode: result?.exitCode ?? null,
      durationMs: result?.durationMs ?? null,
      detail: result?.detail ?? 'this gate was never executed in this run',
      blockedBy: blockers,
      capabilities: declaration.capabilities,
      output: result?.output ?? [],
    }
  })

  const capabilities: CapabilityVerdict[] = input.inventory.capabilities.map((capability) => {
    const declaration = shippingClaimFor(capability.id)
    const meetsClaim =
      declaration === undefined
        ? false
        : declaration.claim === 'not-shipping' || satisfiesShippingClaim(capability.readiness)
    return {
      id: capability.id,
      title: capability.title,
      family: capability.family,
      readiness: capability.readiness,
      claim: declaration?.claim ?? 'undeclared',
      shipping: declaration?.claim === 'shipping',
      meetsClaim,
      reason: capability.reason,
      missing: capability.missing,
      reduced: capability.reduced,
    }
  })

  const reasons: VerdictReason[] = []

  for (const gate of gates) {
    if (!gate.required) continue
    if (gate.state === 'pass') continue
    const kind: VerdictReason['kind'] =
      gate.state === 'fail'
        ? 'gate-failed'
        : gate.state === 'unavailable'
          ? 'gate-unavailable'
          : gate.state === 'blocked'
            ? 'gate-blocked'
            : 'gate-not-run'
    reasons.push({
      kind,
      subject: gate.id,
      detail:
        gate.state === 'blocked' && gate.blockedBy.length > 0
          ? `${gate.claim} Not run: ${gate.blockedBy.join(', ')} did not pass.`
          : `${gate.claim} ${gate.detail}`,
    })
  }

  const undeclared = capabilities.filter((capability) => capability.claim === 'undeclared')
  // The check runs both ways on purpose. A capability present in the inventory with no
  // shipping claim is a gap, and a capability the release declares but the inventory
  // does not contain is a *bigger* one: it means the thing the release promised has
  // quietly vanished from the measurement. Either way it is reported, because the one
  // thing a release report must not do is describe a smaller system and say nothing.
  const inventoryIds = new Set(capabilities.map((capability) => capability.id))
  const absentFromInventory = SHIPPING_SCOPE.filter((declaration) => !inventoryIds.has(declaration.id))

  if (undeclared.length > 0 || absentFromInventory.length > 0) {
    const parts: string[] = []
    if (undeclared.length > 0) {
      parts.push(
        `no shipping claim is declared for ${undeclared.map((c) => c.id).join(', ')}; a capability nobody claimed cannot be counted as shipped, and it must still be named`,
      )
    }
    if (absentFromInventory.length > 0) {
      parts.push(
        `the shipping scope declares ${absentFromInventory.map((entry) => entry.id).join(', ')}, but the inventory does not contain ${absentFromInventory.length === 1 ? 'it' : 'them'}; a declared capability that the measurement cannot see is not a capability that shipped`,
      )
    }
    reasons.push({ kind: 'scope-incomplete', subject: 'shipping-scope', detail: parts.join('. ') })
  }

  for (const capability of capabilities) {
    if (capability.claim !== 'shipping') continue
    if (capability.meetsClaim) continue
    reasons.push({
      kind: capability.readiness === 'unavailable' ? 'capability-missing' : 'capability-not-shipping',
      subject: capability.id,
      detail: `the release declares ${capability.id} shipping, but its readiness is ${capability.readiness}: ${capability.reason}`,
    })
  }

  return {
    schemaVersion: 1,
    verdict: reasons.length === 0 ? 'ship' : 'no-ship',
    gateCounts,
    gates,
    capabilities,
    reasons,
    scope: SHIPPING_SCOPE.map((declaration) => ({
      id: declaration.id,
      claim: declaration.claim,
      reason: declaration.reason,
    })),
    readinessCounts: input.inventory.counts,
    scopeComplete: undeclared.length === 0 && absentFromInventory.length === 0,
  }
}

/**
 * The gates this run did not clear, in declaration order.
 *
 * Exposed separately because the question "what is left?" is asked far more often
 * than "is it fine?", and an answer that has to be derived from the whole report is
 * an answer people stop asking.
 */
export function blockingGates(report: QualificationReport): readonly GateVerdict[] {
  return report.gates.filter((gate) => gate.required && gate.state !== 'pass')
}

/** Canonical, stable JSON. Key order is fixed so two runs diff cleanly. */
export function canonicalReportJson(report: QualificationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** Every gate that is required but was never recorded at all. */
export function unrecordedRequiredGates(results: readonly GateResult[]): readonly string[] {
  const seen = new Set(results.map((result) => result.id))
  return requiredGates()
    .filter((declaration) => !seen.has(declaration.id))
    .map((declaration) => declaration.id)
}