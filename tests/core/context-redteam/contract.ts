import type { SourceTrust } from '../../../core/brain/types'
import type { MindContextInput } from '../../../core/mind/context-compiler'
import type { Principal } from '../../../core/security/guard'

/**
 * THE PHASE 9 CONTEXT CONTRACT, AS COMPILE-SAFE ASSUMPTIONS.
 *
 * Issue #15 owns the production Context domain. It does not exist on this
 * branch yet, so this lane must not invent it. What it *can* do is write down,
 * in a form the compiler checks, exactly what a Context implementation has to
 * satisfy for the security story to hold — and then attack the stable Core
 * boundaries that already enforce the same properties.
 *
 * Everything here is either:
 *
 *   - a **type** that describes a shape #15 is expected to produce, with
 *     compile-time assertions that the shape cannot carry authority; or
 *   - a **frozen runtime constant** naming a closed vocabulary; or
 *   - a **check object** whose property values are the literal `true`, so that
 *     if an assertion ever resolves to `false` the assignment stops compiling.
 *
 * The last part is the important one. A contract that only lives in a comment
 * rots silently. These assertions are evaluated when `CONTEXT_CONTRACT_CHECKS`
 * is checked, so a change that breaks the contract is a type error in this file
 * rather than a surprise in production.
 *
 * ## What is deliberately *not* here
 *
 * No resolver implementation, no store, no event family, no policy engine. The
 * moment this file started deciding what a context item *means*, it would be
 * implementing #15 through the back door. It describes the boundary and leaves
 * the behaviour to the lane that owns it.
 */

/* ------------------------------------------------------------ assertions */

/** Fails to compile unless `T` is exactly `true`. */
export type Expect<T extends true> = T

/** Boolean negation that does not silently widen to `boolean`. */
export type Not<T extends boolean> = T extends true ? false : true

/** Structural equality for the purposes of these assertions. */
export type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * Whether a key (or any key in a union) exists on a type.
 *
 * Written with `Extract` and a single-element tuple rather than
 * `K extends keyof T` so a union key cannot distribute into `boolean`. A
 * distributed check would make `Not<...>` return `boolean`, and `Expect<boolean>`
 * would fail for the wrong reason.
 */
export type HasKey<T, K extends PropertyKey> = [Extract<K, keyof T>] extends [never] ? false : true

/**
 * A scope string that contains a dot is a capability name, not a scope.
 *
 * Scopes describe *where* a context item came from; capabilities describe *what
 * a principal may do*. A context item that named a capability as its scope
 * would be one re-labelling away from looking like authority, so the two
 * vocabularies are kept disjoint at the type level.
 */
type ScopeHasNoDot<S extends string> = S extends `${string}.${string}` ? false : true

/* ------------------------------------------------------------ vocabulary */

/**
 * The context scopes this lane assumes #15 will resolve within.
 *
 * This is an **assumption, not a product decision**, and it is deliberately
 * small. It is drawn from the Phase 9 entry in `docs/ROADMAP.md` — active
 * application, explicit selection, an authorized file, a shared tab, the current
 * Mission and active agent work — and is expected to be reconciled with #15 when
 * it lands. The compile-time checks below only assert the properties this lane
 * relies on: the set is closed, and no member is a capability name.
 */
export const CONTEXT_SCOPES = [
  'active-application',
  'explicit-selection',
  'authorized-file',
  'shared-tab',
  'current-mission',
  'active-work',
] as const

export type ContextScope = (typeof CONTEXT_SCOPES)[number]

/**
 * Names a context record may never carry.
 *
 * The attack this guards against is the confused deputy in its smallest form: a
 * piece of context data that also happens to be shaped like a capability
 * decision. If a context item had a `capabilities` field, then something that
 * copied it into a principal would produce authority out of data.
 */
export const FORBIDDEN_AUTHORITY_NAMES = [
  'capabilities',
  'trusted',
  'authority',
  'grant',
  'grants',
  'principal',
  'capability',
] as const

export type ForbiddenAuthorityName = (typeof FORBIDDEN_AUTHORITY_NAMES)[number]

/* ----------------------------------------------------------------- specs */

/**
 * One resolved context item.
 *
 * `content` is the private payload — a window title, a selection, a file
 * excerpt. It lives *inside* the item so a caller that has resolved the item can
 * use it, and it is emphatically not a field any journal or activity row reads.
 *
 * `expiresAt` and `revokedAt` are part of the item rather than a policy object
 * beside it, because a context item with no TTL or revocation is a context item
 * that can never be withdrawn.
 */
export interface ContextItemContract {
  readonly contextId: string
  readonly scope: ContextScope
  /** The trust class the admitting pathway assigned. The Brain's vocabulary, reused. */
  readonly sourceTrust: SourceTrust
  readonly capturedAt: string
  /** Null only for context with no expiry, which must be a deliberate choice. */
  readonly expiresAt: string | null
  /** Set when the item was withdrawn before its TTL. */
  readonly revokedAt: string | null
  readonly content: string
}

/**
 * The result of trying to resolve a reference such as "this" or "here".
 *
 * The shape is the security property: `unresolved` and `refused` are first-class
 * outcomes with no `item`, so "I do not know what this means" cannot be
 * represented as a guess. A resolver that always returned an item would be a
 * resolver that invented referents.
 */
export type ContextResolutionContract =
  | { readonly status: 'resolved'; readonly item: ContextItemContract }
  | { readonly status: 'unresolved'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }

