import type { BrainState, BrainStore } from './store'

const maps = ['entities', 'relations', 'observations', 'candidates', 'memories', 'reviews', 'ownership', 'experiences'] as const
export interface BrainPacket {
  version: 1
  mode: BrainStore['mode']
  faultReason: string | null
  degradedReason: string | null
  health: ReturnType<BrainStore['health']>
  identity: BrainState['identity']
  self: BrainState['self']
  sequence: number
  maps: { [K in typeof maps[number]]: Array<[string, BrainState[K] extends Map<string, infer V> ? V : never]> }
}

export function brainPacket(store: BrainStore): BrainPacket {
  const state = store.state()
  return { version: 1, mode: store.mode, faultReason: store.faultReason, degradedReason: store.degradedReason, health: store.health(),
    identity: state.identity, self: state.self, sequence: state.sequence,
    maps: Object.fromEntries(maps.map(key => [key, [...state[key].entries()]])) as BrainPacket['maps'] }
}

export function brainState(packet: BrainPacket): BrainState {
  if (packet.version !== 1) throw new Error('unsupported memory transport version')
  return { identity: packet.identity, self: packet.self, sequence: packet.sequence,
    ...Object.fromEntries(maps.map(key => [key, new Map(packet.maps[key] as Array<[string, unknown]>)])) } as BrainState
}
