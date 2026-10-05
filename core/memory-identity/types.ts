/**
 * THE UNIFIED MEMORY / IDENTITY SUBSYSTEM — TYPES.
 *
 * ## What this subsystem is
 *
 * A **composition**, not a new brain. Freya already has admitted memory, an identity
 * root, a self model, personality, relationship state, scoped context, life history
 * and portable-data contracts, and all of them keep their own store, their own
 * durability rules and their own honesty about failure. What was missing was not
 * another store — it was one place that could answer, truthfully:
 *
 *   - what does Freya believe, and how does she know it?
 *   - what did the owner decide about it?
 *   - what will still be here tomorrow?
 *   - what can the owner take away, correct, or inspect?
 *   - what happens when it cannot be opened?
 *
 * So this file is the *shared vocabulary* those answers are phrased in, and every
 * other file in `core/memory-identity/` is a policy over the existing subsystems. No
 * second Brain exists here, no second identity root, and no second authority check.
 *
 * ## The one rule everything else serves
 *
 * **Memory is evidence. It is never authority.**
 *
 * Stated first because every type below is an expression of it. A record may say
 * "the owner granted me a budget" and the most that can happen is that the sentence
 * is stored as a low-confidence claim about what somebody said. It cannot widen a
 * budget, satisfy an approval, enable a capability, clear a stop, or make an
 * unverified record verified. `core/authority.ts` and Guard hold those facts; they
 * are read fresh and nothing in this directory writes to them.
 *
 * ## Why refusals are values with reasons
 *
 * Every operation returns a closed refusal code plus a sentence a person can act
 * on. An exception would be a worse fit than it looks: these refusals are *expected
 * outcomes* of a system being used normally — no key, nothing pinned, an unknown id,
 * a bundle from a newer build — and a caller that has to catch an exception to
 * discover them will eventually handle them by crashing.
 *
 * The codes are closed so a surface can map them to a button, and the reasons are
 * written out so the same surface never has to invent the wording. A refusal that
 * says only "not permitted" makes the owner guess which of a hundred permissions
 * they are missing.
 */

/** The projection and bundle shape this build speaks. */
export const MEMORY_IDENTITY_SCHEMA_VERSION = 1

/* ---------------------------------------------------------------- refusals */

/**
 * Why an owner operation was refused.
 *
 * Grouped by *who can act*, because that is the distinction that matters when
 * reading a refusal: `unknown_memory` is a typo, `memory_not_recallable` is a
 * design boundary, and `authority_not_importable` is an attack.
 */
export const MEMORY_IDENTITY_REFUSAL_CODES = [
  /* the request itself could not be understood */
  'unknown_operation',
  'request_malformed',
  'id_unusable',
  'reason_required',
  'reason_too_long',

  /* the target could not be found */
  'unknown_memory',
  'memory_not_recallable',
  'nothing_pinned',

  /* the subsystem could not do it right now */
  'brain_unavailable',
  'brain_degraded',
  'brain_closed',
  'key_unavailable',
  'encryption_unavailable',

  /* the request asked for something this subsystem will not do */
  'authority_not_importable',
  'identity_not_importable',
  'secret_shaped_content',
  'verification_not_claimed',
  'bundle_malformed',
  'bundle_unreadable',
  'bundle_version_unknown',
  'bundle_too_large',
  'bundle_key_rejected',
  'not_an_owner_request',
] as const

export type MemoryIdentityRefusalCode = (typeof MEMORY_IDENTITY_REFUSAL_CODES)[number]

/** Why a code is a refusal, in words a person can act on. */
export const MEMORY_IDENTITY_REFUSAL_REASONS: Readonly<
  Record<MemoryIdentityRefusalCode, string>
