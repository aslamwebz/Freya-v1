import type { FailureKind } from './types'
import type { ResilienceFoldedState } from './state'

/**
 * Recovery planners for crash, data failure, and provider failure.
 *
 * Each planner is pure: same state + same clock = same plan. The runtime is
 * what journals the plan; the planner decides what should happen.
 */

/* ---------------------------------------------------------- crash recovery */

/**
 * The closed things crash recovery can do.
 */
export const CRASH_RECOVERY_ACTIONS = [
  'nothing-to-reconcile',
  'interrupted-operations-stopped',
  'stop-all-latched',
  'state-rebuilt-from-journal',
] as const

export type CrashRecoveryActionCode = (typeof CRASH_RECOVERY_ACTIONS)[number]

export interface CrashRecoveryAction {
  readonly code: CrashRecoveryActionCode
  readonly reason: string
}

export interface CrashRecoveryReport {
  readonly reconciled: boolean
  readonly actions: readonly CrashRecoveryAction[]
  readonly resumption: 'awaiting-wake'
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly recoveredAt: string
}

export interface CrashRecoveryInput {
  readonly state: ResilienceFoldedState
  readonly now: string
  readonly stopAllActive: boolean
}

const CRASH_ACTION_REASONS: Readonly<Record<CrashRecoveryActionCode, string>> = Object.freeze({
  'nothing-to-reconcile': 'No operations were in progress when the process ended.',
  'interrupted-operations-stopped':
    'Operations that were in progress when the process ended have been stopped and must be restarted.',
  'stop-all-latched': 'Freya was stopped when the process ended, and a restart is not the owner clearing that.',
  'state-rebuilt-from-journal': 'State has been rebuilt from the event journal.',
})

/**
 * Plan crash recovery.
 *
 * The rule: a process that died mid-operation cannot be resumed. What
 * happens instead is that every operation the journal left in a live state
 * is *recorded as interrupted*, durably, and left exactly where it was.
 */
