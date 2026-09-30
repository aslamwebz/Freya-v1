import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  BrainStoreError,
  emptyBrainState,
  type BrainHealth,
  type BrainRecord,
  type BrainRecordKind,
  type BrainState,
  type BrainStore,
} from './store'
import { BRAIN_RECORD_VERSION, applyRecord, assertRecordSize, validateRecord } from './fold'

/**
 * The encrypted Brain Store.
 *
 * A Brain is the most valuable long-term state Freya will ever hold, and it is
 * expected to outlive the machine it was written on. So the security here is
 * deliberately stronger than a per-record authenticated log, which is what the
 * conversation store is.
 *
 * ## The chain
 *
 * ```
 *   line N   =  { version, kind, seq, prev, context, nonce, cipher, tag }
 *              \_____________ authenticated as AAD ____________/
 *   prev(N)  =  sha256(line N-1, exactly as written)
 * ```
 *
 * A tag proves *this line* was not edited. A chain proves the log is the log that
 * was written: deleting, duplicating or reordering a line breaks `prev`, and there
 * is no way to re-derive the head without the key. That matters for a Brain
 * specifically — "delete the memory I was told to forget" and "an attacker deleted
 * the evidence" are otherwise indistinguishable, and a system that cannot tell
 * them apart cannot claim its memory is trustworthy.
 *
 * Everything else follows the conversation store's discipline deliberately, and for
 * the same reasons: a unique nonce per record from the CSPRNG (GCM nonce reuse
 * leaks the XOR of two plaintexts and the auth key), the header authenticated as
 * AAD so a record cannot be re-labelled between kinds, a per-store context id, and
 * version checked before shape so a future format gives a useful diagnostic.
 *
 * ## A gap is a gap
 *
 * A broken sequence or chain is **reported and the log stops being read there**,
 * rather than skipping the line and carrying on. Skipping would let an attacker
 * delete one record and have Freya quietly believe the rest as though nothing were
 * wrong. Everything after the break is not read, because the chain cannot vouch
 * for it.
 *
 * ## What a fault means
 *
 * A Brain fault is never a security event. A corrupt Brain cannot grant cognition,
 * clear a stop or widen a budget — and, just as importantly, it does not *lose*
 * authority either. Core keeps running, conversations keep working, and the surface
 * says the Brain is degraded with a reason. Unreadable long-term knowledge is
 * neither permission nor lockout.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
/** Separator byte for digest inputs. A path cannot contain one. */
const ZERO = Buffer.from([0])
/** The `prev` of the first record. Distinguishable from any real digest. */
const GENESIS = 'genesis'

interface StoredLine {
  version: number
  kind: string
  seq: number
  /** sha256 of the previous line exactly as written, base64. */
  prev: string
  /** Binds the log to this store, so it cannot be moved into another. */
  context: string
  nonce: string
  cipher: string
  tag: string
}

export interface EncryptedBrainStoreOptions {
  path: string
  /**
   * The Brain's own 32-byte key.
   *
   * Independent of the conversation key. A keyring holds one secret per domain, so
   * compromising conversation history does not yield the Brain and vice versa.
   */
  key: Uint8Array
}

export class EncryptedBrainStore implements BrainStore {
  readonly mode = 'encrypted' as const
  readonly faultReason = null

  private readonly path: string
  private readonly key: Buffer
  private readonly context: string
  private readonly brain: BrainState = emptyBrainState()

  private sequence = 0
  /** The digest the next record must extend. */
  private chainHead = GENESIS
  /** Serialises appends, so disk order, sequence and the fold stay one operation. */
  private writeTail: Promise<void> = Promise.resolve()
  private closed = false
  private degraded: string | null = null

