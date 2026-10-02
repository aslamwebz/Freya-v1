import type {
  HandsActionRequest,
  HandsActionResult,
  HandsScopedCapabilityRef,
  HandsVerificationResult,
} from '../../../core/hands'
import { CAPABILITIES, type Capability } from '../../../core/protocol/core-protocol'
import { CORE_EVENT_TYPES } from '../../../core/events/envelope'

/**
 * PHASE 10 HANDS RED-TEAM CONTRACT.
 *
 * The production Hands domain now exists in `core/hands/`. This file no
 * longer invents compile-safe stand-ins: every type-level assertion below is
 * checked directly against the real contract exported by Core.
 */

export type Expect<T extends true> = T
export type Not<T extends boolean> = T extends true ? false : true
export type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type HasKey<T, K extends PropertyKey> = [Extract<K, keyof T>] extends [never] ? false : true

export const FORBIDDEN_ACTION_RESULT_NAMES = [
  'verdict',
  'verified',
  'established',
  'trusted',
  'authority',
  'grant',
  'capabilities',
  'principal',
  'actor',
] as const

export type ForbiddenActionResultName = (typeof FORBIDDEN_ACTION_RESULT_NAMES)[number]

interface HandsContractChecks {
  /** An action result cannot attest that its own intent was satisfied. */
  actionResultCarriesNoVerdict: Expect<
    Not<HasKey<HandsActionResult, ForbiddenActionResultName>>
  >

  /** Verification is a separate contract, not another spelling of result. */
  actionResultIsNotVerificationResult: Expect<
    Not<Equals<HandsActionResult, HandsVerificationResult>>
  >

  /** A verifier result cannot smuggle a grant, authority or executable input. */
  verificationCarriesNoGrantOrInput: Expect<
    Not<
      HasKey<
        HandsVerificationResult,
        'grant' | 'capabilities' | 'input' | 'principal' | 'authority' | 'trusted'
      >
    >
  >

  /** A request cannot name its own principal or authority. */
  requestCannotClaimIdentity: Expect<
    Not<
      HasKey<
        HandsActionRequest,
        'principal' | 'actor' | 'trusted' | 'authority' | 'grant' | 'capabilities'
      >
    >
  >

  /** A capability reference is an id+scope reference, never a permission object. */
  capabilityRefCannotClaimAuthority: Expect<
    Not<
      HasKey<
        HandsScopedCapabilityRef,
        'principal' | 'actor' | 'trusted' | 'authority' | 'grant' | 'capabilities'
      >
    >
  >

  /**
   * Hands has its own typed capability catalog. The older Core capability
   * vocabulary intentionally still contains no `hands.*` grant that a model,
   * page or worker could mint.
   */
  handsCapabilityAbsentToday: Expect<Equals<Extract<Capability, `hands.${string}`>, never>>

  /** Hands also has no generic durable `hands.*` event family today. */
  handsJournalAbsentToday: Expect<
    Equals<Extract<(typeof CORE_EVENT_TYPES)[number], `hands.${string}`>, never>
  >
}

export const HANDS_CONTRACT_CHECKS: HandsContractChecks = {
  actionResultCarriesNoVerdict: true,
  actionResultIsNotVerificationResult: true,
  verificationCarriesNoGrantOrInput: true,
  requestCannotClaimIdentity: true,
  capabilityRefCannotClaimAuthority: true,
  handsCapabilityAbsentToday: true,
  handsJournalAbsentToday: true,
}

export const HANDS_CONTRACT = Object.freeze({
  forbiddenAuthorityNames: FORBIDDEN_ACTION_RESULT_NAMES,
  handsCapabilitiesInVocabulary: CAPABILITIES.filter((c) => c.startsWith('hands.')),
  journalFamilyPresent: (CORE_EVENT_TYPES as readonly string[]).some((t) =>
    t.startsWith('hands.'),
  ),
})
