import {
  CONTEXT_ADMISSION_CODES,
  CONTEXT_ADMISSION_REASONS,
  CONTEXT_KIND_SOURCES,
  contextLimits,
  isAnyContextKind,
  isContextScopeKind,
  isContextSource,
  isDeferredContextKind,
  type AnyContextKind,
  type ContextAdmission,
  type ContextKind,
  type ContextLimits,
  type ContextScope,
  type ContextScopeKind,
  type ContextSource,
} from '../types'

/**
 * THE ADAPTER ENGINE — closed inputs in, admission candidates out.
 *
 * An adapter converts a *handed-in* input (somebody selected this, authorised
 * this, shared this) into a `ContextAdmission` — the #15 foundation's own
 * request shape, which `ContextStore.admit` then judges. Producing a candidate
 * grants nothing: the store re-validates everything at admission, the scope
 * still has to be the one Core holds, and Guard never reads any of it
 * (Constitution C3 — context data is knowledge, never permission).
 *
 * ## What this file guarantees
 *
 * - **Determinism.** Pure functions over their arguments: no clock read, no
 *   id minted, no capture attempted. The same input through the same spec
 *   produces a byte-identical candidate, so a caller can replay a share and
 *   get the same request back.
 * - **Exact preservation.** `kind`, `source`, `scope`, `originId`,
 *   `capturedAt` and `ttlMs` are placed into the candidate exactly as given
 *   (only the store's own `''`-normalisations of `uri`/`originId` are
 *   mirrored). Nothing is widened, clamped or "helpfully" defaulted upward:
 *   a TTL above the ceiling survives here untouched, because clamping is the
 *   *store's* act at admission and a candidate that got clamped twice is a
 *   candidate nobody can trace.
 * - **Closed inputs.** Every key on an input must be known; an
 *   authority-shaped key (`authority`, `permission`, `grant`, …) is refused
 *   by name — an adapter that silently accepted one would be a side door for
 *   turning a share into a permit.
 * - **Validation in a fixed order**, so two callers who disagree about *why*
 *   something failed still get the same answer for the same input:
 *   key shape → kind → kind/source combination → origin → scope → capture
 *   instant → content → label → uri → ttl.
 *
 * Rejection codes reuse the foundation's `ContextAdmissionCode` vocabulary and
 * add only what an adapter can see but the store cannot (a wrong kind for
 * *this* adapter, a confused scope, a smuggled authority field), so a refusal
 * downstream and a refusal here are words from one language.
 */

/* ----------------------------------------------------------------- codes */

/**
 * Adapter rejections: the admission vocabulary plus the four things that can
 * only go wrong *before* admission.
 */
export const CONTEXT_ADAPTER_REJECTION_CODES = [
  ...CONTEXT_ADMISSION_CODES,
  'input_invalid',
  'kind_mismatch',
  'scope_confusion',
  'authority_not_admissible',
] as const
export type ContextAdapterRejectionCode = (typeof CONTEXT_ADAPTER_REJECTION_CODES)[number]

/** Why a code is a refusal, in words a person can act on. */
export const CONTEXT_ADAPTER_REJECTION_REASONS: Readonly<
  Record<ContextAdapterRejectionCode, string>
> = Object.freeze({
  ...CONTEXT_ADMISSION_REASONS,
  input_invalid: 'that is not a context source input this adapter can read',
  kind_mismatch: 'that adapter does not produce that context kind',
  scope_confusion: 'the scope on that input mixes or mislabels one sharing boundary',
  authority_not_admissible:
    'context input cannot carry authority: shared context never grants access',
})

/* ----------------------------------------------------------------- types */

/**
 * The base shape every adapter input shares. `kind` and `source` are open on
 * purpose: validating their *combination* is the adapter's job, so the type
 * must be able to express a wrong pairing for the runtime to refuse it.
 */
export interface ContextAdapterInputBase {
  /** Optional assertion of intent; when present it must name this adapter's kind. */
  readonly kind?: AnyContextKind | null
  /** Optional source; defaults to the adapter's default, and must be one it permits. */
  readonly source?: ContextSource | null
  /** The one boundary this input was shared into. Never flat keys, never inferred. */
  readonly scope: ContextScope
  readonly content: string
  readonly label?: string | null
  readonly uri?: string | null
  /** The record the content came from; required for any non-owner source. */
  readonly originId?: string | null
  readonly capturedAt?: string | null
  /** Preserved exactly — the store clamps at admission, never the adapter. */
  readonly ttlMs?: number | null
}

