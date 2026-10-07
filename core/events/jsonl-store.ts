import { existsSync } from 'node:fs'

const EOL = String.fromCharCode(10)
import { copyFile, open, mkdir, readFile, truncate, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventStore } from './store'
import { CORE_EVENT_SCHEMA_VERSION, type AnyCoreEvent } from './envelope'
import {
  HEALTHY_RECOVERY,
  parseDurableEvent,
  type RecoveryReport,
} from './validate'
import { repairKnownLegacyJournal } from './legacy-repair'
import { repairInterruptedTurnConversationId } from './interrupted-turn-repair'

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
export interface KnownJournalRepairReport {
  readonly code: 'legacy-tool-loop-request-id' | 'voice-wake-threshold-validator' | 'interrupted-conversation-id-recovery'
  readonly repairedEvents: number
  readonly sourceQuarantinePath: string
  readonly archivedDegradedPath: string | null
}

export class JsonlEventStore implements EventStore {
  private handle: FileHandle | null = null
  private lastSeen = 0
  private recoveredBytes = 0
  private recovery: RecoveryReport = HEALTHY_RECOVERY
  private knownRepair: KnownJournalRepairReport | null = null

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<JsonlEventStore> {
    const store = new JsonlEventStore(file)
    await mkdir(dirname(file), { recursive: true })
    // A previous version may already have quarantined the one known self-authored
    // continuation-id defect and then persisted an integrity fault into the trusted
    // prefix. Restore the full original only when the quarantine validates end to
    // end after that exact repair; unknown corruption remains failed closed.
    await store.restoreKnownLegacyQuarantine()
    await store.recover()
    store.handle = await open(file, 'a')
    return store
  }

