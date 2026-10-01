import type { MissionContent } from './types'
import { MissionStoreError, type MissionStore, type MissionStoreHealth } from './store'

/**
 * The ephemeral Mission content store.
 *
 * Used when no Mission key is available — a machine with no OS secure storage — and
 * in tests. A Mission is a private, persistent thing, so this store is explicit that
 * it is neither: `durable` is `false` and `faultReason` says why in words a person
 * can act on.
 *
 * The alternative — writing Mission content to disk in the clear, or beside a key
 * that does not protect it — would mean a person's plans sitting in a file on
 * somebody's laptop. Losing a Mission is recoverable; a Mission that was quietly
 * stored in the clear is not something anyone can undo.
 *
 * Nothing is ever written here. Not a temp file, not a cache, not an empty
 * directory: there is no code path from this object to the filesystem.
 */
export interface MemoryMissionStoreOptions {
  faultReason?: string | null
}

export class MemoryMissionStore implements MissionStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly faultReason: string | null

  private readonly records = new Map<string, MissionContent>()
  private closed = false

  constructor(options: MemoryMissionStoreOptions = {}) {
    this.faultReason = options.faultReason ?? null
  }

  async write(content: MissionContent): Promise<MissionContent> {
    if (this.closed) throw new MissionStoreError('unavailable', 'the Mission store is closed')
    if (typeof content !== 'object' || content === null || typeof content.missionId !== 'string') {
      throw new MissionStoreError('invalid', 'Mission content is malformed')
    }
    this.records.set(content.missionId, content)
    return content
  }

  async read(missionId: string) {
    const value = this.records.get(missionId)
    if (this.closed) return { ok: false as const, code: 'unavailable' as const, reason: 'the Mission store is closed' }
    if (value === undefined) {
      return { ok: false as const, code: 'not_found' as const, reason: 'no Mission content is stored for that Mission' }
    }
    return { ok: true as const, value }
  }

  async remove(missionId: string): Promise<boolean> {
    if (this.closed) throw new MissionStoreError('unavailable', 'the Mission store is closed')
    return this.records.delete(missionId)
  }

  health(): MissionStoreHealth {
    // `healthy` about its own operation. Ephemeral is not degraded — it is a
    // different, stated thing, and the projection says so in its own field.
    return { health: this.closed ? 'unavailable' : 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
    this.records.clear()
  }
}