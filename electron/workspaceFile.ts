import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The workspace file: the one piece of durable state the shell owns.
 *
 * Deliberately free of Electron so the two properties that matter — an
 * unserialisable or oversized payload never reaches the disk, and a quit never
 * loses the last change — can be tested without launching an app.
 *
 * Writes are atomic (temp file + rename), so a crash or a power cut mid-write
 * leaves the previous layout intact rather than a truncated file that would
 * block the next launch.
 */

export const DEFAULT_MAX_BYTES = 512 * 1024
export const DEFAULT_WRITE_DELAY_MS = 400

export interface WorkspaceFileOptions {
  path: string
  maxBytes?: number
  writeDelayMs?: number
}

export class WorkspaceFile {
  readonly path: string
  private readonly maxBytes: number
  private readonly writeDelayMs: number
  private timer: NodeJS.Timeout | null = null
  /** The serialised text waiting to be written, or null if nothing is queued. */
  private pending: string | null = null
  /**
   * Writes are chained. Two overlapping debounced writes would share one temp
   * path, and whichever renamed last would publish the other's half-written
   * file. One writer at a time is cheaper than per-write temp names.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceFileOptions) {
    this.path = options.path
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.writeDelayMs = options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
  }

  /**
   * Serialise, or return null if the payload must not be written.
   *
   * The limit is enforced on the way *in*. A limit that is only checked when
   * reading protects the next launch but still lets an unbounded payload reach
   * the disk, which is the half of the problem that actually costs something.
   */
  serialise(payload: unknown): string | null {
    let text: string
    try {
      const encoded = JSON.stringify(payload)
      if (typeof encoded !== 'string') return null
      text = encoded
    } catch {
      // Cyclic or otherwise unserialisable: refuse rather than truncate.
      return null
    }
    // Byte length, not string length — a layout with non-ASCII titles is
    // larger on disk than `.length` suggests.
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) return null
    return text
  }

  async load(): Promise<unknown> {
    try {
      const raw = await readFile(this.path, 'utf8')
      if (raw.length > this.maxBytes) return null
      return JSON.parse(raw)
    } catch {
      // Missing or unreadable is normal on first launch. Never fatal.
      return null
    }
  }

  /** Queue a write. Returns false when the payload was refused. */
  schedule(payload: unknown): boolean {
    const text = this.serialise(payload)
    if (text === null) return false
    this.pending = text
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const queued = this.pending
      if (queued !== null) this.enqueue(queued)
    }, this.writeDelayMs)
    return true
  }

  private enqueue(text: string): void {
    this.queue = this.queue.then(() => this.writeAsync(text)).catch(() => {})
  }

  private async writeAsync(text: string): Promise<void> {
    const temp = `${this.path}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(temp, text, 'utf8')
      await rename(temp, this.path)
    } catch (error) {
      console.error('[freya] workspace save failed', error)
    }
  }

  /**
   * The last-chance write, and the reason it is synchronous.
   *
   * A quit cannot await: the process may exit before a promise settles, and a
   * layout that was moved and closed in the same second is exactly the case
   * persistence exists for. This either lands or the process was never going
   * to get the chance.
   *
   * It also takes ownership of the temp file, so anything already queued is
   * abandoned rather than allowed to race the final write.
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const text = this.pending
    if (text === null) return
    this.pending = null
    const temp = `${this.path}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      console.error('[freya] final workspace save failed', error)
    }
  }

  /** Cancel a queued write without writing it. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }
}
