import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SkillRecord } from '../types'
import type { SkillPersistencePort, SkillSnapshot, SkillSnapshotLoad } from './port'
import { SKILL_SNAPSHOT_VERSION } from './port'
import { SkillPersistenceError, isSkillPersistenceError } from './errors'
import {
  MAX_SKILL_RECORD_BYTES,
  MAX_SKILL_SNAPSHOT_BYTES,
  decodeSkillRecord,
  decodeSkillSnapshot,
  encodeSkillSnapshot,
  skillRecordBytes,
  skillSnapshotBytes,
} from './snapshot'

/**
 * THE ENCRYPTED SKILL STORE.
 *
 * One encrypted line per retained skill body, the whole file rewritten when the
 * retained set changes. A skill body is a procedure Freya wrote, together with the
 * capability map and the applicability tags that decide when it runs — so a stolen
 * laptop, a synced folder or a support bundle must contain none of it. The only
 * plaintext on disk is a record id.
 *
 * ```
 *   line = { v, skillId, nonce, cipher, tag }
 *          \________ authenticated as AAD ________/
 * ```
 *
 * ## Why each part is there
 *
 * - **Authenticated encryption, not encryption.** GCM's tag is verified on every
 *   read. A record that was edited, truncated or swapped fails to open and is
 *   reported. There is no "decrypt anyway" path, because accepting a record that
 *   failed authentication would mean inventing the procedure it used to hold.
 * - **A unique nonce per record, per write**, from the CSPRNG. GCM nonce reuse under
 *   one key leaks the XOR of two plaintexts and the authentication key, so the nonce
 *   is never derived from anything repeatable: rewriting a body gives it a fresh
 *   nonce rather than re-encrypting the same bytes under the same one.
 * - **The header is AAD.** The record id is fed in as additional authenticated data,
 *   so a record cannot be re-labelled onto another id — moving one procedure's steps
 *   onto another's id changes the tag and the read fails.
 * - **A per-store binding** in the AAD, derived from this domain's label, the key and
 *   this file's own path, so two Skill stores that somehow shared a key still cannot
 *   read each other.
 *
 * ## Key separation: Skills are their own domain
 *
 * The Skill key is not the Mission key, the Brain key, the Context key or the
 * conversation key. They are independent secrets, and a Skill store cannot open
 * another domain's file even when handed its key — the AAD prefix differs by domain
 * *and* the binding is derived from the domain label, so a wrong-domain key fails to
 * authenticate rather than quietly decrypting.
 *
 * Core never generates this key and never persists one. A host obtains it from OS
 * secure storage and supplies it; a Core without one gets the ephemeral port, which
 * states it in words and writes nothing at all.
 *
 * ## What a damaged store does
 *
 * Reading stops at the first record that cannot be believed, and the store is marked
 * degraded from then on: it serves nothing and it writes nothing.
 *
 * Both halves are load-bearing. Serving what parsed would make the retained set a
 * function of which records an attacker chose to damage. Writing would be worse: a
 * commit rewrites the file from what this store holds, so writing from a partial read
 * would drop every record after the break, permanently and invisibly, and the next
 * open would report the store healthy because the evidence is the thing just deleted.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** A byte rather than a source escape: a filesystem path cannot contain a zero byte. */
const ZERO = Buffer.from([0])

/**
 * This domain's own label.
 *
 * In the AAD and in the binding digest, so a Skill store is a different cipher
 * context from every other domain even if it were handed another key. It is *format*,
 * not secret: a test that writes a record by hand has to reproduce it exactly, and a
 * format nobody outside this file can name cannot be pinned by a test at all.
 */
export const SKILL_CRYPTO_DOMAIN = 'freya.skill.store.v1'

interface StoredRecord {
  v: typeof SKILL_SNAPSHOT_VERSION
  skillId: string
  nonce: string
  cipher: string
  tag: string
}

export interface EncryptedSkillStoreOptions {
  readonly path: string
  /** The Skill domain's own 32-byte key. Not the Mission, Brain, Context or chat key. */
  readonly key: Uint8Array
}

export class EncryptedSkillStore implements SkillPersistencePort {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly durabilityReason = null as string | null

  private readonly path: string
  private readonly key: Buffer
  private readonly binding: string
  /** This instance's staging name, so two stores cannot delete each other's file. */
  private readonly staging: string

  /** What is on disk, as authenticated records. Never partially believed. */
  private records = new Map<string, StoredRecord>()
  private fault: string | null = null
  private closed = false
  /** Serialised writes, so two commits cannot interleave into a torn file. */
  private writeTail: Promise<unknown> = Promise.resolve()

