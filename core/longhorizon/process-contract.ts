import type { AnyCoreEvent } from '../events/envelope'
import type { PrincipalId } from '../../shared/contracts/identity'
import type { GoalStore } from './store'
import type { GoalProjection } from './types'

export interface GoalPacket {
  version: 1; id: string; events: AnyCoreEvent[]; principalId: PrincipalId; stopped: boolean
  store: { mode: GoalStore['mode']; durable: boolean; faultReason: string | null; health: ReturnType<GoalStore['health']> }
}
export interface GoalViewPacket { projection: GoalProjection; eligible: string[] }
