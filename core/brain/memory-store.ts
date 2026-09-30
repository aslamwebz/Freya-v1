import { BrainStoreError, emptyBrainState, type BrainHealth, type BrainRecord, type BrainState, type BrainStore } from './store'
import { applyRecord, assertRecordSize, validateRecord } from './fold'

/**
 * The in-memory Brain Store.
 *
 * Two jobs, both honest. Tests use it so a Brain test does not need an encryption
 * round trip in the way. And it is the **ephemeral production mode**: when the
 * host has no secure key, Freya still has a working Brain for the session and says
 * plainly that nothing will be remembered across a restart.
 *
 * It is never a silent substitute for the encrypted store. The mode is reported,
 * the reason is reported, and the surface shows it — a person is entitled to know
 * that Freya is not going to remember before they tell her something.
 *
 * No indexes are precomputed here. Retrieval is cheap over a few thousand records
 * and precomputing an index for a store that may hold a hundred records would be
 * machinery without a problem to solve.
 */
export class MemoryBrainStore implements BrainStore {
  readonly mode: 'ephemeral' | 'memory'
  readonly faultReason: string | null
  readonly degradedReason: string | null = null

  private readonly brain: BrainState
  private closed = false

  constructor(options: { mode?: 'ephemeral' | 'memory'; faultReason?: string | null } = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.brain = emptyBrainState()
  }

  async write(record: BrainRecord): Promise<BrainRecord> {
    if (this.closed) throw new BrainStoreError('store-unavailable', 'the Brain store is closed')
    const checked = validateRecord(record)
    if (!checked.ok) throw new BrainStoreError('invalid-record', checked.reason)
    assertRecordSize(record)
    // The fold owns the sequence; there is no second counter here to fall behind it.
    applyRecord(this.brain, record)
    return record
  }

  state(): BrainState {
    return this.brain
  }

  health(): { health: BrainHealth; reason: string | null } {
    return { health: this.faultReason === null ? 'healthy' : 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
