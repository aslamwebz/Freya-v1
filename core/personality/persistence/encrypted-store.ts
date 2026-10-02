import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  PERSONALITY_LIMITS,
  type CueUsageLedger,
  type RelationshipItem,
} from '../types'
import type { PersonalityPersistencePort, PersonalitySnapshot, PersonalitySnapshotLoad } from './port'
import { PERSONALITY_SNAPSHOT_VERSION } from './port'
import { PersonalityPersistenceError, isPersonalityPersistenceError } from './errors'
import {
  MAX_PERSONALITY_RECORD_BYTES,
  MAX_PERSONALITY_SNAPSHOT_BYTES,
  decodeLedger,
  decodePersonalityItem,
  decodePersonalitySnapshot,
  encodePersonalitySnapshot,
  LEDGER_RECORD_ID,
  personalitySnapshotBytes,
} from './snapshot'

/**
 * THE ENCRYPTED PERSONALITY STORE.
 *
 * One encrypted line per retained record, the whole file rewritten when the
 * retained set changes. Relationship items are the most personal data Freya
 * holds — facts about a person, their preferences, their habits, their
 * inside jokes — so a stolen laptop, a synced folder or a support bundle must
 * contain none of it: the private part — text, tags, provenance — is under
 * AES-256-GCM, and the only plaintext on disk is a record id.
 *
 * ```
 *   line = { v, itemId, nonce, cipher, tag }
 *          \________ authenticated as AAD ________/
 * ```
 *
 * ## Why each part is there
 *
 * - **Authenticated encryption, not encryption.** GCM's tag is verified on every
 *   read. A record that was edited, truncated or swapped fails to open and is
 *   reported. There is no "decrypt anyway" path.
 * - **A unique nonce per record, per write**, from the CSPRNG. GCM nonce reuse
 *   under one key leaks the XOR of two plaintexts and the authentication key.
 * - **The header is AAD.** The record id is fed in as additional authenticated
 *   data, so a record cannot be re-labelled onto another id.
 * - **A per-store binding** in the AAD, derived from this domain's label, the
 *   key and this file's own path, so two Personality stores that somehow
 *   shared a key still cannot read each other.
 *
 * ## Key separation: Personality is its own domain
 *
 * The Personality key is not the Context key, not the Brain key, not the
 * conversation key and not the Mission key. They are independent secrets, and
 * a Personality store cannot open a Context file even when handed the Context
 * key — the AAD prefix differs by domain *and* the store binding is derived
 * from the domain label.
 *
 * Core never generates this key and never persists one. A host obtains it from
 * OS secure storage and supplies it here; a Core without one gets the
 * ephemeral port instead, which is stated in words and writes nothing at all.
 *
 * ## What a damaged store does
 *
 * Reading stops at the first record that cannot be believed, and the store is
 * marked degraded from then on: it serves nothing and it writes nothing.
 *
 * Both halves of that are load-bearing rather than cautious. Serving what
 * parsed would make the retained set a function of which records an attacker
 * chose to damage. Writing would be worse still: a commit rewrites the file
 * from what this store holds, so writing from a partial read would drop every
 * record after the break, permanently and invisibly.
 *
 * A Personality fault is not a security event. It cannot grant anything, and it
 * does not lock Freya out either: the loss is bounded, the reason is in words,
 * and nothing outside this directory imports this module.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * Separator byte for the binding digest.
 */
const ZERO = Buffer.from([0])

/**
 * This domain's own label.
 *
 * In the AAD and in the binding digest, so a Personality store is a different
 * cipher context from every other domain even if it were handed another key.
 */
export const PERSONALITY_CRYPTO_DOMAIN = 'freya.personality.v1'

/** The line on disk. Everything outside `cipher` is authenticated as AAD. */
interface StoredRecord {
  v: typeof PERSONALITY_SNAPSHOT_VERSION
  itemId: string
  nonce: string
  cipher: string
  tag: string
}

export interface EncryptedPersonalityStoreOptions {
  readonly path: string
  /** The Personality domain's own 32-byte key. */
  readonly key: Uint8Array
}

export class EncryptedPersonalityStore implements PersonalityPersistencePort {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly durabilityReason = null as string | null

  private readonly path: string
  private readonly key: Buffer
  private readonly binding: string
  private readonly staging: string

  private records = new Map<string, StoredRecord>()
  private ledger: CueUsageLedger | null = null
  private fault: string | null = null
  private closed = false
  private writeTail: Promise<unknown> = Promise.resolve()