  private constructor(options: EncryptedSkillStoreOptions, binding: string) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    this.binding = binding
    this.staging = `${options.path}.${randomBytes(6).toString('hex')}.tmp`
  }

  /** A getter, so a degraded store cannot report itself healthy. */
  get faultReason(): string | null {
    return this.fault
  }

  /**
   * Open (or create) the store and authenticate whatever is already on disk.
   *
   * Throws only for the two failures that are a caller's to fix: a key of the wrong
   * length, and a path this build cannot read or create. A *damaged file* degrades
   * instead of throwing, because a damaged file is something Core should keep running
   * through while saying so.
   */
  static async open(options: EncryptedSkillStoreOptions): Promise<EncryptedSkillStore> {
    if (typeof options.path !== 'string' || options.path.length === 0) {
      throw new SkillPersistenceError('invalid', 'the Skill store needs a file path')
    }
    if (options.key.length !== KEY_BYTES) {
      throw new SkillPersistenceError(
        'unauthenticated',
        `the Skill key must be ${KEY_BYTES} bytes, received ${options.key.length}`,
      )
    }

    const store = new EncryptedSkillStore(options, skillStoreBinding(options.key, options.path))
    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch (error) {
      throw new SkillPersistenceError(
        'unavailable',
        `the Skill store directory could not be created: ${describe(error)}`,
      )
    }

    let raw: string
    try {
      raw = await readFile(options.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        // Created empty, and not written to again until there is something to commit:
        // a first run must not fill a disk with files holding nothing.
        await writeFile(options.path, '', { encoding: 'utf8', flag: 'a', mode: 0o600 })
        return store
      }
      throw new SkillPersistenceError(
        'unavailable',
        `the Skill store could not be read: ${describe(error)}`,
      )
    }

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      store.replay(line)
      // Stop at the first record that cannot be believed. Continuing would mean
      // serving a history whose contents depend on what an attacker damaged, and the
      // records after the break would be dropped by the next commit anyway.
      if (store.fault !== null) break
    }
    return store
  }

  /** Read one line: authenticate, then check it is a legal record. */
  private replay(line: string): void {
    let stored: StoredRecord
    try {
      stored = JSON.parse(line) as StoredRecord
    } catch {
      this.degrade('a Skill record is not valid JSON')
      return
    }
    if (typeof stored !== 'object' || stored === null) {
      this.degrade('a Skill record is not an object')
      return
    }
    // Version before shape, so a record from a future format is reported as exactly
    // that rather than as an unrecognised shape.
    if (stored.v !== SKILL_SNAPSHOT_VERSION) {
      this.degrade(
        `a Skill record is version ${String(stored.v)}, and this build reads version ${SKILL_SNAPSHOT_VERSION}`,
      )
      return
    }
    if (
      typeof stored.skillId !== 'string' ||
      stored.skillId.length === 0 ||
      typeof stored.nonce !== 'string' ||
      typeof stored.cipher !== 'string' ||
      typeof stored.tag !== 'string'
    ) {
      this.degrade('a Skill record has an unrecognised shape')
      return
    }
    try {
      // Opened once and discarded: the plaintext must not sit in memory for the life
      // of the process when the only caller wants it once.
      this.readRecord(stored)
    } catch (error) {
      this.degrade(
        isSkillPersistenceError(error) && error.code === 'unauthenticated'
          ? 'a Skill record failed authentication and was not read'
          : `a Skill record did not survive being read: ${describe(error)}`,
      )
      return
    }
    if (this.records.has(stored.skillId)) {
      this.degrade(`the Skill store holds two records with the id ${stored.skillId}`)
      return
    }
    this.records.set(stored.skillId, stored)
  }

  /** Recover the retained snapshot, or refuse in words. */
  async load(): Promise<SkillSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the Skill store is closed' }
    }
    if (this.fault !== null) {
      return { ok: false, code: 'degraded', reason: this.fault }
    }
    const records: SkillRecord[] = []
    for (const stored of this.records.values()) {
      try {
        records.push(this.readRecord(stored))
      } catch (error) {
        // Unreachable in practice — every record was opened at replay — and handled
        // anyway, because "unreachable" is how a store ends up serving half a history
        // after a refactor moves the check.
        return {
          ok: false,
          code: 'degraded',
          reason: this.degrade(`a Skill record could not be read on recovery: ${describe(error)}`),
        }
      }
    }
    try {
      return { ok: true, snapshot: decodeSkillSnapshot({ v: SKILL_SNAPSHOT_VERSION, records }) }
    } catch (error) {
      return { ok: false, code: 'degraded', reason: this.degrade(describe(error)) }
    }
  }

  /**
   * Write the whole retained set, encrypted, atomically.
   *
   * Whole-file rather than appended, because the retained set is small, bounded and
   * *replaced*: a body is revised, a procedure is retired, a version is superseded.
   * An append-only log of a set that shrinks would need deletions, and a deletion
   * that is not authenticated is a hole.
   */
  async commit(snapshot: SkillSnapshot): Promise<void> {
    if (this.closed) throw new SkillPersistenceError('unavailable', 'the Skill store is closed')
    this.refuseIfDamaged()
    const validated = encodeSkillSnapshot(snapshot)
    if (skillSnapshotBytes(validated) > MAX_SKILL_SNAPSHOT_BYTES) {
      throw new SkillPersistenceError('too_large', 'the Skill snapshot exceeds the per-store limit')
    }

    const task = (): Promise<void> => this.writeOne(validated)
    const result = this.writeTail.then(task, task)
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeOne(snapshot: SkillSnapshot): Promise<void> {
    // Re-checked after the previous write in the chain has landed, so a fault recorded
    // by that write stops this one instead of racing past it.
    this.refuseIfDamaged()
    const next = new Map<string, StoredRecord>()
    const lines: string[] = []
    for (const record of snapshot.records) {
      const stored = this.seal(record)
      const serialised = `${JSON.stringify(stored)}\n`
      if (Buffer.byteLength(serialised, 'utf8') > MAX_SKILL_RECORD_BYTES) {
        throw new SkillPersistenceError(
          'too_large',
          `the skill record ${record.skillId} exceeds the per-record limit`,
        )
      }
      next.set(record.skillId, stored)
      lines.push(serialised)
    }

    try {
      await writeFile(this.staging, lines.join(''), { encoding: 'utf8', mode: 0o600 })
      await replaceFile(this.staging, this.path)
    } catch (error) {
      throw new SkillPersistenceError('write_failed', `skills could not be written: ${describe(error)}`)
    }
    this.records = next
  }

  private seal(record: SkillRecord): StoredRecord {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    cipher.setAAD(this.aad(record.skillId))
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(record), 'utf8')),
      cipher.final(),
    ])
    return {
      v: SKILL_SNAPSHOT_VERSION,
      skillId: record.skillId,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  }

  /** Open one record and re-check it against the domain's own rules. */
  private readRecord(stored: StoredRecord): SkillRecord {
    const nonce = Buffer.from(stored.nonce, 'base64')
    const tag = Buffer.from(stored.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new SkillPersistenceError('unauthenticated', 'a Skill record has the wrong nonce or tag size')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(this.aad(stored.skillId))
    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(stored.cipher, 'base64')), decipher.final()])
    } catch (error) {
      throw new SkillPersistenceError(
        'unauthenticated',
        `a Skill record did not authenticate: ${describe(error)}`,
      )
    }
    return decodeSkillRecord(JSON.parse(plaintext.toString('utf8')))
  }

  private aad(skillId: string): Buffer {
    return Buffer.from(skillRecordAad(this.binding, skillId), 'utf8')
  }

  private refuseIfDamaged(): void {
    if (this.fault !== null) {
      throw new SkillPersistenceError(
        'degraded',
        `skills are not being written because this store is damaged: ${this.fault}`,
      )
    }
  }

  /** Record a fault, keeping the first one, and hand back what is recorded. */
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
 * Derived rather than stored, so there is no file an attacker could copy a binding
 * out of, and derived *with the domain label* so a Mission key offered to a Skill
 * store produces a different binding as well as a different AAD prefix.
 */
export function skillStoreBinding(key: Uint8Array, path: string): string {
  return createHash('sha256')
    .update(SKILL_CRYPTO_DOMAIN)
    .update(ZERO)
    .update(key)
    .update(ZERO)
    .update(path)
    .digest('base64')
    .slice(0, 32)
}

/** The AAD for one record. The id is inside it, which blocks re-labelling. */
export function skillRecordAad(binding: string, skillId: string): string {
  return `${SKILL_CRYPTO_DOMAIN}|${binding}|${skillId}`
}

/** Re-exported so the size guard is one import at every call site. */
export { MAX_SKILL_RECORD_BYTES, MAX_SKILL_SNAPSHOT_BYTES, skillRecordBytes }

/**
 * `rename`, retried a few times on the transient refusals Windows gives.
 *
 * On Windows a rename onto a file another handle is touching fails with `EPERM` or
 * `EBUSY` and succeeds a moment later. Treating that as "skills could not be written"
 * would mean a person's procedures are refused for a reason that has nothing to do
 * with them, so the rename is retried briefly and then *fails*: the alternative,
 * looping forever, would turn a locked file into a hung save.
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