export interface ContextAdapterOptions {
  /** Ceilings may be lowered here and never raised above the foundation's. */
  readonly limits?: Partial<ContextLimits>
}

export type ContextAdapterResult =
  | { readonly ok: true; readonly admission: ContextAdmission }
  | { readonly ok: false; readonly code: ContextAdapterRejectionCode; readonly reason: string }

/**
 * What one adapter is allowed to produce. Constructed only through
 * {@link contextSourceAdapterSpec}, which pins the permitted sources to the
 * foundation's `CONTEXT_KIND_SOURCES` table — an adapter that drifted from the
 * table would be inventing provenance at module load.
 */
export interface ContextSourceAdapterSpec {
  readonly kind: ContextKind
  readonly permittedSources: readonly ContextSource[]
  readonly defaultSource: ContextSource
}

export function contextSourceAdapterSpec(
  kind: ContextKind,
  permittedSources: readonly ContextSource[],
  defaultSource: ContextSource,
): ContextSourceAdapterSpec {
  const table = CONTEXT_KIND_SOURCES[kind]
  const isExactTable =
    permittedSources.length === table.length &&
    permittedSources.every((source) => table.includes(source)) &&
    table.every((source) => permittedSources.includes(source))
  if (!isExactTable || !table.includes(defaultSource)) {
    throw new Error(`context adapter for '${kind}' disagrees with the provenance table`)
  }
  return Object.freeze({
    kind,
    permittedSources: Object.freeze([...permittedSources]),
    defaultSource,
  })
}

/* ------------------------------------------------------------- internals */

const KNOWN_INPUT_KEYS: readonly string[] = Object.freeze([
  'kind',
  'source',
  'scope',
  'content',
  'label',
  'uri',
  'originId',
  'capturedAt',
  'ttlMs',
])

/** Authority-shaped keys: refused by name, never silently dropped. */
const AUTHORITY_KEYS: readonly string[] = Object.freeze([
  'access',
  'allowed',
  'authority',
  'authorized',
  'capability',
  'capabilities',
  'grant',
  'permission',
  'permissions',
  'trust',
])

/** A scope flattened onto the input instead of nested in `scope`. */
const FLAT_SCOPE_KEYS: readonly string[] = Object.freeze(['scopeKind', 'scopeId'])

/** The one scopeId a `session` boundary may carry — per the foundation's types. */
const SESSION_SCOPE_ID = 'session'

function refusal(code: ContextAdapterRejectionCode): ContextAdapterResult {
  return { ok: false, code, reason: CONTEXT_ADAPTER_REJECTION_REASONS[code] }
}

/* ------------------------------------------------------------ conversion */

/**
 * Validate one handed-in input against one adapter spec and produce the
 * admission candidate, or refuse with a code from the shared vocabulary.
 *
 * Nothing here reads a clock or touches a store: the result is a *request*,
 * and `ContextStore.admit` remains the only place a request becomes a held
 * item — with its own ceilings, its own eviction and its own refusals.
 */
