import { open, mkdir, readFile, truncate, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventStore } from './store'
import { CORE_EVENT_SCHEMA_VERSION, type AnyCoreEvent } from './envelope'
import { parseDurableEvent, type ValidationFailure } from './validate'

/**
 * An append-only JSONL event store.
 *
 * One event per line, `fsync` before the append resolves. Nothing is ever
 * rewritten except a torn final line, which is truncated away on load: a
 * process killed mid-write can leave half a line, and half a line must not be
 * allowed to poison every append that follows it.
 *
 * Phase 1 writes its own store rather than using `node:sqlite`. The API is
 * available in the bundled runtime but still flagged experimental in the Node
 * that runs the tests, and a durable security audit log is a poor place to
 * depend on a surface that "might change at any time". See docs/PHASE-1.md.
 *
 * Human-readable by construction: an audit journal that a person can read with
 * a text editor is worth more than query speed at these volumes.
 *
 * ## Recovery policy
 *
 * The log is a sequence of lines. Reading stops at the first line that is not
 * a valid event, and everything from that point on is truncated away. In
 * practice the only recoverable defects are at the tail, which is the only place
 * a crash can leave damage:
 *
 * | Condition                      | What happens                                   |
 * | ------------------------------ | ---------------------------------------------- |
 * | torn final write (no newline)  | dropped, file truncated to the last good line   |
 * | unparseable final line         | dropped, file truncated                        |
 * | unknown event type             | dropped, file truncated                        |
 * | unsupported schema version     | dropped, file truncated                        |
 * | sequence not a positive int    | dropped, file truncated                        |
 * | duplicate sequence             | dropped, file truncated                        |
 * | reversed sequence              | dropped, file truncated                        |
 * | payload does not match its type| dropped, file truncated                        |
 * | invalid *middle* line          | dropped, and so is everything after it         |
 *
 * The invalid-middle case is the sharp edge: truncation discards valid events
 * that followed. That is the deliberate choice. A journal with a hole in it
 * cannot be replayed into security state safely — a gap could hide the
 * revocation that followed it — so the safe reading of a damaged log is the
 * prefix up to the damage, plus a recorded fault saying the log was truncated.
 * Refusing to start at all would be safer still, and is what a deployment that
 * cannot tolerate truncation should do; see `lastTruncation`.
 */
export class JsonlEventStore implements EventStore {
  private handle: FileHandle | null = null
  private lastSeen = 0
  private recoveredBytes = 0
  private truncation: ValidationFailure | null = null

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<JsonlEventStore> {
    const store = new JsonlEventStore(file)
    await mkdir(dirname(file), { recursive: true })
    await store.recover()
    store.handle = await open(file, 'a')
    return store
  }

  /**
   * Read the log, discard any torn tail, and truncate the file so the next
   * append starts on a clean boundary.
   */
  private async recover(): Promise<void> {
    let raw: Buffer
    try {
      raw = await readFile(this.file)
    } catch (error) {
      if (isMissing(error)) {
        this.recoveredBytes = 0
        return
      }
      throw error
    }

    let goodBytes = 0
    let cursor = 0
    let lineNumber = 0
    let previous = 0
    let last = 0

    while (cursor < raw.length) {
      const newline = raw.indexOf(0x0a, cursor)
      lineNumber += 1
      // No terminator: the process died part-way through writing this line.
      if (newline === -1) {
        this.truncation = { line: lineNumber, reason: 'final write is torn: no line terminator' }
        break
      }

      const line = raw.subarray(cursor, newline).toString('utf8')
      const parsed = parseDurableEvent(line, previous)
      if (!parsed.ok) {
        this.truncation = { line: lineNumber, reason: parsed.reason }
        break
      }

      previous = parsed.event.sequence
      last = parsed.event.sequence
      goodBytes = newline + 1
      cursor = newline + 1
    }

    if (goodBytes !== raw.length) {
      // Drop everything from the first unusable line onward, including valid
      // events that followed it. See the recovery policy above.
      await truncate(this.file, goodBytes)
      this.recoveredBytes = goodBytes
      this.lastSeen = last
      return
    }
    this.recoveredBytes = goodBytes
    this.lastSeen = last
  }

  async append(event: AnyCoreEvent): Promise<void> {
    if (!this.handle) throw new Error('event store is closed')
    if (event.sequence <= this.lastSeen) {
      throw new Error(
        `refusing to append sequence ${event.sequence}: store is at ${this.lastSeen}`,
      )
    }
    if (event.schemaVersion !== CORE_EVENT_SCHEMA_VERSION) {
      throw new Error(`unsupported event schema version ${event.schemaVersion}`)
    }
    const handle = this.handle
    await handle.write(JSON.stringify(event) + '\n')
    // Durable before the promise resolves. A subscriber must never be able to
    // observe an event that a replay would not produce.
    await handle.sync()
    this.lastSeen = event.sequence
  }

  async readAll(): Promise<AnyCoreEvent[]> {
    return this.readAfter(0)
  }

  async readAfter(afterSequence: number): Promise<AnyCoreEvent[]> {
    if (afterSequence === 0) {
      const events = await this.readFromDisk()
      return events
    }
    const events = await this.readFromDisk()
    return events.filter((event) => event.sequence > afterSequence)
  }

  private async readFromDisk(): Promise<AnyCoreEvent[]> {
    let raw: Buffer
    try {
      raw = await readFile(this.file)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const events: AnyCoreEvent[] = []
    let previous = 0
    for (const line of raw.toString('utf8').split('\n')) {
      if (line.length === 0) continue
      const parsed = parseDurableEvent(line, previous)
      // Recovery already truncated at the first bad line, so reaching one here
      // means the file changed under us. Stop rather than trust it.
      if (!parsed.ok) break
      previous = parsed.event.sequence
      events.push(parsed.event)
    }
    return events
  }

  async lastSequence(): Promise<number> {
    const events = await this.readFromDisk()
    return events.reduce((max, event) => Math.max(max, event.sequence), 0)
  }

  describe(): string {
    return `jsonl:${this.file}`
  }

  /** Bytes of a recovered log, exposed so the start event can report it. */
  recoveredByteLength(): number {
    return this.recoveredBytes
  }

  /**
   * What recovery discarded, if anything. Non-null means the log was truncated,
   * which a caller that cares about audit completeness must surface rather than
   * quietly accept.
   */
  lastTruncation(): ValidationFailure | null {
    return this.truncation
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

