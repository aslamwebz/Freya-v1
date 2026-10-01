import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { contextLimits, type ContextItem, type ContextLimits } from '../types'
import type { ContextPersistencePort, ContextSnapshot, ContextSnapshotLoad } from './port'
import { CONTEXT_SNAPSHOT_VERSION } from './port'
import { ContextPersistenceError, isContextPersistenceError } from './errors'
import {
  MAX_CONTEXT_RECORD_BYTES,
  MAX_CONTEXT_SNAPSHOT_BYTES,
  contextSnapshotBytes,
  decodeContextItem,
  decodeContextSnapshot,
  encodeContextSnapshot,
} from './snapshot'

/**
 * THE ENCRYPTED CONTEXT STORE.
 *
 * One encrypted line per retained record, the whole file rewritten when the
 * retained set changes. Context is a photograph of something a person shared, so
 * a stolen laptop, a synced folder or a support bundle must contain none of it:
 * the private part — content, label, URI — is under AES-256-GCM, and the only
 * plaintext on disk is a record id.
 *
 * ```
 *   line = { v, contextId, nonce, cipher, tag }
 *          \________ authenticated as AAD ________/
 * ```
 *
 * ## Why each part is there
 *
 * - **Authenticated encryption, not encryption.** GCM's tag is verified on every
 *   read. A record that was edited, truncated or swapped fails to open and is
 *   reported. There is no "decrypt anyway" path, because accepting a record that
 *   failed authentication would mean inventing the content it used to hold.
 * - **A unique nonce per record, per write**, from the CSPRNG. GCM nonce reuse
 *   under one key leaks the XOR of two plaintexts and the authentication key, so
 *   the nonce is never derived from anything repeatable: two records of identical
 *   content differ on disk, and rewriting a record gives it a fresh nonce rather
 *   than re-encrypting the same bytes under the same one.
 * - **The header is AAD.** The record id is fed in as additional authenticated
 *   data, so a record cannot be re-labelled onto another id — moving one item's
 *   content onto another item's id changes the tag and the read fails.
 * - **A per-store binding** in the AAD, derived from this domain's label, the key
 *   and this file's own path, so two Context stores that somehow shared a key
 *   still cannot read each other.
 *
 * ## Key separation: Context is its own domain
 *
 * The Context key is not the Mission key, not the Brain key and not the
 * conversation key. They are independent secrets, and a Context store cannot open
 * a Mission file even when handed the Mission key — the AAD prefix differs by
 * domain *and* the store binding is derived from the domain label, so a
 * wrong-domain key fails to authenticate rather than quietly decrypting.
 *
 * That is not ceremony. A Mission is about somebody's plans, a Brain is about
 * their life and past, and Context is the raw private text they pointed at in the
 * moment: a selected paragraph, a file's title, a tab's URL. Recovering any other
 * domain's key must not yield the thing they were looking at when they spoke.
 *
 * Core never generates this key and never persists one. A host obtains it from OS
 * secure storage and supplies it here; a Core without one gets the ephemeral port
 * instead, which is stated in words and writes nothing at all.
 *
 * ## What a damaged store does
 *
 * Reading stops at the first record that cannot be believed, and the store is
 * marked degraded from then on: it serves nothing and it writes nothing.
 *
 * Both halves of that are load-bearing rather than cautious. Serving what parsed
 * would make the retained set a function of which records an attacker chose to
 * damage. Writing would be worse still: a commit rewrites the file from what this
 * store holds, so writing from a partial read would drop every record after the
 * break, permanently and invisibly, and the next open would report the store
 * healthy because the evidence is the thing just deleted. A damaged store is
 * read-only and says so (ARCHITECTURE §4.3).
 *
 * A Context fault is not a security event. It cannot grant anything, and it does
 * not lock Freya out either: the loss is bounded, the reason is in words, and
 * nothing outside this directory imports this module.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * Separator byte for the binding digest.
 *
 * A byte rather than a source escape, because a filesystem path cannot contain a
 * zero byte and the digest inputs must never be ambiguous with one another.
 */
const ZERO = Buffer.from([0])

/**
 * This domain's own label.
 *
 * In the AAD and in the binding digest, so a Context store is a different cipher
 * context from every other domain even if it were handed another key.
 *
 * Exported because it is *format*, not secret: a test needs to write a record by
 * hand to prove that one which authenticates and is still illegal gets refused,
 * and a format nobody outside this file can name cannot be pinned by a test at
 * all. It reveals nothing — the security of the record is the key, not this word.
 */
