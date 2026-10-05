import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  MAX_FORGE_SNAPSHOT_BYTES,
  decodeForgeSnapshot,
  encodeForgeSnapshot,
  type ForgePersistencePort,
  type ForgeSnapshotLoad,
} from './port'
import type { ForgeStoredPackage } from '../engine'

/**
 * THE ENCRYPTED FORGE STORE.
 *
 * One AES-256-GCM blob, rewritten whenever the retained set changes. A Forge
 * package body is a program Freya can run, together with the capability map it
 * asks for and the literals it emits — so a stolen laptop, a synced folder or a
 * support bundle must contain none of it.
 *
 * ```
 *   file = { v, nonce, cipher, tag, len }
 *          \________ authenticated as AAD ________/
 * ```
 *
 * - **Authenticated, not merely encrypted.** GCM's tag is verified on every read,
 *   and a file that fails it is reported rather than opened.
 * - **A fresh nonce per write**, from the CSPRNG. Rewriting an unchanged body still
 *   produces new ciphertext rather than re-encrypting under a repeatable nonce.
 * - **The header is AAD**, together with this domain's label and this file's own
 *   path, so a store cannot be re-labelled, moved between domains, or read by a
 *   Forge store that happens to hold the same key.
 *
 * Core never generates this key and never persists one. A host obtains it from OS
 * secure storage and supplies it; a Core without one gets the ephemeral port, which
 * states it in words and writes nothing.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** A byte rather than a source escape: a path cannot contain one. */
const ZERO = Buffer.from([0])

/**
 * This domain's own label. Format, not secret — a test that writes a record by
 * hand has to reproduce it exactly.
 */
export const FORGE_CRYPTO_DOMAIN = 'freya.forge.store.v1'

interface StoredFile {
  v: 1
  nonce: string
  cipher: string
  tag: string
  len: number
}

export interface EncryptedForgeStoreOptions {
  readonly path: string
  /** The Forge domain's own 32-byte key. Not the Skill, Mission or chat key. */
  readonly key: Uint8Array
}

export class EncryptedForgeStore implements ForgePersistencePort {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly durabilityReason = null as string | null

  private readonly path: string
  private readonly key: Buffer
  private readonly binding: string
  private readonly staging: string
  private fault: string | null = null
  private closed = false

  constructor(options: EncryptedForgeStoreOptions) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    if (this.key.length !== KEY_BYTES) {
      throw new Error(`forge store key must be ${KEY_BYTES} bytes`)
    }
    this.binding = createHash('sha256')
      .update(FORGE_CRYPTO_DOMAIN)
      .update(ZERO)
      .update(options.path)
      .digest('hex')
      .slice(0, 32)
    this.staging = `${options.path}.staging`
  }

  get faultReason(): string | null {
    return this.fault
  }

  async load(): Promise<ForgeSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'unreadable', reason: 'this Forge store is closed' }
    }
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      // A store that does not exist yet is an empty store, not a fault. A store
      // that exists and cannot be read is a fault, and the distinction is the
      // difference between "first start" and "something is wrong".
      return { ok: true, packages: [] }
    }
    if (raw.length > MAX_FORGE_SNAPSHOT_BYTES * 2) {
      this.fault = 'the Forge store on disk is larger than this build accepts'
      return { ok: false, code: 'oversize', reason: this.fault }
    }

    let stored: StoredFile
    try {
      stored = JSON.parse(raw) as StoredFile
    } catch {
      this.fault = 'the Forge store is not readable'
      return { ok: false, code: 'malformed-snapshot', reason: this.fault }
    }
    if (
      stored === null ||
      typeof stored !== 'object' ||
      stored.v !== 1 ||
      typeof stored.nonce !== 'string' ||
      typeof stored.cipher !== 'string' ||
      typeof stored.tag !== 'string' ||
      typeof stored.len !== 'number'
    ) {
      this.fault = 'the Forge store is not in the shape this build writes'
      return { ok: false, code: 'malformed-snapshot', reason: this.fault }
    }

    let plain: Buffer
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(stored.nonce, 'base64'))
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
      decipher.setAAD(Buffer.from(this.binding, 'utf8'))
      const chunks: Buffer[] = []
      const body = decipher.update(Buffer.from(stored.cipher, 'base64'))
      chunks.push(Buffer.from(body))
      chunks.push(Buffer.from(await decipher.final()))
      plain = Buffer.concat(chunks)
    } catch {
      // Authentication failed: edited, truncated, swapped, or the wrong key.
      this.fault = 'the Forge store could not be authenticated, so nothing in it is believed'
      return { ok: false, code: 'unauthenticated', reason: this.fault }
    }

    const decoded = decodeForgeSnapshot(plain.toString('utf8'))
    if (!decoded.ok) {
      this.fault = 'the Forge store holds something this build cannot believe'
      return decoded
    }
    return decoded
  }

  async commit(packages: readonly ForgeStoredPackage[]): Promise<void> {
    if (this.closed || this.fault !== null) return
    let text: string
    try {
      text = encodeForgeSnapshot(packages)
    } catch {
      this.fault = 'the Forge body set is larger than this build accepts'
      return
    }
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv(ALGORITHM, this.key, nonce)
      cipher.setAAD(Buffer.from(this.binding, 'utf8'))
      const encrypted = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()])
      const file: StoredFile = {
        v: 1,
        nonce: nonce.toString('base64'),
        cipher: encrypted.toString('base64'),
        tag: cipher.getAuthTag().subarray(0, TAG_BYTES).toString('base64'),
        len: encrypted.length,
      }
      await writeFile(this.staging, JSON.stringify(file), 'utf8')
      await rename(this.staging, this.path)
    } catch {
      this.fault = 'the Forge store could not be written, so bodies are held in this process only'
      await rm(this.staging, { force: true }).catch(() => {})
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await rm(this.staging, { force: true }).catch(() => {})
  }
}
