import type { AnyCoreEvent } from '../events/envelope'
import type { RunRecord, StepRecord } from '../work/types'
import type { MissionStore } from './store'
import type { MissionEngine } from './engine'
import type { PrincipalId } from '../../shared/contracts/identity'

export type MissionRuntime = Pick<MissionEngine, keyof MissionEngine>
export interface MissionWorkPacket { revision: number; runs: RunRecord[]; steps: Array<{ runId: string; steps: readonly StepRecord[] }> }
export interface MissionPacket {
  version: 1; id: string; events: AnyCoreEvent[]; principalId: PrincipalId; stopped: boolean; work: MissionWorkPacket
  store: { mode: MissionStore['mode']; durable: boolean; faultReason: string | null; health: ReturnType<MissionStore['health']> }
}
