import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
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
 *
 * Every write carries a generation. A write may only publish if it is still the
 * newest one, and the check and the rename happen together, synchronously, with
 * nothing between them. That is what stops an older debounced write — one that
 * was already in flight when the user quit — from landing on top of the final
 * flush and resurrecting a layout the user had already moved past.
 */

export const DEFAULT_MAX_BYTES = 512 * 1024
export const DEFAULT_WRITE_DELAY_MS = 400

export type WorkspaceFileAsyncWriter = (path: string, text: string) => Promise<void>

export interface WorkspaceFileOptions {
  path: string
  maxBytes?: number
  writeDelayMs?: number
  /**
   * I/O seam used by the race tests to hold an async write in flight
   * deterministically. Production uses node:fs/promises.writeFile.
   */
  writeFileAsync?: WorkspaceFileAsyncWriter
}

export class WorkspaceFile {
  readonly path: string
  private readonly maxBytes: number
  private readonly writeDelayMs: number
  private readonly writeFileAsync: WorkspaceFileAsyncWriter
  private timer: NodeJS.Timeout | null = null
  /** The serialised text waiting to be written, or null if nothing is queued. */
  private pending: string | null = null
  /** Bumped by every accepted write, and by every flush or dispose. */
  private generation = 0
  /**
   * Writes are chained. Two overlapping debounced writes would otherwise race
   * for the same temp file; the generation check decides which one is allowed
   * to publish, and the chain keeps them from fighting over the directory.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceFileOptions) {
    this.path = options.path
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.writeDelayMs = options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
    this.writeFileAsync =
      options.writeFileAsync ?? ((target, text) => writeFile(target, text, 'utf8'))
  }

  /** A temp path unique to one write, so no two writers can share a file. */
  private tempFor(generation: number): string {
    return `${this.path}.${generation}.tmp`
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
    return this.exceedsLimit(text) ? null : text
  }

  /** The limit is in UTF-8 bytes, everywhere it is applied. */
  private exceedsLimit(text: string): boolean {
    // Not `text.length`: a layout with non-ASCII titles is far larger on disk
    // than its UTF-16 code-unit count suggests, and measuring the two
    // differently means a file can pass the check on the way in and be
    // rejected on the way out.
    return Buffer.byteLength(text, 'utf8') > this.maxBytes
  }

  async load(): Promise<unknown> {
    try {
      const raw = await readFile(this.path, 'utf8')
      if (this.exceedsLimit(raw)) return null
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
    this.generation += 1
    this.pending = text
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const queued = this.pending
      if (queued !== null) this.enqueue(queued, this.generation)
    }, this.writeDelayMs)
    return true
  }

  private enqueue(text: string, generation: number): void {
    this.queue = this.queue.then(() => this.writeAsync(text, generation)).catch(() => {})
  }

  private async writeAsync(text: string, generation: number): Promise<void> {
    const temp = this.tempFor(generation)
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await this.writeFileAsync(temp, text)
    } catch (error) {
      console.error('[freya] workspace save failed', error)
      return
    }
    // Publishing is synchronous and immediately follows the check. If the
    // rename were awaited, a flush landing in that window would let this
    // stale write rename over it.
    this.publish(temp, generation)
  }

  /** Move a finished temp file into place, if it is still the newest write. */
  private publish(temp: string, generation: number): void {
    if (generation !== this.generation) {
      void rm(temp, { force: true }).catch(() => {})
      return
    }
    try {
      renameSync(temp, this.path)
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
   * Bumping the generation first is what guarantees the last word: anything
   * already in flight is now stale and will abandon its temp file instead of
   * publishing over this.
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const text = this.pending
    if (text === null) return
    this.pending = null
    this.generation += 1

    const temp = this.tempFor(this.generation)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      console.error('[freya] final workspace save failed', error)
    }
  }

  /** Cancel a queued write without writing it, and abandon anything in flight. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
    this.generation += 1
  }
}