export const CONTEXT_CRYPTO_DOMAIN = 'freya.context.v1'

/** The line on disk. Everything outside `cipher` is authenticated as AAD. */
interface StoredRecord {
  v: typeof CONTEXT_SNAPSHOT_VERSION
  contextId: string
  nonce: string
  cipher: string
  tag: string
}

export interface EncryptedContextStoreOptions {
  readonly path: string
  /** The Context domain's own 32-byte key. Not the Mission, Brain or chat key. */
  readonly key: Uint8Array
  /** Forwarded to the recovery gate; may only lower `CONTEXT_LIMITS`. */
  readonly limits?: Partial<ContextLimits>
}

export class EncryptedContextStore implements ContextPersistencePort {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly durabilityReason = null as string | null

  private readonly path: string
  private readonly key: Buffer
  private readonly binding: string
  private readonly limits: Partial<ContextLimits>
  /**
   * This instance's temp-file name, so two stores on one path cannot delete each
   * other's half-written file out from under a rename.
   *
   * A Context store is a single-writer file, as the Mission store is — the last
   * commit wins whole, and nothing here merges two views. What the suffix buys is
   * that "there happened to be two" fails as a lost update rather than as an
   * `ENOENT` in the middle of somebody's save. A temp file left by a crash is
   * ciphertext under this domain's key and is never read back.
   */
  private readonly staging: string

  /** What is on disk, as authenticated records. Never partially believed. */
  private records = new Map<string, StoredRecord>()
  private fault: string | null = null
  private closed = false
  /** Serialised writes, so two commits cannot interleave into a torn file. */
  private writeTail: Promise<unknown> = Promise.resolve()

