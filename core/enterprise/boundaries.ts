import {
  ALWAYS_APPROVED_WEBZONE_KINDS,
  ENTERPRISE_LIMITS,
  FORBIDDEN_ENTERPRISE_ACTIONS,
  NEVER_APPROVED_WEBZONE_KINDS,
  WEBZONE_CONSEQUENCE,
  isForbiddenEnterpriseAction,
  type ActionConsequenceClass,
  type AuthorizationGate,
  type EnterpriseRefusalCode,
  type ForbiddenEnterpriseAction,
  type WebzoneOperationKind,
} from './types'

/**
 * Enterprise boundaries: the explicit walls this subsystem cannot cross.
 *
 * Two kinds live here and the difference is the important part:
 *
 *   - **Owner-set** boundaries — how many tasks, which domains, which actions are
 *     forbidden. The owner chooses these. They are *narrowed* into the code-owned
 *     ceilings on the way in and are unioned with the absolute deny list, so a large
 *     owner number still cannot exceed {@link ENTERPRISE_LIMITS} and an empty deny
 *     list still yields every forbidden action.
 *
 *   - **Absolute** boundaries — {@link FORBIDDEN_ENTERPRISE_ACTIONS}. These are not a
 *     setting. There is no input, event or payload that removes one, and the union is
 *     written so that a caller passing garbage gets *more* restrictions, never fewer.
 *
 * Pure. No clock, no journal, no authority, no network.
 */

/** The closed set of boundaries an action can be checked against. */
export const ENTERPRISE_BOUNDARY_NAMES = [
  'tasks-per-environment',
  'missions-per-environment',
  'operations-per-environment',
  'concurrent-operations',
  'duration',
  'domain',
  'forbidden-action',
  'payload-size',
] as const
export type EnterpriseBoundaryName = (typeof ENTERPRISE_BOUNDARY_NAMES)[number]

/** The one gate, of the authorization gate list, that owns boundary enforcement. */
export const BOUNDARY_GATE: AuthorizationGate = 'boundary'

export interface EnterpriseBoundaries {
  readonly maxTasks: number
  readonly maxMissions: number
  readonly maxWebzoneOperations: number
  readonly maxConcurrentOperations: number
  readonly allowedDomains: readonly string[]
  readonly forbiddenActions: readonly string[]
}

