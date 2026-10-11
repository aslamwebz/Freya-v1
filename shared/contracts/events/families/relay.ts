export const RELAY_EVENT_TYPES = [
// Relay (Phase 16) — metadata only, and the family where the target is the
  // most that may be recorded.
  'relay.action.requested',
'relay.approval.requested',
'relay.approval.decided',
'relay.approval.expired',
'relay.action.executed',
'relay.action.failed',
'relay.action.cancelled',
'relay.connector.faulted',
'relay.limits.exceeded',
] as const
