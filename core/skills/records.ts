import type {
  SkillEvaluation,
  SkillKind,
  SkillRetirementReason,
  SkillSource,
  SkillStatus,
  SkillTrustClass,
  SkillVerificationState,
} from './types'

export interface SkillVersionMetadata {
  readonly version: number
  readonly contentHash: string
  readonly createdAt: string
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly stepCount: number
  readonly requiredCapabilityCount: number
  readonly applicabilityCount: number
  readonly inputCount: number
  readonly outputCount: number
  readonly preconditionCount: number
  readonly postconditionCount: number
  readonly summaryLength: number
  /** How many revisions this version spawned. The improvement loop's bound. */
  readonly revisions: number
}



export interface SkillFoldRecord {
  readonly skillId: string
  readonly name: string
  readonly nameLength: number
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly admittedAt: string
  readonly promotedAt: string | null
  readonly retiredAt: string | null
  readonly retirementReason: SkillRetirementReason | null
  /**
   * The declared applicability tags, as bounded slugs.
   *
   * Slugs rather than prose, so a tag can be journalled and matched on without
   * becoming a place a sentence could hide. This is the only content-bearing field
   * the fold holds for a skill, it is a list of `[a-z0-9-]` tokens of at most
   * `maxTagChars`, and the validator checks exactly that on replay.
   */
  readonly applicability: readonly string[]
  readonly versions: readonly SkillVersionMetadata[]
  readonly evaluations: readonly SkillEvaluation[]
  readonly executionsPlanned: number
  readonly updatedAt: string
}