export interface BoundaryDecision {
  readonly held: boolean
  readonly boundary: EnterpriseBoundaryName
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

const HELD = (boundary: EnterpriseBoundaryName, reason: string): BoundaryDecision => ({
  held: true,
  boundary,
  code: null,
  reason,
})

const VIOLATED = (
  boundary: EnterpriseBoundaryName,
  code: EnterpriseRefusalCode,
  reason: string,
): BoundaryDecision => ({ held: false, boundary, code, reason })

/* ------------------------------------------------------------ normalising */

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Narrow one owner number into the code-owned ceiling.
 *
 * Clamps *down* and never up. A non-number, a negative, a float and a value above the
 * ceiling all resolve to the ceiling rather than to the caller's number, because the
 * only safe reading of "I asked for something enormous" is "use the smaller limit".
 */
function narrow(value: unknown, ceiling: number): number {
  return isPositiveInt(value) && value < ceiling ? value : ceiling
}

/**
 * Normalise one allowed-domain entry to a bare hostname.
 *
 * Returns null for anything that is not a plain http(s) origin with no credentials,
 * no path and no port. The rejections matter more than the accept:
 *
 *   - a credential in the entry (`https://u:p@host`) would put a secret into a
 *     durable record, so it is refused rather than stripped;
 *   - a path or port would mean the allowlist entry is more than a host, and matching
 *     only the host would then permit more than the owner wrote;
 *   - anything other than http/https is refused because the allowlist's job is to name
 *     where Freya may appear, not to name a protocol handler.
 *
 * A leading `*.` is preserved as a wildcard marker; anything else containing `*` is
 * refused, so the only wildcard in the system is the one this function writes.
 */
function normaliseDomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const wildcard = value.startsWith('*.')
  const host = wildcard ? value.slice(2) : value
  if (host.length === 0 || host.includes('*')) return null
  if (/[^a-z0-9.-]/i.test(host)) return null
  let url: URL
  try {
    url = new URL(`${wildcard ? 'https' : 'http'}://${host}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.port !== '') return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.hostname !== host.toLowerCase()) return null
  if (url.hostname.length === 0 || !url.hostname.includes('.')) return null
  return wildcard ? `*.${url.hostname}` : url.hostname
}

/**
 * Union the owner's forbidden list with the absolute one.
 *
 * The absolute entries are added *last* and unconditionally. An owner list that is
 * missing, malformed, or actively trying to name one of them as permitted still gets
 * the full set, because the only code path here can add.
 */
export function effectiveForbiddenActions(ownerList: unknown): readonly string[] {
  const fromOwner = Array.isArray(ownerList)
    ? ownerList.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
  const merged = new Set<string>(fromOwner)
  for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) merged.add(action)
  return [...merged].sort()
}

export interface BoundaryNormalisation {
  readonly ok: boolean
  readonly boundaries: EnterpriseBoundaries | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

/**
 * Narrow a whole owner-supplied boundary record into a legal one.
 *
 * Never fails on a *wide* value — a request for 10_000 tasks becomes 64 — because
 * refusing outright would teach an integrator that the field is a trap rather than a
 * ceiling. It fails only on the two things that are genuinely unrepresentable: a
 * domain list that contains an entry which cannot be a host, and an allowlist that
 * would leave the environment with no domain at all.
 */
export function normaliseBoundaries(input: unknown): BoundaryNormalisation {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  const rawDomains = Array.isArray(raw.allowedDomains) ? raw.allowedDomains.slice(0, 64) : []
  const domains: string[] = []
  for (const entry of rawDomains) {
    const host = normaliseDomain(entry)
    if (host === null) {
      return {
        ok: false,
        boundaries: null,
        code: 'domain-not-allowed',
        reason:
          'An allowed-domain entry is not a bare http(s) host. Credentials, ports, paths and wildcards other than a leading "*." are refused.',
      }
    }
    if (!domains.includes(host)) domains.push(host)
  }
  if (domains.length === 0) {
    return {
      ok: false,
      boundaries: null,
      code: 'domain-not-allowed',
      reason:
        'An environment with no allowed domain could not be operated. An empty allowlist is refused rather than treated as "everywhere".',
    }
  }

  return {
    ok: true,
    boundaries: Object.freeze({
      maxTasks: narrow(raw.maxTasks, ENTERPRISE_LIMITS.maxTasksPerEnvironment),
      maxMissions: narrow(raw.maxMissions, ENTERPRISE_LIMITS.maxMissionsPerEnvironment),
      maxWebzoneOperations: narrow(
        raw.maxWebzoneOperations,
        ENTERPRISE_LIMITS.maxWebzoneOperationsPerEnvironment,
      ),
      maxConcurrentOperations: narrow(
        raw.maxConcurrentOperations,
        ENTERPRISE_LIMITS.maxConcurrentOperations,
      ),
      allowedDomains: Object.freeze(domains.sort()),
      forbiddenActions: Object.freeze(effectiveForbiddenActions(raw.forbiddenActions)),
    }),
    code: null,
    reason: 'Boundaries were narrowed into the code-owned ceilings and the deny list was unioned.',
  }
}

/* --------------------------------------------------------------- matching */

/**
 * Does `target` fall inside the allowlist?
 *
 * Wildcards match on a label boundary, so `*.example.com` covers `www.example.com`
 * and `example.com` but *not* `notexample.com` and not `example.com.evil.test`.
 * The naive `endsWith('.example.com')` is only half of that; the naive
 * `endsWith('example.com')` is how an allowlist becomes no allowlist at all.
 *
 * The target is parsed rather than string-matched, so a target of
 * `https://evil.test/?x=allowed.example.com` cannot smuggle a match out of its query
 * string, and a `user@` prefix cannot smuggle one out of its authority.
 */
export function domainAllowed(target: string, allowedDomains: readonly string[]): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  if (host.length === 0) return false
  for (const entry of allowedDomains) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1)
      if (host.endsWith(suffix) && host.length > suffix.length) return true
    } else if (host === entry) {
      return true
    }
  }
  return false
}