  private constructor(options: EncryptedContextStoreOptions, binding: string) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    this.binding = binding
    this.limits = options.limits ?? {}
    this.staging = `${options.path}.${randomBytes(6).toString('hex')}.tmp`
  }

  /**
   * Why this store cannot be trusted right now, or null when it can.
   *
   * A getter rather than a constant, for the reason it is one in the Mission
   * store: a hardcoded `null` there made a projection report `durable: true` and a
   * window say `ENCRYPTED AT REST` while every record was failing authentication.
   * The degradation was tracked; it was just never read by anything a window could
   * see.
   */
  get faultReason(): string | null {
    return this.fault
  }

  /**
   * Open (or create) the store, and authenticate whatever is already on disk.
   *
   * Throws only for the two failures that are a caller's to fix and not a store's
   * to survive: a key of the wrong length, and a path this build cannot read or
   * create. A *damaged file* does not throw — it degrades, because a damaged file
   * is something Core should keep running through while saying so.
   */
  static async open(options: EncryptedContextStoreOptions): Promise<EncryptedContextStore> {
    if (typeof options.path !== 'string' || options.path.length === 0) {
      throw new ContextPersistenceError('invalid', 'the Context store needs a file path')
    }
    if (options.key.length !== KEY_BYTES) {
      throw new ContextPersistenceError(
        'unauthenticated',
        `the Context key must be ${KEY_BYTES} bytes, received ${options.key.length}`,
      )
    }

    const store = new EncryptedContextStore(options, contextStoreBinding(options.key, options.path))
    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch (error) {
      throw new ContextPersistenceError(
        'unavailable',
        `the Context store directory could not be created: ${describe(error)}`,
      )
    }

    let raw: string
    try {
      raw = await readFile(options.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        // Created empty, and not written to again until there is something to
        // commit: a first run must not fill a disk with files holding nothing.
        await writeFile(options.path, '', { encoding: 'utf8', flag: 'a', mode: 0o600 })
        return store
      }
      throw new ContextPersistenceError(
        'unavailable',
        `the Context store could not be read: ${describe(error)}`,
      )
    }

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      store.replay(line)
      // Stop at the first record that cannot be believed. Continuing would mean
      // serving a history whose contents depend on what an attacker damaged, and
      // the records after the break would be dropped by the next commit anyway.
      if (store.fault !== null) break
    }
    return store
  }

  /**
   * Read one line: authenticate, then check it is a legal record.
   *
   * Every failure here ends the same way — the store is degraded and serves
   * nothing afterwards. Nothing is repaired, defaulted or invented.
   */
  private replay(line: string): void {
    let stored: StoredRecord
    try {
      stored = JSON.parse(line) as StoredRecord
    } catch {
      this.degrade('a Context record is not valid JSON')
      return
    }
    if (typeof stored !== 'object' || stored === null) {
      this.degrade('a Context record is not an object')
      return
    }
    // Version before shape, so a record from a future format is reported as
    // exactly that rather than as an unrecognised shape, which would send
    // somebody hunting for corruption that is not there.
    if (stored.v !== CONTEXT_SNAPSHOT_VERSION) {
      this.degrade(
        `a Context record is version ${String(stored.v)}, and this build reads version ${CONTEXT_SNAPSHOT_VERSION}`,
      )
      return
    }
    if (
      typeof stored.contextId !== 'string' ||
      stored.contextId.length === 0 ||
      typeof stored.nonce !== 'string' ||
      typeof stored.cipher !== 'string' ||
      typeof stored.tag !== 'string'
    ) {
      this.degrade('a Context record has an unrecognised shape')
      return
    }
    try {
      // Opened once and discarded: the plaintext must not sit in memory for the
      // life of the process when the only caller wants it once.
      this.readItem(stored)
    } catch (error) {
      this.degrade(
        isContextPersistenceError(error) && error.code === 'unauthenticated'
          ? 'a Context record failed authentication and was not read'
          : `a Context record did not survive being read: ${describe(error)}`,
      )
      return
    }
    if (this.records.has(stored.contextId)) {
      this.degrade(`the Context store holds two records with the id ${stored.contextId}`)
      return
    }
    this.records.set(stored.contextId, stored)
  }

  /**
   * Recover the retained snapshot, or refuse in words.
   *
   * A refusal here is a value rather than an exception the caller must survive
   * with a catch: it is the answer "these bytes could not be believed", and the
   * caller is expected to go on holding an empty store that says it is degraded.
   */
  async load(): Promise<ContextSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the Context store is closed' }
    }
    if (this.fault !== null) {
      return { ok: false, code: 'degraded', reason: this.fault }
    }
    const records: ContextItem[] = []
    for (const stored of this.records.values()) {
      try {
        records.push(this.readItem(stored))
      } catch (error) {
        // Unreachable in practice — every record was opened at replay — and
        // handled anyway, because "unreachable" is how a store ends up serving
        // half a history after a refactor moves the check.
        return {
          ok: false,
          code: 'degraded',
          reason: this.degrade(`a Context record could not be read on recovery: ${describe(error)}`),
        }
      }
    }
    try {
      return {
        ok: true,
        snapshot: decodeContextSnapshot(
          { v: CONTEXT_SNAPSHOT_VERSION, records },
          this.limits,
        ),
      }
    } catch (error) {
      return { ok: false, code: 'degraded', reason: this.degrade(describe(error)) }
    }
  }

  /**
   * Write the whole retained set, encrypted, atomically.
   *
   * Whole-file rather than appended, because the retained set is small, bounded
   * and *replaced* constantly: an item is revoked, an item expires, a purge drops
   * a tombstone. An append-only log of a set that shrinks would need deletions,
   * and a deletion that is not authenticated is a hole.
   *
   * Atomic via temp-then-rename, so a crash leaves either the previous file or
   * the new one — never a half-written store that opens as "no context at all",
   * which is the failure a person would read as data loss.
   */
  async commit(snapshot: ContextSnapshot): Promise<void> {
    if (this.closed) throw new ContextPersistenceError('unavailable', 'the Context store is closed')
    this.refuseIfDamaged()
    const validated = encodeContextSnapshot(snapshot, this.limits)
    if (contextSnapshotBytes(validated) > MAX_CONTEXT_SNAPSHOT_BYTES) {
      throw new ContextPersistenceError('too_large', 'the Context snapshot exceeds the per-store limit')
    }

    const task = (): Promise<void> => this.writeOne(validated)
    const result = this.writeTail.then(task, task)
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeOne(snapshot: ContextSnapshot): Promise<void> {
    // Re-checked after the previous write in the chain has landed, so a fault
    // recorded by that write stops this one instead of racing past it.
    this.refuseIfDamaged()
    const next = new Map<string, StoredRecord>()
    const lines: string[] = []
    for (const item of snapshot.records) {
      const stored = this.seal(item)
      const serialised = `${JSON.stringify(stored)}\n`
      if (Buffer.byteLength(serialised, 'utf8') > MAX_CONTEXT_RECORD_BYTES) {
        throw new ContextPersistenceError(
          'too_large',
          `the context record ${item.contextId} exceeds the per-record limit`,
        )
      }
      next.set(item.contextId, stored)
      lines.push(serialised)
    }

    try {
      await writeFile(this.staging, lines.join(''), { encoding: 'utf8', mode: 0o600 })
      await replaceFile(this.staging, this.path)
    } catch (error) {
      throw new ContextPersistenceError('write_failed', `context could not be written: ${describe(error)}`)
    }
    this.records = next
  }

  private seal(item: ContextItem): StoredRecord {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    cipher.setAAD(this.aad(item.contextId))
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(item), 'utf8')),
      cipher.final(),
    ])
    return {
      v: CONTEXT_SNAPSHOT_VERSION,
      contextId: item.contextId,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  }

  /** Open one record and re-check it against the domain's own rules. */
  private readItem(stored: StoredRecord): ContextItem {
    const nonce = Buffer.from(stored.nonce, 'base64')
    const tag = Buffer.from(stored.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new ContextPersistenceError('unauthenticated', 'a Context record has the wrong nonce or tag size')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(this.aad(stored.contextId))
    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(stored.cipher, 'base64')), decipher.final()])
    } catch (error) {
      // Node reports a failed tag as an opaque string. Translated here so that
      // "this record is not authentic" is a fact Core can reason about, rather
      // than a phrase a caller has to pattern-match.
      throw new ContextPersistenceError('unauthenticated', `a Context record did not authenticate: ${describe(error)}`)
    }
    return decodeContextItem(JSON.parse(plaintext.toString('utf8')), contextLimits(this.limits))
  }

  private aad(contextId: string): Buffer {
    return Buffer.from(contextRecordAad(this.binding, contextId), 'utf8')
  }

  private refuseIfDamaged(): void {
    if (this.fault !== null) {
      throw new ContextPersistenceError(
        'degraded',
        `context is not being written because this store is damaged: ${this.fault}`,
      )
    }
  }

  /**
   * Record a fault, keeping the first one, and hand back what is recorded.
   *
   * The *first* reason is the useful one: a store that keeps being handed more
   * failures should still report the one that explains why it stopped trusting
   * the file, rather than whichever arrived last.
   */
  private degrade(reason: string): string {
    this.fault ??= reason
    return this.fault
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writeTail
  }
}

