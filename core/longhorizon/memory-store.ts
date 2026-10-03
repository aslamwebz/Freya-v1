import type { GoalContent } from './types'
import { GoalStoreError, type GoalStore, type GoalStoreHealth } from './store'

/**
 * The ephemeral goal content store.
 *
 * Used when no goal key is available — a machine with no OS secure storage — and
 * in tests. A goal is a private, persistent thing, so this store is explicit that
 * it is neither: `durable` is `false` and `faultReason` says why in words a person
 * can act on.
 *
 * The alternative — writing goal content to disk in the clear, or beside a key
 * that does not protect it — would mean a person's plans sitting in a file on
 * somebody's laptop. Losing a goal is recoverable; a goal that was quietly
 * stored in the clear is not something anyone can undo.
 *
 * Nothing is ever written here. Not a temp file, not a cache, not an empty
 * directory: there is no code path from this object to the filesystem.
 */
export interface MemoryGoalStoreOptions {
  faultReason?: string | null
}

export class MemoryGoalStore implements GoalStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly faultReason: string | null

  private readonly records = new Map<string, GoalContent>()
  private closed = false

  constructor(options: MemoryGoalStoreOptions = {}) {
    this.faultReason = options.faultReason ?? null
  }

  async write(content: GoalContent): Promise<GoalContent> {
    if (this.closed) throw new GoalStoreError('unavailable', 'the goal store is closed')
    if (typeof content !== 'object' || content === null || typeof content.goalId !== 'string') {
      throw new GoalStoreError('invalid', 'goal content is malformed')
    }
    this.records.set(content.goalId, content)
    return content
  }

  async read(goalId: string) {
    const value = this.records.get(goalId)
    if (this.closed) return { ok: false as const, code: 'unavailable' as const, reason: 'the goal store is closed' }
    if (value === undefined) {
      return { ok: false as const, code: 'not_found' as const, reason: 'no goal content is stored for that goal' }
    }
    return { ok: true as const, value }
  }

  async remove(goalId: string): Promise<boolean> {
    if (this.closed) throw new GoalStoreError('unavailable', 'the goal store is closed')
    return this.records.delete(goalId)
  }

  health(): GoalStoreHealth {
    return { health: this.closed ? 'unavailable' : 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
    this.records.clear()
  }
}