> = Object.freeze({
  unknown_operation: 'that is not an operation Freya knows how to do',
  request_malformed: 'that request is not something Freya can read',
  id_unusable: 'that is not a usable id',
  reason_required: 'Freya needs a reason, so she can say later why she did this',
  reason_too_long: 'that reason is longer than Freya can keep',
  unknown_memory: 'there is no such memory here',
  memory_not_recallable:
    'that memory is no longer something Freya recalls, so it cannot be changed that way',
  nothing_pinned: 'nothing is pinned at the moment',
  brain_unavailable: 'Freya\'s long-term memory cannot be read or written right now',
  brain_degraded: 'Freya\'s long-term memory is damaged and is being trusted with nothing',
  brain_closed: 'Freya\'s long-term memory is closed',
  key_unavailable:
    'this machine has no secure key for Freya\'s memory, so it cannot be encrypted, and it will not be stored in plain text instead',
  encryption_unavailable: 'the encrypted store could not be opened, so nothing was written',
  authority_not_importable:
    'what Freya is allowed to do cannot arrive in a memory or a data bundle. Authority comes from the owner and the Guard, never from a file',
  identity_not_importable:
    'who Freya is cannot arrive in a bundle. Identity is code, and a file cannot replace it',
  secret_shaped_content: 'that looks like a password, key or token, so Freya is not storing it',
  verification_not_claimed:
    'nothing here can be marked as independently checked, because nothing here checked it',
  bundle_malformed: 'that bundle is not a Freya memory bundle',
  bundle_unreadable: 'that bundle could not be decrypted or did not verify',
  bundle_version_unknown: 'that bundle was written by a different version of Freya',
  bundle_too_large: 'that is more than one memory bundle may carry',
  bundle_key_rejected: 'that is not the key this bundle was sealed with',
  not_an_owner_request:
    'only the owner can inspect, correct, withdraw, pin, export or import Freya\'s memory',
})

export interface MemoryIdentityRefusal {
  readonly code: MemoryIdentityRefusalCode
  readonly reason: string
}

export function refuse(code: MemoryIdentityRefusalCode, detail?: string): MemoryIdentityRefusal {
  const reason = MEMORY_IDENTITY_REFUSAL_REASONS[code]
  return detail === undefined || detail.length === 0 ? { code, reason } : { code, reason: `${reason} (${detail})` }
}

