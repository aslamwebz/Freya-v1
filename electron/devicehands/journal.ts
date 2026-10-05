import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  DeviceHandsEventType,
  DeviceHandsJournalEntry,
  DeviceHandsPayload,
} from '../../core/devicehands'

/**
 * The Device Hands journal, made durable.
 *
 * Phase 35's runtime derives *every* fact it holds from the entries this object
 * persists, so a refused append must fail loudly and an unreadable line must refuse
 * to open. Both are properties of this file rather than promises in a comment.
 *
 * ## The hash chain
 *
 * Each line is a JSON object carrying the previous line's digest. A journal whose
 * bytes were edited — a grant added, a refusal removed, a verdict rewritten — no
 * longer chains, and the whole record is reported untrustworthy. That is deliberate:
 * the alternative to "this journal cannot be believed" is "this journal was quietly
 * repaired", and a repaired action log is a source of confident fiction about what
 * this machine has already done.
 *
 * ## What it never stores
 *
 * The payload is already closed to flat scalars by the runtime's own vocabulary, so
 * there is no field here for clipboard content, page text, terminal output or file
 * bytes to arrive in. This file adds nothing to that: it writes what it is given and
 * refuses to invent a field.
 *
 * ## One writer
 *
 * A single process appends to one journal. There is no lock, no merge and no
 * second writer, because the runtime that owns it is opened once at startup and
 * closed at shutdown — the same single-owner discipline the rest of the host uses.
 *
 * ## Why it is parameterised on the event type
 *
 * Phase 51 (the dual-browser runtime) writes its own entries into **this same file**
 * rather than opening a second one, because two journals would mean two integrity
 * chains and a restart that believed one of them could be in a state the other
 * contradicted. The generic parameter is what lets it do that without a cast and
 * without loosening `DeviceHandsEventType` for the runtime that owns the vocabulary:
 * the *file* is generic, the *runtime* still appends only `hands.*`.
 */
export interface DeviceHandsJournal<E extends string = DeviceHandsEventType> {
  /** Durable before it resolves. A refused append rejects rather than swallowing. */
  append(type: E, payload: DeviceHandsPayload): Promise<void>
  /** The whole durable journal, in sequence order. Read once, when the phase opens. */
  replay(): Promise<readonly DeviceHandsJournalEntry[]>
  /** Whether every line read back chained. False refuses every new action. */
  trustworthy(): boolean
  /** The path this journal lives at, for the owner's audit view. Never its contents. */
  path(): string
}

/** A line as it is stored on disk: the entry, plus the chain link. */
interface StoredLine {
  readonly type: string
  readonly recordedAt: string
  readonly payload: DeviceHandsPayload
  readonly prev: string
  readonly hash: string
}

const GENESIS = 'genesis'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The canonical text a line hashes over.
 *
 * Keys are sorted and the value is JSON with no whitespace, so two runs that wrote
 * the same entry produce the same digest and a re-serialisation cannot change it.
 */
function lineDigest(prev: string, entry: DeviceHandsJournalEntry): string {
  const payload = entry.payload
  const canonical = JSON.stringify({
    type: entry.type,
    recordedAt: entry.recordedAt ?? '',
    payload: canonicalPayload(payload),
  })
  return sha256(`${prev}\n${canonical}`)
}

function canonicalPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'null'
  const entries = Object.entries(payload as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return JSON.stringify(Object.fromEntries(entries))
}

/**
 * Open (or create) a journal at `path`.
 *
 * Reading is tolerant of a missing file — a fresh install has written nothing — but
 * intolerant of a line that does not parse or does not chain. In that case the
 * trusted prefix is returned and {@link DeviceHandsJournal.trustworthy} reports
 * false, so the runtime folds what is real and then refuses to act on it.
 */
export function openDeviceHandsJournal<E extends string = DeviceHandsEventType>(
  path: string,
  now: () => string = () => new Date().toISOString(),
): DeviceHandsJournal<E> {
  const trusted: DeviceHandsJournalEntry[] = []
  let trustworthy = true
  let lastHash = GENESIS

  if (existsSync(path)) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      // A file that exists but cannot be read is not a journal with no entries; it is
      // a journal nobody can vouch for.
      raw = ''
      trustworthy = false
    }
    const lines = raw.split('\n')
    for (const line of lines) {
      if (line.trim().length === 0) continue
      if (!trustworthy) break
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        trustworthy = false
        break
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        trustworthy = false
        break
      }
      const stored = parsed as Partial<StoredLine>
      if (
        typeof stored.type !== 'string' ||
        typeof stored.recordedAt !== 'string' ||
        typeof stored.prev !== 'string' ||
        typeof stored.hash !== 'string'
      ) {
        trustworthy = false
        break
      }
      const entry: DeviceHandsJournalEntry = {
        type: stored.type,
        recordedAt: stored.recordedAt,
        payload: stored.payload,
      }
      const expected = lineDigest(stored.prev, entry)
      if (stored.prev !== lastHash || stored.hash !== expected) {
        trustworthy = false
        break
      }
      trusted.push(entry)
      lastHash = stored.hash
    }
  }

  return {
    async append(type: E, payload: DeviceHandsPayload): Promise<void> {
      const recordedAt = now()
      const entry: DeviceHandsJournalEntry = { type, recordedAt, payload }
      const prev = lastHash
      const hash = lineDigest(prev, entry)
      const stored: StoredLine = { type, recordedAt, payload, prev, hash }
      const directory = dirname(path)
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
      // Synchronous and append-only: the promise does not resolve until the bytes are
      // in the file, and a failure to write rejects rather than being swallowed.
      appendFileSync(path, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', flag: 'a' })
      lastHash = hash
      trusted.push(entry)
    },
    async replay(): Promise<readonly DeviceHandsJournalEntry[]> {
      return trusted.slice()
    },
    trustworthy(): boolean {
      return trustworthy
    },
    path(): string {
      return path
    },
  }
}
