import { open, mkdir, readFile, truncate, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventStore } from './store'
import { CORE_EVENT_SCHEMA_VERSION, type AnyCoreEvent } from './envelope'

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
 */
export class JsonlEventStore implements EventStore {
  private handle: FileHandle | null = null
  private lastSeen = 0
  private recoveredBytes = 0

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

    const events: AnyCoreEvent[] = []
    let goodBytes = 0
    let cursor = 0

    while (cursor < raw.length) {
      const newline = raw.indexOf(0x0a, cursor)
      if (newline === -1) break // no terminator: a torn final write
      const line = raw.subarray(cursor, newline).toString('utf8')
      const parsed = parseLine(line)
      if (parsed === null) break // corrupt or truncated: stop the log here
      events.push(parsed)
      goodBytes = newline + 1
      cursor = newline + 1
    }

    if (goodBytes !== raw.length) {
      // Drop everything from the first unusable line onward.
      await truncate(this.file, goodBytes)
    }
    this.recoveredBytes = goodBytes
    this.lastSeen = events.reduce((max, event) => Math.max(max, event.sequence), 0)
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
    for (const line of raw.toString('utf8').split('\n')) {
      if (line.length === 0) continue
      const parsed = parseLine(line)
      // A torn tail is simply absent from the log; it is not an error to read.
      if (parsed === null) break
      events.push(parsed)
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

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

/**
 * Parse one line, rejecting anything that is not a plausible event.
 *
 * A hand-edited or partially-written log must not be able to inject a sequence
 * number, a schema version, or a principal of its own choosing.
 */
function parseLine(line: string): AnyCoreEvent | null {
  if (line.trim().length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const event = value as Record<string, unknown>

  if (typeof event.eventId !== 'string' || event.eventId.length === 0) return null
  if (typeof event.type !== 'string' || event.type.length === 0) return null
  if (typeof event.schemaVersion !== 'number') return null
  if (typeof event.sequence !== 'number' || !Number.isInteger(event.sequence)) return null
  if (typeof event.occurredAt !== 'string') return null
  if (event.source !== 'core' && event.source !== 'renderer' && event.source !== 'system') return null
  if (typeof event.actor !== 'string') return null
  if (typeof event.correlationId !== 'string') return null
  if (event.causationId !== null && typeof event.causationId !== 'string') return null
  if (typeof event.payload !== 'object' || event.payload === null) return null

  return event as unknown as AnyCoreEvent
}