  /**
   * Read the log, discard anything from the first unusable byte, and truncate
   * the file so the next append starts on a clean boundary.
   *
   * A crash and a corrupted journal are told apart here, because they mean
   * different things to everything downstream. A log that ends mid-line was
   * interrupted while being written and the surviving prefix is the whole truth.
   * A *complete* line that fails validation was not produced by an interrupted
   * write, and the journal cannot be believed past that point — which is
   * recorded as corruption rather than as an ordinary truncation.
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

const known = repairKnownLegacyJournal(raw.toString('utf8'))
    if (known !== null) {
      const sourceQuarantinePath = await this.preserveKnownRepairSource([
        'The only accepted repair is the historical cognition continuation request-id',
        'separator (# -> :) and the entire resulting journal must validate.',
      ])
      await writeFile(this.file, known.content, 'utf8')
      raw = Buffer.from(known.content, 'utf8')
      this.knownRepair = {
        code: known.code,
        repairedEvents: known.repairedEvents,
        sourceQuarantinePath,
        archivedDegradedPath: null,
      }
    } else {
      const interrupted = repairInterruptedTurnConversationId(raw.toString('utf8'))
      if (interrupted !== null) {
        const sourceQuarantinePath = await this.preserveKnownRepairSource([
          'The only accepted repair is the historical interrupted-turn empty',
          'conversationId recovery: a conversation.turn.interrupted row whose',
          'conversationId is the empty string is rebuilt with the conversationId',
          'of the earlier, valid conversation.turn.started that shares its turnId,',
          'and the entire resulting journal must validate end-to-end.',
        ])
        await writeFile(this.file, interrupted.content, 'utf8')
        raw = Buffer.from(interrupted.content, 'utf8')
        this.knownRepair = {
          code: interrupted.code,
          repairedEvents: interrupted.repairedEvents,
sourceQuarantinePath,
          archivedDegradedPath: null,
        }
      }
    }

    let goodBytes = 0
    let cursor = 0
    let lineNumber = 0
    let previous = 0
    let last = 0
    let eventsRead = 0
    let tornTail = false
    let corruption: RecoveryReport['corruption'] = null

    while (cursor < raw.length) {
      const newline = raw.indexOf(0x0a, cursor)
      lineNumber += 1

      if (newline === -1) {
        // No terminator. The process died part-way through this line, so these
        // bytes were never committed and the prefix before them is the truth.
        tornTail = true
        break
      }

      const line = raw.subarray(cursor, newline).toString('utf8')
      const parsed = parseDurableEvent(line, previous)
      if (!parsed.ok) {
        // A complete line that will not validate. Not a crash.
        corruption = { line: lineNumber, reason: parsed.reason }
        break
      }

      previous = parsed.event.sequence
      last = parsed.event.sequence
      eventsRead += 1
      goodBytes = newline + 1
      cursor = newline + 1
    }

    let quarantinePath: string | null = null

    if (corruption !== null) {
      // The original file is preserved whole before anything is discarded.
      //
      // Truncation is still necessary — appends land at the end of the file, and
      // a reader that stops at the first bad line would never see them again —
      // but discarding the bytes is not. The quarantine keeps the evidence,
      // including any event that came *after* the damage, which is exactly what
      // somebody needs in order to decide what was really in this journal.
      quarantinePath = await this.quarantine()
    }

    if (goodBytes !== raw.length) {
      // Drop everything from the first unusable byte onward, including valid
      // events that followed it. A gap in a security journal cannot be replayed
      // safely, so the safe reading of a damaged log is the trusted prefix.
      await truncate(this.file, goodBytes)
    }

    this.recoveredBytes = goodBytes
    this.lastSeen = last
    this.recovery = {
      tornTail,
      corruption,
      eventsRead,
      bytesDiscarded: raw.length - goodBytes,
      quarantinePath,
      // A torn tail is ordinary. Corruption is not, and nothing above may treat
      // it as though it were.
      trustworthy: corruption === null,
    }
  }

  /**
   * Copy the journal aside before recovery modifies it.
   *
   * Uses a fresh filename rather than overwriting, so a second corruption does
   * not destroy the evidence from the first. Bounded: after a handful the oldest
   * are left alone and the newest wins, because an unbounded pile of journals is
   * its own problem and this is a safety net, not an archive.
   */
  private async quarantine(): Promise<string> {
    const base = `${this.file}.quarantine`
    let target = base
    for (let n = 2; n <= 8; n += 1) {
      if (!existsSync(target)) break
      target = `${base}.${n}`
    }
    await copyFile(this.file, target)
    // A note beside it, so the file is not just an unexplained blob on disk.
    await writeFile(
      `${target}.txt`,
      [
        'Freya Core event log, set aside during recovery.',
        `Original: ${this.file}`,
        'This journal contained at least one complete event that did not validate.',
        'It was preserved rather than deleted. The trusted prefix was kept in the',
        'original file and a core.integrity_fault event was written into it, so',
        'Core stays degraded until this is dealt with deliberately.',
        '',
      ].join(EOL),
      'utf8',
    )
    return target
  }