export function planCrashRecovery(input: CrashRecoveryInput): CrashRecoveryReport {
  const { state, now, stopAllActive } = input

  if (stopAllActive) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'stop-all-latched',
          reason: CRASH_ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      recoveredAt: now,
    }
  }

  const hasActiveRecoveries = state.recoveries.some((r) => r.outcome === null)
  const hasActiveRepairs = state.repairs.some((r) => r.outcome === null)

  if (!hasActiveRecoveries && !hasActiveRepairs) {
    return {
      reconciled: false,
      actions: [
        {
          code: 'nothing-to-reconcile',
          reason: CRASH_ACTION_REASONS['nothing-to-reconcile'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    actions: [
      {
        code: 'interrupted-operations-stopped',
        reason: CRASH_ACTION_REASONS['interrupted-operations-stopped'],
      },
    ],
    resumption: 'awaiting-wake',
    requiresOwnerAction: true,
    stopAllActive: false,
    recoveredAt: now,
  }
}

/* ---------------------------------------------------------- data failure recovery */

/**
 * The closed things data failure recovery can do.
 */
export const DATA_RECOVERY_ACTIONS = [
  'nothing-to-quarantine',
  'corrupt-data-quarantined',
  'trusted-prefix-replayed',
  'stop-all-latched',
] as const

export type DataRecoveryActionCode = (typeof DATA_RECOVERY_ACTIONS)[number]

export interface DataRecoveryAction {
  readonly code: DataRecoveryActionCode
  readonly reason: string
}

export interface DataRecoveryReport {
  readonly reconciled: boolean
  readonly actions: readonly DataRecoveryAction[]
  readonly resumption: 'awaiting-wake'
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly recoveredAt: string
}

export interface DataRecoveryInput {
  readonly state: ResilienceFoldedState
  readonly now: string
  readonly stopAllActive: boolean
  readonly corruptionDetected: boolean
}

const DATA_ACTION_REASONS: Readonly<Record<DataRecoveryActionCode, string>> = Object.freeze({
  'nothing-to-quarantine': 'No data corruption was detected.',
  'corrupt-data-quarantined':
    'Corrupt data has been quarantined and the trusted prefix has been preserved.',
  'trusted-prefix-replayed': 'The trusted prefix has been replayed to rebuild state.',
  'stop-all-latched': 'Freya was stopped when the data failure was detected.',
})

/**
 * Plan data failure recovery.
 *
 * The rule: corrupt data is quarantined, never deleted. The trusted prefix
 * is replayed. Degraded mode is reported truthfully.
 */
export function planDataRecovery(input: DataRecoveryInput): DataRecoveryReport {
  const { now, stopAllActive, corruptionDetected } = input

  if (stopAllActive) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'stop-all-latched',
          reason: DATA_ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      recoveredAt: now,
    }
  }

  if (!corruptionDetected) {
    return {
      reconciled: false,
      actions: [
        {
          code: 'nothing-to-quarantine',
          reason: DATA_ACTION_REASONS['nothing-to-quarantine'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    actions: [
      {
        code: 'corrupt-data-quarantined',
        reason: DATA_ACTION_REASONS['corrupt-data-quarantined'],
      },
      {
        code: 'trusted-prefix-replayed',
        reason: DATA_ACTION_REASONS['trusted-prefix-replayed'],
      },
    ],
    resumption: 'awaiting-wake',
    requiresOwnerAction: true,
    stopAllActive: false,
    recoveredAt: now,
  }
}

/* ---------------------------------------------------------- provider failure recovery */

/**
 * The closed things provider failure recovery can do.
 */
export const PROVIDER_RECOVERY_ACTIONS = [
  'no-failure-detected',
  'fallback-to-approved-provider',
  'retry-with-backoff',
  'escalate-to-owner',
  'stop-all-latched',
] as const

export type ProviderRecoveryActionCode = (typeof PROVIDER_RECOVERY_ACTIONS)[number]

export interface ProviderRecoveryAction {
  readonly code: ProviderRecoveryActionCode
  readonly reason: string
}

export interface ProviderRecoveryReport {
  readonly reconciled: boolean
  readonly actions: readonly ProviderRecoveryAction[]
  readonly resumption: 'awaiting-wake'
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly recoveredAt: string
}

export interface ProviderRecoveryInput {
  readonly state: ResilienceFoldedState
  readonly now: string
  readonly stopAllActive: boolean
  readonly providerFailed: boolean
  readonly retryCount: number
  readonly maxRetries: number
}

const PROVIDER_ACTION_REASONS: Readonly<Record<ProviderRecoveryActionCode, string>> = Object.freeze(
  {
    'no-failure-detected': 'No provider failure was detected.',
    'fallback-to-approved-provider':
      'The current provider failed and the request has been retried with an owner-approved fallback provider.',
    'retry-with-backoff': 'The request is being retried with bounded exponential backoff.',
    'escalate-to-owner':
      'The provider failure is unrecoverable and the owner has been notified.',
    'stop-all-latched': 'Freya was stopped when the provider failure was detected.',
  },
)

/**
 * Plan provider failure recovery.
 *
 * The rule: fallback only to owner-approved providers, retry with bounded
 * backoff, escalate to owner if unrecoverable. Never add new providers.
 */
export function planProviderRecovery(input: ProviderRecoveryInput): ProviderRecoveryReport {
  const { now, stopAllActive, providerFailed, retryCount, maxRetries } = input

  if (stopAllActive) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'stop-all-latched',
          reason: PROVIDER_ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      recoveredAt: now,
    }
  }

  if (!providerFailed) {
    return {
      reconciled: false,
      actions: [
        {
          code: 'no-failure-detected',
          reason: PROVIDER_ACTION_REASONS['no-failure-detected'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  if (retryCount >= maxRetries) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'escalate-to-owner',
          reason: PROVIDER_ACTION_REASONS['escalate-to-owner'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    actions: [
      {
        code: 'fallback-to-approved-provider',
        reason: PROVIDER_ACTION_REASONS['fallback-to-approved-provider'],
      },
      {
        code: 'retry-with-backoff',
        reason: PROVIDER_ACTION_REASONS['retry-with-backoff'],
      },
    ],
    resumption: 'awaiting-wake',
    requiresOwnerAction: false,
    stopAllActive: false,
    recoveredAt: now,
  }
}

/* ---------------------------------------------------------- backup/restore */

/**
 * The closed things backup/restore can do.
 */
export const BACKUP_RESTORE_ACTIONS = [
  'backup-created',
  'backup-verified',
  'restore-completed',
  'restore-failed',
  'backup-corrupt',
  'stop-all-latched',
] as const

export type BackupRestoreActionCode = (typeof BACKUP_RESTORE_ACTIONS)[number]

export interface BackupRestoreAction {
  readonly code: BackupRestoreActionCode
  readonly reason: string
}

export interface BackupRestoreReport {
  readonly reconciled: boolean
  readonly actions: readonly BackupRestoreAction[]
  readonly resumption: 'awaiting-wake'
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly recoveredAt: string
}

export interface BackupRestoreInput {
  readonly state: ResilienceFoldedState
  readonly now: string
  readonly stopAllActive: boolean
  readonly operation: 'backup' | 'restore'
  readonly backupVerified: boolean
}

const BACKUP_ACTION_REASONS: Readonly<Record<BackupRestoreActionCode, string>> = Object.freeze({
  'backup-created': 'An encrypted backup has been created and verified.',
  'backup-verified': 'The backup has been verified against its checksum.',
  'restore-completed': 'The restore has completed and the restored state has been validated.',
  'restore-failed': 'The restore failed validation and was rolled back.',
  'backup-corrupt': 'The backup is corrupt and cannot be used for restore.',
  'stop-all-latched': 'Freya was stopped during the backup/restore operation.',
})

/**
 * Plan backup/restore.
 *
 * The rule: backups are encrypted and verified. Restores are validated before
 * being declared successful. Corrupt backups are refused.
 */
export function planBackupRestore(input: BackupRestoreInput): BackupRestoreReport {
  const { now, stopAllActive, operation, backupVerified } = input

  if (stopAllActive) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'stop-all-latched',
          reason: BACKUP_ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      recoveredAt: now,
    }
  }

  if (operation === 'backup') {
    return {
      reconciled: true,
      actions: [
        {
          code: 'backup-created',
          reason: BACKUP_ACTION_REASONS['backup-created'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  // Restore operation
  if (!backupVerified) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'backup-corrupt',
          reason: BACKUP_ACTION_REASONS['backup-corrupt'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    actions: [
      {
        code: 'restore-completed',
        reason: BACKUP_ACTION_REASONS['restore-completed'],
      },
    ],
    resumption: 'awaiting-wake',
    requiresOwnerAction: false,
    stopAllActive: false,
    recoveredAt: now,
  }
}

/* ---------------------------------------------------------- repair workflows */

/**
 * The closed things repair workflows can do.
 */
export const REPAIR_WORKFLOW_ACTIONS = [
  'no-repair-needed',
  'repair-authorized',
  'repair-executed',
  'repair-verified',
  'repair-unauthorized',
  'stop-all-latched',
] as const

export type RepairWorkflowActionCode = (typeof REPAIR_WORKFLOW_ACTIONS)[number]

export interface RepairWorkflowAction {
  readonly code: RepairWorkflowActionCode
  readonly reason: string
}

export interface RepairWorkflowReport {
  readonly reconciled: boolean
  readonly actions: readonly RepairWorkflowAction[]
  readonly resumption: 'awaiting-wake'
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly recoveredAt: string
}

export interface RepairWorkflowInput {
  readonly state: ResilienceFoldedState
  readonly now: string
  readonly stopAllActive: boolean
  readonly repairNeeded: boolean
  readonly authorized: boolean
}

const REPAIR_ACTION_REASONS: Readonly<Record<RepairWorkflowActionCode, string>> = Object.freeze({
  'no-repair-needed': 'No repair is needed.',
  'repair-authorized': 'The repair has been authorized by the owner.',
  'repair-executed': 'The repair has been executed within authority.',
  'repair-verified': 'The repair outcome has been verified.',
  'repair-unauthorized': 'The repair was not authorized and was refused.',
  'stop-all-latched': 'Freya was stopped when the repair was requested.',
})

/**
 * Plan repair workflow.
 *
 * The rule: consequential repairs require owner approval. Repairs are
 * verified before being declared successful. Unauthorized repairs are refused.
 */
export function planRepairWorkflow(input: RepairWorkflowInput): RepairWorkflowReport {
  const { now, stopAllActive, repairNeeded, authorized } = input

  if (stopAllActive) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'stop-all-latched',
          reason: REPAIR_ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      recoveredAt: now,
    }
  }

  if (!repairNeeded) {
    return {
      reconciled: false,
      actions: [
        {
          code: 'no-repair-needed',
          reason: REPAIR_ACTION_REASONS['no-repair-needed'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  if (!authorized) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'repair-unauthorized',
          reason: REPAIR_ACTION_REASONS['repair-unauthorized'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    actions: [
      {
        code: 'repair-authorized',
        reason: REPAIR_ACTION_REASONS['repair-authorized'],
      },
      {
        code: 'repair-executed',
        reason: REPAIR_ACTION_REASONS['repair-executed'],
      },
      {
        code: 'repair-verified',
        reason: REPAIR_ACTION_REASONS['repair-verified'],
      },
    ],
    resumption: 'awaiting-wake',
    requiresOwnerAction: false,
    stopAllActive: false,
    recoveredAt: now,
  }
}

/* ---------------------------------------------------------- degraded mode */

/**
 * The closed things degraded mode can do.
 */
export const DEGRADED_MODE_ACTIONS = [
  'no-degradation',
  'degraded-mode-entered',
  'degraded-mode-exited',
  'stop-all-latched',
] as const

export type DegradedModeActionCode = (typeof DEGRADED_MODE_ACTIONS)[number]

export interface DegradedModeAction {
  readonly code: DegradedModeActionCode
  readonly reason: string
}

export interface DegradedModeReport {
  readonly reconciled: boolean
  readonly actions: readonly DegradedModeAction[]
  readonly resumption: 'awaiting-wake'
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly recoveredAt: string
}

export interface DegradedModeInput {
  readonly state: ResilienceFoldedState
  readonly now: string
  readonly stopAllActive: boolean
  readonly degradationDetected: boolean
  readonly currentLevel: string
}

const DEGRADED_ACTION_REASONS: Readonly<Record<DegradedModeActionCode, string>> = Object.freeze({
  'no-degradation': 'No degradation was detected.',
  'degraded-mode-entered': 'Degraded mode has been entered truthfully.',
  'degraded-mode-exited': 'Degraded mode has been exited.',
  'stop-all-latched': 'Freya was stopped when degradation was detected.',
})

/**
 * Plan degraded mode.
 *
 * The rule: degradation is never hidden. The level is reported truthfully.
 * Capability is never fabricated.
 */
export function planDegradedMode(input: DegradedModeInput): DegradedModeReport {
  const { now, stopAllActive, degradationDetected } = input

  if (stopAllActive) {
    return {
      reconciled: true,
      actions: [
        {
          code: 'stop-all-latched',
          reason: DEGRADED_ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      recoveredAt: now,
    }
  }

  if (!degradationDetected) {
    return {
      reconciled: false,
      actions: [
        {
          code: 'no-degradation',
          reason: DEGRADED_ACTION_REASONS['no-degradation'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    actions: [
      {
        code: 'degraded-mode-entered',
        reason: DEGRADED_ACTION_REASONS['degraded-mode-entered'],
      },
    ],
    resumption: 'awaiting-wake',
    requiresOwnerAction: true,
    stopAllActive: false,
    recoveredAt: now,
  }
}

/* ---------------------------------------------------------- helpers */

/**
 * Is this a failure kind that means work was in progress?
 */
export function isLiveFailureKind(kind: FailureKind): boolean {
  return kind === 'crash' || kind === 'data-corruption' || kind === 'provider-failure'
}


