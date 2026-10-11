/** The three independently supervised application components. */
export type ComponentName = 'core' | 'freya' | 'superapp'

/** A component's own lifecycle claim; readiness still requires a health reply. */
export type ComponentLifecycle =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'

export type ComponentDependencyState = 'ready' | 'degraded' | 'unavailable'

/** A dependency observation safe to send to the local supervisor. */
export interface ComponentDependencyHealth {
  readonly state: ComponentDependencyState
  readonly checkedAt: string
  readonly reason?: string
}

/** A safe, actionable component issue. Messages must never include secrets or record bodies. */
export interface ComponentHealthIssue {
  readonly code: string
  readonly message: string
}

/** Fresh readiness evidence returned by a live component health endpoint. */
export interface ComponentHealth {
  readonly component: ComponentName
  readonly instanceId: string
  readonly pid: number
  readonly startedAt: string
  readonly lifecycle: ComponentLifecycle
  readonly checkedAt: string
  readonly lastProgressAt: string | null
  readonly dependencies: Readonly<Record<string, ComponentDependencyHealth>>
  readonly issues: readonly ComponentHealthIssue[]
}

/** Instance-bound local service request metadata; stale clients must be rejected. */
export interface ComponentInstanceReference {
  readonly component: ComponentName
  readonly instanceId: string
}