  /**
   * Restore a journal that an older Freya already quarantined because of the
   * historical continuation-id separator bug.
   *
   * The current degraded journal must itself validate, its latest unresolved fault
   * must name a cognition.requested shape failure, the quarantine must become fully
   * valid after only the known repair, and the trusted prefix must exactly match.
   * The degraded journal is archived before replacement, so no evidence is erased.
   */
  private async restoreKnownLegacyQuarantine(): Promise<void> {
    let currentRaw: Buffer
    try {
      currentRaw = await readFile(this.file)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }

    const currentEvents = parseCompleteJournal(currentRaw.toString('utf8'))
    if (currentEvents === null || currentEvents.length === 0) return

    let fault: Extract<AnyCoreEvent, { type: 'core.integrity_fault' }> | null = null
    let repairedAfterFault = false
    for (const event of currentEvents) {
      if (event.type === 'core.integrity_fault') {
        fault = event
        repairedAfterFault = false
      } else if (event.type === 'core.integrity_repaired' && fault !== null) {
        repairedAfterFault = true
      }
    }
    if (fault === null || repairedAfterFault) return
    const wakeValidatorFault = fault.payload.reason.includes('payload does not match the shape of voice.wake.armed')
    const cognitionRequestedFault = fault.payload.reason.includes('cognition.requested')
    const interruptedTurnFault = fault.payload.reason.includes('conversation.turn.interrupted')
    if (!wakeValidatorFault && !cognitionRequestedFault && !interruptedTurnFault) return

    let quarantined: string
    try {
      quarantined = await readFile(fault.payload.quarantinePath, 'utf8')
    } catch {
      return
    }

    let repaired: { code: 'legacy-tool-loop-request-id' | 'voice-wake-threshold-validator' | 'interrupted-conversation-id-recovery'; content: string; events: readonly AnyCoreEvent[]; repairedEvents: number } | null = null
    if (wakeValidatorFault) {
      const validatedWakeEvents = parseCompleteJournal(quarantined)
      const boundary = validatedWakeEvents?.[fault.payload.trustedPrefixEvents]
      if (!validatedWakeEvents || boundary?.type !== 'voice.wake.armed' || boundary.payload.threshold !== 0.14) return
      repaired = {
        code: 'voice-wake-threshold-validator',
        content: quarantined,
        events: validatedWakeEvents,
        repairedEvents: validatedWakeEvents.filter((e) => e.type === 'voice.wake.armed').length,
      }
    } else if (interruptedTurnFault) {
      repaired = repairInterruptedTurnConversationId(quarantined)
      if (repaired === null) return
    } else {
      repaired = repairKnownLegacyJournal(quarantined)
      if (repaired === null) return
    }

    const prefixCount = fault.payload.trustedPrefixEvents
    // Never replace newer authority decisions with an older quarantine. Keep the
    // active journal degraded for deliberate reconciliation in that case.
    if (currentEvents.slice(prefixCount).some(e => /^(?:security\.|guard\.|cognition\.|model\.|command\.)/.test(e.type))) return
    if (repaired.events.length < prefixCount || currentEvents.length < prefixCount) return
    for (let index = 0; index < prefixCount; index += 1) {
      if (JSON.stringify(repaired.events[index]) !== JSON.stringify(currentEvents[index])) return
    }

    const archivedDegradedPath = await this.archiveCurrentDegradedJournal()
    await writeFile(this.file, repaired.content, 'utf8')
    this.knownRepair = {
      code: repaired.code,
      repairedEvents: repaired.repairedEvents,
      sourceQuarantinePath: fault.payload.quarantinePath,
      archivedDegradedPath,
    }
  }

  /** Preserve the original malformed file before an in-place known repair. */
  private async preserveKnownRepairSource(description: readonly string[]): Promise<string> {
    const target = this.availableSiblingPath(`${this.file}.quarantine-known-repair`)
    await copyFile(this.file, target)
    await writeFile(
      `${target}.txt`,
      [
        'Freya Core event log, preserved before a code-owned compatibility repair.',
        `Original: ${this.file}`,
        ...description,
        '',
      ].join(EOL),
      'utf8',
    )
    return target
  }

  /** Preserve the already-degraded replacement before restoring its verified quarantine. */
  private async archiveCurrentDegradedJournal(): Promise<string> {
    const target = this.availableSiblingPath(`${this.file}.pre-known-repair`)
    await copyFile(this.file, target)
    await writeFile(
      `${target}.txt`,
      [
        'Freya Core degraded journal archived before restoring a fully validated',
        'quarantine affected by a recognized code-owned validation defect.',
        `Original active path: ${this.file}`,
        '',
      ].join(EOL),
      'utf8',
    )
    return target
  }

  private availableSiblingPath(base: string): string {
    let target = base
    for (let n = 2; n <= 8; n += 1) {
      if (!existsSync(target)) return target
      target = `${base}.${n}`
    }
    return target
  }

  /** A known compatibility repair performed during this open, if any. */
  knownRepairReport(): KnownJournalRepairReport | null {
    return this.knownRepair === null ? null : { ...this.knownRepair }
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
   * What recovery found. Always present, and `trustworthy: false` is a real
   * condition that Core must refuse to paper over: a journal that failed
   * validation is not a journal that can be replayed into security state.
   */
  recoveryReport(): RecoveryReport {
    return this.recovery
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

function parseCompleteJournal(raw: string): AnyCoreEvent[] | null {
  if (raw.length === 0) return []
  if (!raw.endsWith('\n')) return null

  const events: AnyCoreEvent[] = []
  let previous = 0
  for (const line of raw.slice(0, -1).split('\n')) {
    const parsed = parseDurableEvent(line, previous)
    if (!parsed.ok) return null
    events.push(parsed.event)
    previous = parsed.event.sequence
  }
  return events
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}
