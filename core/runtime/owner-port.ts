import type { RpcPeer } from '../../shared/runtime/rpc'
import type { CapabilityEnv } from '../model/capability-runtime'

/** Concrete desktop operations that retain their existing host admission checks. */
export interface CoreOwnerPort {
  connect(peer: RpcPeer, descriptors: unknown): void
  configure(env: CapabilityEnv): Promise<void>
  refreshPreferences(): Promise<void>
  capabilities(): unknown
  deviceHands(request: unknown): Promise<unknown>
  ownerBrowser(request: unknown): Promise<unknown>
  browserJournal(operation: 'status' | 'append' | 'replay', value?: unknown): unknown
}
