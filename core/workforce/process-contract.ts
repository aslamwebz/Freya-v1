import type { AnyCoreEvent } from '../events/envelope'
import type { PrincipalId } from '../../shared/contracts/identity'
import type { WorkforceEngineOptions } from './engine'
export interface WorkforcePacket {
  version: 1; id: string; events: AnyCoreEvent[]; principalId: PrincipalId; stopped: boolean
  limits: WorkforceEngineOptions['limits']
}