export function buildContextAdmission(
  input: ContextAdapterInputBase,
  spec: ContextSourceAdapterSpec,
  options: ContextAdapterOptions = {},
): ContextAdapterResult {
  const limits = contextLimits(options.limits ?? {})
  if (input === null || typeof input !== 'object') return refusal('input_invalid')
  const fields: Record<string, unknown> = { ...input }
  const keys = Object.keys(fields)

  // Authority first: it is the truest answer when several things are wrong,
  // and it must never look like an unknown key that "would have been ignored".
  if (keys.some((key) => AUTHORITY_KEYS.includes(key))) return refusal('authority_not_admissible')
  if (keys.some((key) => FLAT_SCOPE_KEYS.includes(key))) return refusal('scope_confusion')
  if (keys.some((key) => !KNOWN_INPUT_KEYS.includes(key))) return refusal('input_invalid')

  const kind = fields.kind ?? null
  if (kind !== null) {
    if (!isAnyContextKind(kind)) return refusal('kind_unknown')
    // Declared-but-unsourced kinds are refused by name here too: an adapter
    // that built nothing for `active_window` would be a quiet ambient capture.
    if (isDeferredContextKind(kind)) return refusal('kind_deferred')
    if (kind !== spec.kind) return refusal('kind_mismatch')
  }

  let source: ContextSource = spec.defaultSource
  if (fields.source !== null && fields.source !== undefined) {
    if (!isContextSource(fields.source)) return refusal('source_not_permitted')
    if (!spec.permittedSources.includes(fields.source)) return refusal('source_not_permitted')
    source = fields.source
  }

  const originRaw = fields.originId ?? null
  const originNormalized = originRaw === '' ? null : originRaw
  if (originNormalized !== null && (typeof originNormalized !== 'string' ||
      originNormalized.length > limits.maxOriginIdChars)) {
    return refusal('invalid_origin')
  }
  const originId: string | null = originNormalized as string | null
  // The store will demand this again at admission; demanding it here is what
  // "provenance is checked, not decorated" costs: a bare "the host said so"
  // never even becomes a request.
  const ownerHand =
    source === 'owner_selection' ||
    source === 'owner_share' ||
    source === 'owner_authorization'
  if (!ownerHand && originId === null) return refusal('origin_required')

  const scopeRaw = fields.scope
  if (scopeRaw === null || typeof scopeRaw !== 'object') return refusal('invalid_scope')
  const scopeFields = scopeRaw as Record<string, unknown>
  const scopeKind = scopeFields.scopeKind
  const scopeId = scopeFields.scopeId
  if (!isContextScopeKind(scopeKind)) return refusal('invalid_scope')
  if (typeof scopeId !== 'string' || scopeId.length === 0 ||
      scopeId.length > limits.maxScopeIdChars) {
    return refusal('invalid_scope')
  }
  // The session boundary is one and is named `'session'`; anything else wearing
  // that label would make a conversation's share ambient to the whole app.
  if (scopeKind === 'session' && scopeId !== SESSION_SCOPE_ID) return refusal('scope_confusion')

  const capturedRaw = fields.capturedAt ?? null
  if (capturedRaw !== null && (typeof capturedRaw !== 'string' ||
      !Number.isFinite(Date.parse(capturedRaw)))) {
    return refusal('invalid_instant')
  }
  const capturedAt: string | null = capturedRaw as string | null

  const contentRaw = fields.content
  if (typeof contentRaw !== 'string' || contentRaw.trim().length === 0) {
    return refusal('content_empty')
  }
  if (contentRaw.length > limits.maxContentChars) return refusal('content_too_large')

  const labelRaw = fields.label ?? null
  if (labelRaw !== null && (typeof labelRaw !== 'string' || labelRaw.length > limits.maxLabelChars)) {
    return refusal('label_too_large')
  }
  const label: string | null = labelRaw as string | null

  const uriRaw = fields.uri ?? null
  let uri: string | null = null
  if (uriRaw !== null && uriRaw !== '') {
    if (typeof uriRaw !== 'string' || uriRaw.length > limits.maxUriChars) {
      return refusal('uri_too_large')
    }
    uri = uriRaw
  }

  const ttlRaw = fields.ttlMs ?? null
  if (ttlRaw !== null && (typeof ttlRaw !== 'number' || !Number.isFinite(ttlRaw) || ttlRaw <= 0)) {
    return refusal('invalid_ttl')
  }
  const ttlMs: number | null = ttlRaw as number | null

  const admission: ContextAdmission = {
    kind: spec.kind,
    source,
    scope: { scopeKind, scopeId },
    content: contentRaw,
    label,
    uri,
    originId,
    capturedAt,
    ttlMs,
  }
  return { ok: true, admission }
}

/* ----------------------------------------------------------------- audit */

/**
 * A metadata-only view of an admission candidate.
 *
 * The candidate carries the private part (`content`, `label`, `uri`) and must
 * be loggable *without* it, so this shape is built by subtraction exactly like
 * `ContextAuditRecord`: ids, closed labels, instants and measured lengths —
 * the `uri` does not appear at all, not even as text, because a file path or
 * tab URL is somebody's private fact. There is no field here a sentence could
 * hide in, and no field that could later "just include the label".
 */
export interface ContextAdmissionDescriptor {
  readonly kind: AnyContextKind
  readonly source: ContextSource
  readonly scopeKind: ContextScopeKind
  readonly scopeId: string
  readonly originId: string | null
  readonly capturedAt: string | null
  readonly ttlMs: number | null
  readonly contentLength: number
  readonly labelLength: number
}

export function describeContextAdmission(admission: ContextAdmission): ContextAdmissionDescriptor {
  return {
    kind: admission.kind,
    source: admission.source,
    scopeKind: admission.scope.scopeKind,
    scopeId: admission.scope.scopeId,
    originId: admission.originId ?? null,
    capturedAt: admission.capturedAt ?? null,
    ttlMs: admission.ttlMs ?? null,
    contentLength: admission.content.length,
    labelLength: (admission.label ?? '').length,
  }
}