/**
 * The per-store binding: this domain, this key, this path.
 *
 * Derived rather than stored, so there is no file an attacker could copy a
 * binding out of, and derived *with the domain label* so a Mission key offered to
 * a Context store produces a different binding as well as a different AAD prefix.
 *
 * Exported for the same reason as the domain label: it is format, and a test
 * that writes a record by hand has to reproduce it exactly to be testing the
 * validator rather than its own arithmetic.
 */
export function contextStoreBinding(key: Uint8Array, path: string): string {
  return createHash('sha256')
    .update(CONTEXT_CRYPTO_DOMAIN)
    .update(ZERO)
    .update(key)
    .update(ZERO)
    .update(path)
    .digest('base64')
    .slice(0, 32)
}

/**
 * The additional authenticated data for one record.
 *
 * Exported so the format is one readable line rather than a convention spread
 * across a constructor and a test. The record id is inside it, which is what
 * stops one item's content being re-labelled onto another item's id.
 */
export function contextRecordAad(binding: string, contextId: string): string {
  return `${CONTEXT_CRYPTO_DOMAIN}|${binding}|${contextId}`
}

/**
 * `rename`, retried a few times on the transient refusals Windows gives.
 *
 * On Windows a rename onto a file another handle is touching fails with `EPERM`
 * or `EBUSY` — a backup tool, a scanner, or a second writer that got there first
 * — and succeeds a moment later. Treating that as "context could not be written"
 * would mean a person's shared selection is refused for a reason that has
 * nothing to do with them, so the rename is retried briefly and then *fails*:
 * the alternative, looping forever, would turn a locked file into a hung save.
 *
 * A genuine permission failure exhausts the retries and is reported, which is the
 * honest outcome — the content is simply not being kept, and the caller will say
 * so rather than pretend otherwise.
 */
async function replaceFile(from: string, to: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!isTransientRenameFailure(error)) break
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
  throw lastError
}

function isTransientRenameFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}