  private constructor(options: EncryptedPersonalityStoreOptions, binding: string) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    this.binding = binding
    this.staging = `${options.path}.${randomBytes(6).toString('hex')}.tmp`
  }

  get faultReason(): string | null {
    return this.fault
  }

  static async open(options: EncryptedPersonalityStoreOptions): Promise<EncryptedPersonalityStore> {
    if (typeof options.path !== 'string' || options.path.length === 0) {
      throw new PersonalityPersistenceError('invalid', 'the Personality store needs a file path')
    }
    if (options.key.length !== KEY_BYTES) {
      throw new PersonalityPersistenceError(
        'unauthenticated',
        `the Personality key must be ${KEY_BYTES} bytes, received ${options.key.length}`,
      )
    }

    const store = new EncryptedPersonalityStore(options, personalityStoreBinding(options.key, options.path))
    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch (error) {
      throw new PersonalityPersistenceError(
        'unavailable',
        `the Personality store directory could not be created: ${describe(error)}`,
      )
    }

    let raw: string
    try {
      raw = await readFile(options.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        await writeFile(options.path, '', { encoding: 'utf8', flag: 'a', mode: 0o600 })
        return store
      }
      throw new PersonalityPersistenceError(
        'unavailable',
        `the Personality store could not be read: ${describe(error)}`,
      )
    }

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      store.replay(line)
      if (store.fault !== null) break
    }
    return store
  }

  private replay(line: string): void {
    let stored: StoredRecord
    try {
      stored = JSON.parse(line) as StoredRecord
    } catch {
      this.degrade('a Personality record is not valid JSON')
      return
    }
    if (typeof stored !== 'object' || stored === null) {
      this.degrade('a Personality record is not an object')
      return
    }
    if (stored.v !== PERSONALITY_SNAPSHOT_VERSION) {
      this.degrade(
        `a Personality record is version ${String(stored.v)}, and this build reads version ${PERSONALITY_SNAPSHOT_VERSION}`,
      )
      return
    }
    if (
      typeof stored.itemId !== 'string' ||
      stored.itemId.length === 0 ||
      typeof stored.nonce !== 'string' ||
      typeof stored.cipher !== 'string' ||
      typeof stored.tag !== 'string'
    ) {
      this.degrade('a Personality record has an unrecognised shape')
      return
    }
    if (stored.itemId === LEDGER_RECORD_ID) {
      this.replayLedger(stored)
      return
    }
    try {
      this.readItem(stored)
    } catch (error) {
      this.degrade(
        isPersonalityPersistenceError(error) && error.code === 'unauthenticated'
          ? 'a Personality record failed authentication and was not read'
          : `a Personality record did not survive being read: ${describe(error)}`,
      )
      return
    }
    if (this.records.has(stored.itemId)) {
      this.degrade(`the Personality store holds two records with the id ${stored.itemId}`)
      return
    }
    this.records.set(stored.itemId, stored)
  }

  private replayLedger(stored: StoredRecord): void {
    if (this.ledger !== null) {
      this.degrade('the Personality store holds two ledger records')
      return
    }
    try {
      this.ledger = this.readLedger(stored)
    } catch (error) {
      this.degrade(
        isPersonalityPersistenceError(error) && error.code === 'unauthenticated'
          ? 'the ledger failed authentication and was not read'
          : `the ledger did not survive being read: ${describe(error)}`,
      )
    }
  }

  async load(): Promise<PersonalitySnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the Personality store is closed' }
    }
    if (this.fault !== null) {
      return { ok: false, code: 'degraded', reason: this.fault }
    }
    const items: RelationshipItem[] = []
    for (const stored of this.records.values()) {
      try {
        items.push(this.readItem(stored))
      } catch (error) {
        return {
          ok: false,
          code: 'degraded',
          reason: this.degrade(`a Personality record could not be read on recovery: ${describe(error)}`),
        }
      }
    }
    try {
      return {
        ok: true,
        snapshot: decodePersonalitySnapshot({
          v: PERSONALITY_SNAPSHOT_VERSION,
          items,
          ledger: this.ledger ?? { schemaVersion: 1, maxEntries: PERSONALITY_LIMITS.maxLedgerEntries, entries: [] },
        }),
      }
    } catch (error) {
      return { ok: false, code: 'degraded', reason: this.degrade(describe(error)) }
    }
  }

  async commit(snapshot: PersonalitySnapshot): Promise<void> {
    if (this.closed) throw new PersonalityPersistenceError('unavailable', 'the Personality store is closed')
    this.refuseIfDamaged()
    const validated = encodePersonalitySnapshot(snapshot)
    if (personalitySnapshotBytes(validated) > MAX_PERSONALITY_SNAPSHOT_BYTES) {
      throw new PersonalityPersistenceError('too_large', 'the Personality snapshot exceeds the per-store limit')
    }

    const task = (): Promise<void> => this.writeOne(validated)
    const result = this.writeTail.then(task, task)
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeOne(snapshot: PersonalitySnapshot): Promise<void> {
    this.refuseIfDamaged()
    const next = new Map<string, StoredRecord>()
    const lines: string[] = []
    for (const item of snapshot.items) {
      const stored = this.seal(item)
      const serialised = `${JSON.stringify(stored)}\n`
      if (Buffer.byteLength(serialised, 'utf8') > MAX_PERSONALITY_RECORD_BYTES) {
        throw new PersonalityPersistenceError(
          'too_large',
          `the personality record ${item.itemId} exceeds the per-record limit`,
        )
      }
      next.set(item.itemId, stored)
      lines.push(serialised)
    }

    // The ledger is stored as a single encrypted record with a fixed id.
    const ledgerStored = this.sealLedger(snapshot.ledger)
    const ledgerSerialised = `${JSON.stringify(ledgerStored)}\n`
    if (Buffer.byteLength(ledgerSerialised, 'utf8') > MAX_PERSONALITY_RECORD_BYTES) {
      throw new PersonalityPersistenceError('too_large', 'the personality ledger exceeds the per-record limit')
    }
    lines.push(ledgerSerialised)

    try {
      await writeFile(this.staging, lines.join(''), { encoding: 'utf8', mode: 0o600 })
      await replaceFile(this.staging, this.path)
    } catch (error) {
      throw new PersonalityPersistenceError('write_failed', `personality data could not be written: ${describe(error)}`)
    }
    this.records = next
    this.ledger = snapshot.ledger
  }

  private seal(item: RelationshipItem): StoredRecord {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    cipher.setAAD(this.aad(item.itemId))
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(item), 'utf8')),
      cipher.final(),
    ])
    return {
      v: PERSONALITY_SNAPSHOT_VERSION,
      itemId: item.itemId,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  }

  private sealLedger(ledger: CueUsageLedger): StoredRecord {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    cipher.setAAD(this.aad(LEDGER_RECORD_ID))
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(ledger), 'utf8')),
      cipher.final(),
    ])
    return {
      v: PERSONALITY_SNAPSHOT_VERSION,
      itemId: LEDGER_RECORD_ID,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  }

  private readItem(stored: StoredRecord): RelationshipItem {
    const nonce = Buffer.from(stored.nonce, 'base64')
    const tag = Buffer.from(stored.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new PersonalityPersistenceError('unauthenticated', 'a Personality record has the wrong nonce or tag size')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(this.aad(stored.itemId))
    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(stored.cipher, 'base64')), decipher.final()])
    } catch (error) {
      throw new PersonalityPersistenceError('unauthenticated', `a Personality record did not authenticate: ${describe(error)}`)
    }
    return decodePersonalityItem(JSON.parse(plaintext.toString('utf8')))
  }

  private readLedger(stored: StoredRecord): CueUsageLedger {
    const nonce = Buffer.from(stored.nonce, 'base64')
    const tag = Buffer.from(stored.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new PersonalityPersistenceError('unauthenticated', 'the ledger has the wrong nonce or tag size')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(this.aad(LEDGER_RECORD_ID))
    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(stored.cipher, 'base64')), decipher.final()])
    } catch (error) {
      throw new PersonalityPersistenceError('unauthenticated', `the ledger did not authenticate: ${describe(error)}`)
    }
    return decodeLedger(JSON.parse(plaintext.toString('utf8')))
  }

  private aad(itemId: string): Buffer {
    return Buffer.from(personalityRecordAad(this.binding, itemId), 'utf8')
  }

  private refuseIfDamaged(): void {
    if (this.fault !== null) {
      throw new PersonalityPersistenceError(
        'degraded',
        `personality data is not being written because this store is damaged: ${this.fault}`,
      )
    }
  }

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
 */
export function personalityStoreBinding(key: Uint8Array, path: string): string {
  return createHash('sha256')
    .update(PERSONALITY_CRYPTO_DOMAIN)
    .update(ZERO)
    .update(key)
    .update(ZERO)
    .update(path)
    .digest('base64')
    .slice(0, 32)
}

/**
 * The additional authenticated data for one record.
 */
export function personalityRecordAad(binding: string, itemId: string): string {
  return `${PERSONALITY_CRYPTO_DOMAIN}|${binding}|${itemId}`
}

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