export type ResolvedContext = Extract<ContextResolutionContract, { status: 'resolved' }>
export type UnresolvedContext = Extract<ContextResolutionContract, { status: 'unresolved' }>

/**
 * A reference to be resolved.
 *
 * `scope` and `now` are required and explicit. There is deliberately no ambient
 * "current window" field: resolution is a function of what the caller passed, so
 * an ambiguous reference cannot be resolved against state the caller did not
 * choose to share.
 */
export interface ContextReferenceContract {
  readonly reference: string
  readonly scope: ContextScope
  /** The instant resolution is evaluated at. Passed, never read from a global clock. */
  readonly now: string
}

/**
 * The entire method surface a context resolver may expose.
 *
 * One method. No `grant`, no `authorize`, no `capability`, no way to widen a
 * scope or mint an allowance. A resolver resolves references; it does not decide
 * what Freya may do.
 */
export interface ContextResolverContract {
  resolve(reference: ContextReferenceContract): ContextResolutionContract
}

/* ----------------------------------------------------------------- checks */

/**
 * Compile-time checks, evaluated when `CONTEXT_CONTRACT_CHECKS` is checked.
 *
 * Each property must be the literal `true`. If one of the underlying assertions
 * becomes `false`, the property type becomes `false` and the `true` in the value
 * below stops compiling — which is the point.
 */
export type ContextContractChecks = {
  itemCarriesNoAuthority: Expect<Not<HasKey<ContextItemContract, ForbiddenAuthorityName>>>
  itemIsNotAPrincipal: Expect<Not<ContextItemContract extends Principal ? true : false>>
  itemTrustIsTheBrainVocabulary: Expect<Equals<ContextItemContract['sourceTrust'], SourceTrust>>
  itemCarriesTtl: Expect<HasKey<ContextItemContract, 'expiresAt'>>
  itemCarriesRevocation: Expect<HasKey<ContextItemContract, 'revokedAt'>>
  unresolvedCarriesNoItem: Expect<Not<HasKey<UnresolvedContext, 'item'>>>
  resolvedCarriesAnItem: Expect<HasKey<ResolvedContext, 'item'>>
  resolverExposesOnlyResolve: Expect<Equals<keyof ContextResolverContract, 'resolve'>>
  referenceNamesScopeAndClock: Expect<
    HasKey<ContextReferenceContract, 'scope'> extends true
      ? HasKey<ContextReferenceContract, 'now'>
      : false
  >
  scopesAreNotCapabilityNames: Expect<ScopeHasNoDot<ContextScope>>
}

/**
 * The check object. The values are all `true`; the types do the work.
 *
 * If this fails to compile, the Context contract has drifted and the lane has to
 * be updated deliberately rather than discovering it in a red-team run.
 */
export const CONTEXT_CONTRACT_CHECKS: ContextContractChecks = {
  itemCarriesNoAuthority: true,
  itemIsNotAPrincipal: true,
  itemTrustIsTheBrainVocabulary: true,
  itemCarriesTtl: true,
  itemCarriesRevocation: true,
  unresolvedCarriesNoItem: true,
  resolvedCarriesAnItem: true,
  resolverExposesOnlyResolve: true,
  referenceNamesScopeAndClock: true,
  scopesAreNotCapabilityNames: true,
}

/**
 * The Context Compiler is the stable seam closest to this phase, and its input
 * is the place an ambient context could be smuggled in.
 *
 * This asserts the input is exactly the explicit set. Adding an
 * `ambientWindow`, `activeApp` or `selection` field would break the compile,
 * because the compiler's whole safety argument is that it never reads anything
 * the caller did not pass it.
 */
export type ContextCompilerInputChecks = {
  compilerTakesOnlyExplicitInput: Expect<
    Equals<
      keyof MindContextInput,
      'identity' | 'history' | 'currentUserMessage' | 'runtimeFacts' | 'referenceKnowledge'
    >
  >
}

export const CONTEXT_COMPILER_INPUT_CHECKS: ContextCompilerInputChecks = {
  compilerTakesOnlyExplicitInput: true,
}

/**
 * The frozen runtime half of the contract.
 *
 * Kept separate from the compile-time checks so a test can assert the shape of
 * the contract without re-deriving it, and so the closed vocabularies are one
 * place rather than three string literals that drift.
 */
export const CONTEXT_CONTRACT = Object.freeze({
  /** Every field a context item must carry. A missing field is a contract break. */
  itemFields: [
    'contextId',
    'scope',
    'sourceTrust',
    'capturedAt',
    'expiresAt',
    'revokedAt',
    'content',
  ] as const,
  /** Every field a reference must carry. Scope and clock are not optional. */
  referenceFields: ['reference', 'scope', 'now'] as const,
  /**
   * The three resolution outcomes. `unresolved` and `refused` are the reason a
   * resolver can decline to guess rather than being forced to return an item.
   */
  resolutions: ['resolved', 'unresolved', 'refused'] as const,
  /** Fields that must never appear on a context item or resolver. */
  forbiddenAuthorityNames: FORBIDDEN_AUTHORITY_NAMES,
  /** The scopes assumed above, re-exported for the runtime assertions. */
  scopes: CONTEXT_SCOPES,
  /**
   * No `context.*` durable event family exists in the journal today.
   *
   * This is a fact about this branch, not a wish. It is pinned so that when #15
   * adds one, this lane is forced to look at it: a context event family has to
   * be metadata-only and exactly validated, or private context content gains a
   * slot in the least protected store in the system.
   */
  journalFamilyPresent: false,
})
