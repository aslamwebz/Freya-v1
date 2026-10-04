import type { DeviceHandsSurface } from './types'

/**
 * Probing: verifying that a surface exists, without ever using it.
 *
 * ## The rule this file exists to enforce
 *
 * > A test may verify a candidate capability. A successful probe may not itself grant
 * > broader authority.
 *
 * That is enforced in four places rather than one, because a promise held in a comment
 * is not a property:
 *
 *  1. **The result type has no field that could be a grant.** `DeviceHandsProbeOutcome`
 *     is `{probeId, surface, available, code, probedAt}`. There is no `granted`, no
 *     `capabilityId`, no `scope`, no `expiresAt`. You cannot read a permission off a
 *     probe result because there is nothing shaped like one to read.
 *  2. **The probe gate is a different, shorter list** than the action gate
 *     (`DEVICE_HANDS_PROBE_GATES` in `./gates`): no grant gate, no approval gate, no
 *     budget gate. A probe can be run by a caller holding *no* capability — which is
 *     the point of it — and the absence of those gates means passing one cannot
 *     produce authority, because nothing in the pipeline produces authority at all.
 *  3. **The port can only report availability.** `probeSurface` returns
 *     `{available, code}`. There is no port method that issues a grant, so a probe
 *     cannot ask the host for one even by accident.
 *  4. **The recorded entry is an observation.** `hands.probe.performed` journals the
 *     probe's *finding*; it never mutates the grant table, and the fold has no case
 *     that could. `hands.probe.refused` records a refusal instead, so a probe that
 *     never ran cannot leave a record that reads as though it did.
 *
 * What a probe is for, then: "does this machine have a clipboard", "is a browser
 * reachable", "can this host even run `git`". It answers an operational question. It
 * answers no question about permission, and this file makes that structural.
 */

/** The closed set of codes a probe may report. */
export const DEVICE_HANDS_PROBE_CODES = [
  'available',
  'unavailable',
  'not-implemented',
  'refused',
] as const
export type DeviceHandsProbeCode = (typeof DEVICE_HANDS_PROBE_CODES)[number]

export function isDeviceHandsProbeCode(value: unknown): value is DeviceHandsProbeCode {
  return (
    typeof value === 'string' && (DEVICE_HANDS_PROBE_CODES as readonly string[]).includes(value)
  )
}

/** The exact keys a probe outcome may carry. Nothing else is a probe outcome. */
export const DEVICE_HANDS_PROBE_OUTCOME_KEYS: readonly string[] = Object.freeze([
  'probeId',
  'surface',
  'available',
  'code',
  'probedAt',
])

/**
 * Keys that would name authority, on any record at all.
 *
 * Shared with `./assertions`, which scans source for them, and with the fold, which
 * refuses them in a journal payload. Three places, one list, because the guarantee is
 * only worth as much as the weakest of them.
 */
export const AUTHORITY_SHAPED_KEYS: readonly string[] = Object.freeze([
  'granted',
  'grant',
  'grantId',
  'authority',
  'capability',
  'capabilityId',
  'capabilities',
  'permission',
  'permissions',
  'privilege',
  'scope',
  'allowed',
  'allow',
  'widen',
  'elevate',
  'escalate',
])

/**
 * Whether a record carries a key that names authority.
 *
 * Purely structural, and deliberately about *keys* rather than values: `"available"`
 * says something happened and `"granted"` says something is permitted, and only one of
 * those turns a measurement into an authority. A test calls this on every probe result
 * the runtime hands out, so a future field named `authorised` fails the suite rather
 * than shipping.
 */
export function findAuthorityShapedKeys(record: object): readonly string[] {
  const findings: string[] = []
  for (const key of Object.keys(record)) {
    if (AUTHORITY_SHAPED_KEYS.includes(key.toLowerCase())) findings.push(key)
  }
  return findings
}

/**
 * A one-sentence description of what a probe found.
 *
 * Note the wording. It says the surface *answered*; it never says the surface *is
 * now usable*, because nothing about a probe changes whether it is usable.
 */
export function probeSummary(outcome: {
  readonly surface: DeviceHandsSurface
  readonly available: boolean
  readonly code: string
}): string {
  return outcome.available
    ? `The ${outcome.surface} surface answered (${outcome.code}). Nothing about using it has changed: this is a measurement, not a permission.`
    : `The ${outcome.surface} surface did not answer usefully (${outcome.code}). Nothing about using it has changed either way.`
}