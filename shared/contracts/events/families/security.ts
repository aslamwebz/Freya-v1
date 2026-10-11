import type { PrincipalId } from '../../identity'
export const SECURITY_EVENT_TYPES = [
'security.stop_all.activated',
'security.stop_all.cleared',
] as const
export interface SecurityEventPayloads {
'security.stop_all.activated': { by: PrincipalId; reason: string }

'security.stop_all.cleared': { by: PrincipalId }
}