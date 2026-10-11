import type { BrainRecord, BrainStore } from './store'
import type { IdentityRoot, SelfDefinition } from './types'

/** The existing immutable identity bootstrap, shared with the protected store owner. */
export async function seedBrain(store: BrainStore, definition: { identity: IdentityRoot; self: SelfDefinition }, write: (record: BrainRecord) => Promise<BrainRecord> = record => store.write(record)): Promise<boolean> {
  if (store.health().health !== 'healthy') return false
  let wrote = false
  if (store.state().identity === null) { await write({ kind: 'identity-root', identity: definition.identity }); wrote = true }
  if (store.state().self === null) { await write({ kind: 'self-definition', definition: definition.self }); wrote = true }
  return wrote
}
