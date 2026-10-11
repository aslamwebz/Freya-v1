export const CORE_EVENT_TYPES = [
// Lifecycle
  'core.started',
'core.ready',
'core.degraded',
'core.integrity_fault',
'core.integrity_repaired',
'core.stopping',
'core.stopped',
] as const
export interface CoreLifecycleEventPayloads {
'core.started': { version: string; storeKind: string; recoveredSequence: number }

'core.ready': Record<string, never>

'core.degraded': { reason: string }

/**
   * A durable record that the journal was found corrupt.
   *
   * This is why a corrupt log stays failed closed. Recovery has to truncate the
   * damaged segment so the Core can still append, and truncating it would
   * otherwise leave a *clean* file that the next start would happily read as
   * healthy — with the STOP ALL that followed the damage already discarded.
   * Writing the fault into the trusted prefix makes it part of the journal, so
   * every subsequent start replays it and stays degraded until somebody acts.
   *
   * The damaged bytes are not thrown away: they are copied to a quarantine file
   * named here, so the evidence — including any event that came after the
   * damage — is still on disk to be read.
   */
  'core.integrity_fault': {
    reason: string
    /** The 1-indexed line where the damage was found. */
    line: number
    /** Where the original bytes were preserved. */
    quarantinePath: string
    /** Complete events that were read and believed, before the damage. */
    trustedPrefixEvents: number
    /** Bytes kept in the trusted prefix. */
    trustedPrefixBytes: number
    /** Bytes set aside as damaged. */
    damagedBytes: number
  }

/**
   * A code-owned repair of one fully recognised historical journal defect.
   * The original and the degraded replacement are both preserved on disk.
   */
  'core.integrity_repaired': {
    code: 'legacy-tool-loop-request-id' | 'voice-wake-threshold-validator' | 'interrupted-conversation-id-recovery'
    repairedEvents: number
    sourceQuarantinePath: string
    archivedDegradedPath: string | null
  }

'core.stopping': { reason: string }

'core.stopped': { durationMs: number }
}