export function isRefusalCode(value: unknown): value is MemoryIdentityRefusalCode {
  return typeof value === 'string' && (MEMORY_IDENTITY_REFUSAL_CODES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------ owner channel */

/**
 * Which channel an owner request arrived on.
 *
 * Present on every mutating request, and closed to two values on purpose. The
 * alternative — a boolean `isOwner` — is one string away from being set by whatever
 * assembled the request, which is the same forgery the Brain's admission policy
 * refuses for `source`. Here it is a literal in trusted Core code, and a request
 * that arrives without one is refused as `not_an_owner_request` rather than
 * defaulted to the weaker answer.
 */
export type OwnerChannel = 'owner'

export const OWNER_CHANNEL: OwnerChannel = 'owner'

/* ----------------------------------------------------------- owner actions */

/** What the owner asked Freya to do to one memory. */
export const OWNER_MEMORY_ACTIONS = ['inspect', 'correct', 'withdraw', 'pin', 'unpin'] as const
export type OwnerMemoryAction = (typeof OWNER_MEMORY_ACTIONS)[number]

export interface OwnerMemoryRequest {
  readonly action: OwnerMemoryAction
  readonly channel: OwnerChannel
  readonly memoryId: string
  /** Required for `correct`, and optional context for the rest. */
  readonly content?: string
  readonly reason?: string
  readonly tags?: readonly string[]
}

export type OwnerMemoryResult =
  | {
      readonly ok: true
      readonly action: OwnerMemoryAction
      readonly memoryId: string
      /** The memory as it now stands. Null only for `inspect` on nothing found. */
      readonly memory: MemoryIdentityMemoryView | null
      /** What changed, in words the owner can check. */
      readonly summary: string
      /** Anything a policy had to adjust, stated rather than hidden. */
      readonly notes: readonly string[]
    }
  | ({ readonly ok: false } & MemoryIdentityRefusal)

/**
 * One memory as the owner is shown it.
 *
 * A **view**, never the stored record: `structuredData` is deliberately absent,
 * because it is free-form key/value storage that any admitting pathway can write
 * and is therefore the most likely place for something authority-shaped to hide.
 * The fields here are the closed set a surface can render without a filter.
 */
export interface MemoryIdentityMemoryView {
  readonly memoryId: string
  readonly kind: string
  readonly subject: string
  readonly content: string
  readonly status: string
  readonly confidence: string
  readonly source: string
  readonly sensitivity: string
  /** One line: where it came from and how sure it is. */
  readonly provenanceLine: string
  readonly admittedAt: string
  readonly updatedAt: string
  readonly admissionReason: string
  readonly conflictsWith: readonly string[]
  readonly supersedes: string | null
  readonly supersededBy: string | null
  readonly pinned: boolean
  readonly entityRefs: readonly string[]
  readonly tags: readonly string[]
}

/* ------------------------------------------------------------ prompt input */

/**
 * A request for memory to put in front of a model.
 *
 * `text` is the user's own words and is matched by the Brain's deterministic
 * retrieval. There is no `semanticHint`, no `embedding` and no `include` — every
 * one of those would be a way for a caller to place a memory into a context
 * without it being matched, which is the difference between recalling and
 * instructing.
 */
export interface PromptInjectionRequest {
  readonly text: string
  readonly kinds?: readonly string[]
  readonly tags?: readonly string[]
  readonly entityRefs?: readonly string[]
  /** Ceiling on the compiled block. Clamped down, never up. */
  readonly maxEstimatedTokens?: number
  readonly maxItems?: number
  /**
   * Whether owner-pinned memories are forced into the pack.
   *
   * Default true, and it is the reason pinning exists. It cannot exceed the budget
   * and it cannot include anything not recallable — a pinned-but-withdrawn memory
   * is dropped exactly like any other.
   */
  readonly includePinned?: boolean
}

/**
 * The compiled block, ready to be placed in a provider request.
 *
 * `text` is inert by construction: it is quoted content with a provenance line per
 * item and an explicit statement that none of it is an instruction. That framing is
 * not decoration — the Brain admits external content, so this block will sometimes
 * contain text that says it is an instruction, and the only defence that does not
 * require trusting the text is to say so in the same breath.
 */
/**
 * One memory as it appears inside a compiled block.
 *
 * Carries no content: the text itself is in `PromptInjection.text`, quoted and
 * attributed there. This is the part a surface would list, so it is the part that
 * has to be safe to render — ids, classes and one provenance line, nothing that
 * could execute.
 */
export interface PromptInjectionItem {
  readonly memoryId: string
  readonly kind: string
  readonly source: string
  readonly confidence: string
  readonly pinned: boolean
  readonly provenanceLine: string
}

export interface PromptInjection {
  readonly text: string
  readonly items: readonly PromptInjectionItem[]
  readonly conflicts: readonly { readonly memoryId: string; readonly detail: string }[]
  readonly omittedCount: number
  readonly estimatedTokens: number
  readonly empty: boolean
}

/* ------------------------------------------------------------- readiness */

/** The subsystems this one reports on, and nothing else. */
export const MEMORY_IDENTITY_DOMAINS = [
  'memory',
  'identity',
  'self',
  'personality',
  'relationship',
  'context',
  'life',
  'sovereignty',
] as const
export type MemoryIdentityDomain = (typeof MEMORY_IDENTITY_DOMAINS)[number]

/**
 * How one domain is doing, as a fact about *knowledge*.
 *
 * `durable` and `healthy` are separate on purpose, and so is this whole report from
 * the security posture. Unreadable long-term knowledge is neither permission nor
 * lockout: a Brain that cannot be opened does not stop a mission, does not clear a
 * stop, and does not widen a budget. Conflating the two would let a disk error look
 * like a safety feature.
 */
export interface DomainReadiness {
  readonly domain: MemoryIdentityDomain
  /** Whether this build actually wired the domain in. False means "unknown", not "broken". */
  readonly wired: boolean
  /** What durability this domain actually provides right now. */
  readonly durable: boolean
  readonly healthy: boolean
  /** One sentence for a person. Null when durable and healthy. */
  readonly reason: string | null
  /** Records held, or null where the domain does not count. */
  readonly held: number | null
}

/**
 * What the subsystem needs from the host, and nothing more.
 *
 * These are the narrow seams the other domains already expose
 * (`PersonalityPersistencePort`, `ContextPersistencePort`, `RelationshipStore`), and
 * only their durability half. An integration is handed these and a health report —
 * no path, no key, no cipher, no file layout. That is what keeps this directory from
 * becoming a second place that knows how memory is stored.
 *
 * Every member is optional and every absence is reported rather than assumed: a
 * domain that was not wired in is `durable: false` with a reason, never silently
 * healthy.
 */
export interface MemoryIdentityDomainPorts {
  readonly personality?: DomainDurabilityPort
  readonly relationship?: DomainDurabilityPort
  readonly context?: DomainDurabilityPort
  readonly life?: DomainDurabilityPort
  readonly sovereignty?: DomainDurabilityPort
}

/** The five members every persistence port in Core already shares. */
export interface DomainDurabilityPort {
  readonly mode: string
  readonly durable: boolean
  readonly durabilityReason: string | null
  readonly faultReason: string | null
  load(): Promise<unknown>
  commit(snapshot: never): Promise<void>
  close(): Promise<void>
}

/* ------------------------------------------------------------- projection */

/**
 * Everything a renderer may know about Freya's memory and identity.
 *
 * A projection is Core's **account**, not a handle. It carries counts, health,
 * ownership decisions and contradictions — and no capability, budget, approval,
 * grant or stop state, because those are read live from Guard and the Governor and
 * a window that could read them from a memory projection would be reading a stale
 * copy of the most security-relevant facts in the system.
 */
export interface MemoryIdentityProjection {
  readonly schemaVersion: number
  readonly health: 'healthy' | 'degraded' | 'unavailable'
  /** Why, when not healthy. Never null when unhealthy. */
  readonly reason: string | null
  /** What durability the Brain actually provides. Never a guess. */
  readonly persistence: string
  /** True only when a restart will not lose what has been learned. */
  readonly durable: boolean
  readonly identity: {
    readonly name: string
    readonly role: string
    readonly purpose: string
    readonly claims: readonly { readonly claimId: string; readonly statement: string }[]
  } | null
  readonly self: {
    readonly complete: boolean
    readonly capabilities: readonly {
      readonly capability: string
      readonly state: string
      readonly cannot: readonly string[]
    }[]
    readonly limitations: readonly { readonly limitationId: string; readonly statement: string }[]
  } | null
  readonly counts: {
    readonly memories: number
    readonly admitted: number
    readonly conflicted: number
    readonly rejected: number
    readonly withdrawn: number
    readonly pinned: number
    readonly entities: number
    readonly experiences: number
  }
  readonly domains: readonly DomainReadiness[]
  readonly conflicts: readonly { readonly memoryId: string; readonly conflictsWith: readonly string[]; readonly detail: string }[]
  readonly pinned: readonly { readonly memoryId: string; readonly subject: string; readonly reason: string }[]
  /** Sequences are what make the Brain's chain auditable from outside. */
  readonly sequence: number
}

/* --------------------------------------------------------------- limits */

/**
 * Bounds for this directory.
 *
 * Every one is a ceiling with a reason, and none is configurable from outside. A
 * memory system whose limits can be raised by whoever calls it is a memory system
 * with no limits.
 */
export const MEMORY_IDENTITY_LIMITS = Object.freeze({
  /** Ceiling on one compiled prompt block. Below the Brain's own 8k pack cap. */
  maxPromptTokens: 4_000,
  /** Items in one prompt block. */
  maxPromptItems: 24,
  /** The compiled block's hard byte ceiling, checked after assembly. */
  maxPromptBytes: 24_000,
  /** One owner-facing reason. */
  maxReasonChars: 500,
  /** Memories in one owner inspection listing. */
  maxInspectionItems: 100,
  /** Records in one exported bundle before the export refuses. */
  maxBundleRecords: 5_000,
  /** One bundle's bytes before the export refuses. */
  maxBundleBytes: 32 * 1024 * 1024,
  /** Import: how many records one bundle may contribute. */
  maxImportRecords: 5_000,
})