/**
 * Is this action one the enterprise may never perform?
 *
 * The check is over the *union*, so a caller cannot pass `"real-money-transfer"` and
 * have it read as a permission. It takes the string verbatim rather than mapping it
 * through the operation-kind table first, because the string is the untrusted input:
 * an attacker who can name an action should be refused whatever else they claim about
 * it.
 */
export function isForbiddenAction(action: unknown, boundaries: EnterpriseBoundaries): boolean {
  // A non-string is not a named action, so it is not a forbidden one. This used to
  // return `true`, which meant every well-formed action was refused at the boundary
  // gate — the check was so eager it swallowed every other boundary reason, including
  // the domain and count refusals it is supposed to sit beside.
  if (typeof action !== 'string') return false

  // The absolute list is consulted *here* as well as at normalisation time, and that
  // duplication is deliberate. `normaliseBoundaries` unions it in, but this function
  // takes a structurally-typed `EnterpriseBoundaries`, so a caller can hand it an
  // object literal with an empty deny list and skip normalisation entirely. If the
  // check trusted the incoming list, that object literal would be a way to switch the
  // deny list off.
  //
  // Two independent places, because the failure this prevents is not a hypothetical:
  // it is exactly what a future refactor that constructs boundaries inline would do.
  if (isForbiddenEnterpriseAction(action)) return true
  return Array.isArray(boundaries.forbiddenActions)
    ? boundaries.forbiddenActions.includes(action)
    : false
}

/* ------------------------------------------------------------ the checks */

export interface CountContext {
  readonly tasks: number
  readonly missions: number
  readonly operations: number
  readonly concurrent: number
}

/** The count boundaries, checked smallest-first so the cheapest refusal is reported. */
export function checkCountBoundaries(
  boundaries: EnterpriseBoundaries,
  context: CountContext,
): BoundaryDecision {
  if (context.operations >= boundaries.maxWebzoneOperations) {
    return VIOLATED(
      'operations-per-environment',
      'operation-count-exceeded',
      `This environment already holds its ceiling of ${String(boundaries.maxWebzoneOperations)} webzone operations.`,
    )
  }
  if (context.tasks >= boundaries.maxTasks) {
    return VIOLATED(
      'tasks-per-environment',
      'task-count-exceeded',
      `This environment already holds its ceiling of ${String(boundaries.maxTasks)} tasks.`,
    )
  }
  if (context.missions >= boundaries.maxMissions) {
    return VIOLATED(
      'missions-per-environment',
      'mission-count-exceeded',
      `This environment already holds its ceiling of ${String(boundaries.maxMissions)} missions.`,
    )
  }
  if (context.concurrent >= boundaries.maxConcurrentOperations) {
    return VIOLATED(
      'concurrent-operations',
      'concurrent-operation-ceiling',
      `This environment already has its ceiling of ${String(boundaries.maxConcurrentOperations)} operations in flight.`,
    )
  }
  return HELD(
    'operations-per-environment',
    'Task, mission, operation and concurrency counts are all within this environment’s ceilings.',
  )
}

/** The duration ceiling for one kind of record. */
export function checkDurationBoundary(
  startedAtMs: number,
  nowMs: number,
  ceilingMs: number,
): BoundaryDecision {
  const elapsed = nowMs - startedAtMs
  if (elapsed < 0) {
    // A clock that moved backwards is not a reason to believe the record is young.
    return VIOLATED(
      'duration',
      'duration-ceiling-exceeded',
      'The clock moved backwards relative to this record, so its age cannot be trusted.',
    )
  }
  if (elapsed > ceilingMs) {
    return VIOLATED(
      'duration',
      'duration-ceiling-exceeded',
      `This record has been open for ${String(Math.floor(elapsed / 86_400_000))} days, past its ceiling.`,
    )
  }
  return HELD('duration', `This record is ${String(Math.floor(elapsed / 86_400_000))} days old, within its ceiling.`)
}

