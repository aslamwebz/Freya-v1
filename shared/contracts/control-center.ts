import type { ComponentHealth, ComponentName } from './runtime'
import type { ExplorerSnapshot } from './explorer'

export type ObservedState = 'healthy' | 'starting' | 'degraded' | 'disconnected' | 'stopped' | 'unavailable'
export interface ProcessObservation {
  component: ComponentName
  state: ObservedState
  pid: number | null
  source: string
  checkedAt: string
  lastSuccessAt: string | null
  health: ComponentHealth | null
  detail: string
}
export interface ControlCenterSnapshot {
  profile: string
  observations: ProcessObservation[]
  inventory?: ExplorerSnapshot
}
