/** Private content: encrypted with the goal, never placed in event payloads. */
export interface MissionExecutionPlan {
  readonly planId: string
  readonly continueAfterVerification: boolean
  readonly steps: readonly {
    readonly stepId: string
    readonly capability: string
    readonly verifier: string
    readonly intent: string
    readonly input: Record<string, unknown>
  }[]
  readonly consideredLessons?: readonly string[]
  readonly adaptiveRationale?: string | null
}