  private constructor(options: EncryptedBrainStoreOptions) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    this.context = digestContext(options.key, options.path)
  }

  get degradedReason(): string | null {
    return this.degraded
  }

  static async open(options: EncryptedBrainStoreOptions): Promise<EncryptedBrainStore> {
    if (options.key.length !== KEY_BYTES) {
      throw new BrainStoreError(
        'unauthenticated',
        `the Brain key must be ${KEY_BYTES} bytes, received ${options.key.length}`,
      )
    }
    const store = new EncryptedBrainStore(options)

    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch {
      throw new BrainStoreError(
        'store-unavailable',
        'the Brain store directory could not be created',
      )
    }

    let raw: string
    try {
      raw = await readFile(options.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        try {
          await writeFile(options.path, '', { encoding: 'utf8', flag: 'a' })
        } catch {
          throw new BrainStoreError('store-unavailable', 'the Brain store could not be created')
        }
        return store
      }
      throw new BrainStoreError('store-unavailable', 'the Brain store could not be read')
    }

    store.replay(raw)
    return store
  }

  /**
   * Read the log, in order, stopping at the first thing that does not verify.
   *
   * A stop rather than a skip: the chain cannot vouch for anything after a break,
   * and continuing would let a deleted record look like it was never there.
   */
  private replay(raw: string): void {
    let previousDigest = GENESIS
    let expected = 1

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue

      let stored: StoredLine
      try {
        stored = JSON.parse(line) as StoredLine
      } catch {
        this.degrade('a Brain record is not valid JSON')
        return
      }
      if (typeof stored !== 'object' || stored === null) {
        this.degrade('a Brain record is not an object')
        return
      }
      // Version before shape, so a future format names itself.
      if (stored.version !== BRAIN_RECORD_VERSION) {
        this.degrade(`Brain record version ${String(stored.version)} is not this version`)
        return
      }
      if (
        typeof stored.kind !== 'string' ||
        !Number.isInteger(stored.seq) ||
        typeof stored.prev !== 'string' ||
        typeof stored.context !== 'string' ||
        typeof stored.nonce !== 'string' ||
        typeof stored.cipher !== 'string' ||
        typeof stored.tag !== 'string'
      ) {
        this.degrade('a Brain record has an unrecognised shape')
        return
      }
      if (stored.context !== this.context) {
        this.degrade('a Brain record belongs to a different store')
        return
      }
      // Continuity, then the chain. Two different attacks, two different checks:
      // a gap is a deletion, and a broken `prev` is a reorder or an edit.
      if (stored.seq !== expected) {
        this.degrade(`Brain record sequence ${String(stored.seq)} is out of order; expected ${expected}`)
        return
      }
      if (stored.prev !== previousDigest) {
        this.degrade('the Brain record chain is broken: a record was altered, moved or removed')
        return
      }

      // Consume the position before decryption so one damaged ciphertext does not
      // cascade into every later record reporting a gap.
      this.sequence = stored.seq
      previousDigest = digestLine(stored)
      this.chainHead = previousDigest
      expected = stored.seq + 1

      let body: unknown
      try {
        body = this.openLine(stored)
      } catch {
        this.degrade('a Brain record failed authentication and was not read')
        return
      }

      const checked = validateRecord(body)
      if (!checked.ok) {
        this.degrade(checked.reason)
        return
      }
      if (checked.record.kind !== stored.kind) {
        // The header is authenticated, so this cannot happen without a bug — which
        // is exactly why it is checked rather than assumed.
        this.degrade('a Brain record decrypted to a different kind than its header claims')
        return
      }
      applyRecord(this.brain, checked.record)
    }
    // A complete authenticated final record remains readable, but an append
    // would concatenate JSON objects if its delimiter was truncated.
    if (raw.length > 0 && !raw.endsWith('\n')) {
      this.degrade('the Brain log has an unterminated final record')
    }
  }

  /**
   * Note that something on disk could not be believed.
   *
   * Records the **first** reason only: the earliest break is the useful one, and
   * later messages would all be consequences of it. This is a statement about
   * long-term knowledge, so it is reported rather than thrown, and it changes no
   * security state in either direction.
   */
  private degrade(reason: string): void {
    this.degraded ??= reason
  }

  private openLine(line: StoredLine): unknown {
    const nonce = Buffer.from(line.nonce, 'base64')
    const tag = Buffer.from(line.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new BrainStoreError('unauthenticated', 'a Brain record has the wrong nonce or tag size')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(aadFor(this.context, line))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(line.cipher, 'base64')),
      decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as unknown
  }

  async write(record: BrainRecord): Promise<BrainRecord> {
    if (this.closed) {
      return Promise.reject(new BrainStoreError('store-unavailable', 'the Brain store is closed'))
    }
    const snapshot = JSON.parse(JSON.stringify(record)) as BrainRecord
    const checked = validateRecord(snapshot)
    if (!checked.ok) return Promise.reject(new BrainStoreError('invalid-record', checked.reason))
    assertRecordSize(snapshot)

    // Serialised so that sequence assignment, the chain link, disk order and the
    // in-memory fold are one ordered operation. Two subsystems may write at once,
    // and that must not be able to put seq 12 on disk before seq 11.
    const task = (): Promise<BrainRecord> => this.writeOne(snapshot)
    const result = this.writeTail.then(task, task)
    // One failed write must not poison the queue for the next one.
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeOne(record: BrainRecord): Promise<BrainRecord> {
    if (this.degraded !== null) {
      throw new BrainStoreError('read-only', 'the Brain log is degraded and cannot safely accept writes')
    }
    const seq = this.sequence + 1
    const prev = this.chainHead
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    const header = { version: BRAIN_RECORD_VERSION, kind: record.kind as BrainRecordKind, seq, prev, context: this.context }
    cipher.setAAD(aadFor(this.context, header))
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(record), 'utf8')), cipher.final()])

    const line: StoredLine = {
      version: BRAIN_RECORD_VERSION,
      kind: record.kind,
      seq,
      prev,
      context: this.context,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
    const serialised = `${JSON.stringify(line)}\n`

    if (Buffer.byteLength(serialised, 'utf8') > MAX_LINE_BYTES) {
      throw new BrainStoreError('too-large', 'a Brain record exceeds the per-record limit')
    }

    try {
      await appendFile(this.path, serialised, { encoding: 'utf8', flush: true })
    } catch {
      // An OS append may have written only part of the line. Do not extend an
      // uncertain tail or claim later memories will survive a restart.
      this.degrade('a Brain append failed; the log must be reopened before writing')
      throw new BrainStoreError('write-failed', 'a Brain record could not be written')
    }

    // The chain advances only once its bytes are durable, so a failed append cannot
    // consume a position or break the link for the next writer.
    this.sequence = seq
    this.chainHead = digestLine(line)
    applyRecord(this.brain, record)
    return record
  }

  state(): BrainState {
    return this.brain
  }

  health(): { health: BrainHealth; reason: string | null } {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writeTail
  }
}

/** A ceiling on one line, so a record can never become an unbounded write. */
const MAX_LINE_BYTES = 256 * 1024 + 4 * 1024

/**
 * The bytes authenticated alongside the ciphertext.
 *
 * `prev` is inside it as well as the header: the link between records is part of
 * what is verified, not merely what is checked afterwards.
 */
function aadFor(context: string, header: { version: number; kind: string; seq: number; prev: string }): Buffer {
  return Buffer.from(
    `freya.brain.v${header.version}|${context}|${header.kind}|${header.seq}|${header.prev}`,
    'utf8',
  )
}

/** The digest a line contributes to the chain: itself, hashed exactly as written. */
function digestLine(line: StoredLine): string {
  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(line), 'utf8'))
    .digest('base64')
}

/**
 * Bind the log to this key and location.
 *
 * So two stores that somehow shared a key still could not read each other, which
 * is what keeps "one key per domain" from being a single large blast radius.
 */
function digestContext(key: Uint8Array, path: string): string {
  return createHash('sha256')
    .update(Buffer.from(key))
    .update(ZERO)
    .update(path)
    .digest('base64')
    .slice(0, 32)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