/** The webzone payload ceiling, measured in UTF-8 bytes rather than characters. */
export function checkPayloadBoundary(payload: string): BoundaryDecision {
  let bytes: number
  try {
    bytes = new TextEncoder().encode(payload).length
  } catch {
    return VIOLATED('payload-size', 'payload-too-large', 'The payload could not be measured, so it is refused.')
  }
  if (bytes > ENTERPRISE_LIMITS.maxWebzonePayloadBytes) {
    return VIOLATED(
      'payload-size',
      'payload-too-large',
      `The payload is ${String(bytes)} bytes, past the ${String(ENTERPRISE_LIMITS.maxWebzonePayloadBytes)}-byte ceiling.`,
    )
  }
  return HELD('payload-size', `The payload is ${String(bytes)} bytes, within the ceiling.`)
}

/** The domain allowlist. */
export function checkDomainBoundary(
  target: string,
  boundaries: EnterpriseBoundaries,
): BoundaryDecision {
  if (!domainAllowed(target, boundaries.allowedDomains)) {
    return VIOLATED(
      'domain',
      'domain-not-allowed',
      `That target is not inside this environment’s allowed domains (${boundaries.allowedDomains.join(', ')}).`,
    )
  }
  return HELD('domain', 'The target is inside this environment’s allowed domains.')
}

/** The absolute deny list, plus the owner's own additions. */
export function checkForbiddenAction(
  action: unknown,
  boundaries: EnterpriseBoundaries,
): BoundaryDecision {
  if (isForbiddenAction(action, boundaries)) {
    return VIOLATED(
      'forbidden-action',
      'forbidden-action',
      'That action is forbidden outright. No environment setting, owner input or model response can permit it.',
    )
  }
  return HELD('forbidden-action', 'That action is not on any forbidden list.')
}

/**
 * The absolute deny list, on its own.
 *
 * The gate calls `isForbiddenAction` with the environment's boundaries, which unions
 * this list with the owner's. This is the narrower question — "is this one of the
 * actions no configuration can permit?" — kept separate because the red-team suite asks
 * it directly, and a test that had to construct a whole environment to ask a simple
 * question would be a weaker test.
 */
export function isAbsolutelyForbidden(action: unknown): boolean {
  return typeof action === 'string' && isForbiddenEnterpriseAction(action)
}

/* --------------------------------------------------------- consequence */

/**
 * The consequence class of a webzone operation, from the code-owned table.
 *
 * Takes the *kind* and returns the class, rather than accepting a class from the
 * caller. An operation cannot describe itself as more reversible than it is, because
 * the class is not a field it carries.
 */
export function consequenceOf(kind: WebzoneOperationKind): ActionConsequenceClass {
  return WEBZONE_CONSEQUENCE[kind]
}

/**
 * Does this operation need an owner approval before it may run?
 *
 * Three closed rules, and the order is the point:
 *
 *   1. `query` never needs one. It is a read; there is nothing to authorize.
 *   2. `delete` always needs one. It is the only kind whose loss is unrecoverable if
 *      the preserved copy turns out to be missing, and the owner is the only one who
 *      can decide that is acceptable.
 *   3. Everything else needs one when the caller says it is consequential.
 *
 * `restorable` is deliberately *not* consulted here. Whether an operation can be
 * undone is a question for `./rollback` to answer from what Core actually did, and
 * letting it soften the approval requirement would mean the requirement depends on a
 * fact the subsystem asserts about its own future.
 */
export function approvalRequiredFor(
  kind: WebzoneOperationKind,
  consequential: boolean,
): boolean {
  if (NEVER_APPROVED_WEBZONE_KINDS.includes(kind)) return false
  if (ALWAYS_APPROVED_WEBZONE_KINDS.includes(kind)) return true
  return consequential
}

/** Exposed for the audit in `./assertions`; not a decision input. */
export function forbiddenActionCount(): number {
  return FORBIDDEN_ENTERPRISE_ACTIONS.length
}

/** Narrowing an untrusted string to a known absolute deny entry, for typed callers. */
export function asForbiddenAction(value: unknown): ForbiddenEnterpriseAction | null {
  return isForbiddenEnterpriseAction(value) ? value : null
}