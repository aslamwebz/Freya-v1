import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  MissionStoreError,
  type MissionContentResult,
  type MissionStore,
  type MissionStoreHealth,
} from './store'
import type { MissionContent } from './types'

/**
 * The encrypted Mission content store.
 *
 * One line per Mission, rewritten in place when its content changes. Unlike the
 * Brain's append-only log there is no hash chain here, and the difference is
 * deliberate rather than an omission: a Brain holds many records that accumulate,
 * so detecting a removed record matters. A Mission's content is a single current
 * value — its *history* of edits is in the journal — so the thing worth protecting
 * is that the current text cannot be read or altered by anyone without the key,
 * which the tag and the context binding already give.
 *
 * ```
 *   line = { v, missionId, nonce, cipher, tag }
 *          \_____ authenticated as AAD ____/
 * ```
 *
 * `missionId` is inside the AAD, so a record cannot be re-labelled: moving one
 * Mission's text onto another Mission's id changes the tag and the read fails. The
 * context binding adds `sha256(key ‖ path)`, so this store cannot be opened by
 * another domain's key even if one were mistakenly supplied.
 *
 * ## Key separation
 *
 * The Mission domain has its own secret. A Mission is about somebody's plans;
 * conversation history and memories are about their life and their past. Recovering
 * one domain's key yields that domain and nothing else — see `electron/keyring.ts`
 * for why there is deliberately no master root.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const ZERO = Buffer.from([0])

/**
 * One record may not exceed this.
 *
 * Content is bounded by `normaliseMissionContent` before it reaches here; this is a
 * second, independent ceiling so that a future caller who forgets to normalise
 * cannot write an arbitrarily large file through the encrypted store.
 */
export const MAX_MISSION_RECORD_BYTES = 256 * 1024

interface StoredLine {
  v: 1
  missionId: string
  nonce: string
  cipher: string
  tag: string
}

export interface EncryptedMissionStoreOptions {
  path: string
  /** The Mission domain's own 32-byte key. Not the Brain key. Not the conversation key. */
  key: Uint8Array
}

export class EncryptedMissionStore implements MissionStore {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly faultReason = null

  private readonly path: string
  private readonly key: Buffer
  private readonly context: string
  private records = new Map<string, StoredLine>()
  private degraded: string | null = null
  private closed = false
  /** Serialised writes, so two Mission updates cannot interleave into a torn file. */
  private writeTail: Promise<unknown> = Promise.resolve()

  private constructor(options: EncryptedMissionStoreOptions) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    this.context = createHash('sha256')
      .update(this.key)
      .update(ZERO)
      .update(options.path)
      .digest('base64')
      .slice(0, 32)
  }

  static async open(options: EncryptedMissionStoreOptions): Promise<EncryptedMissionStore> {
    if (options.key.length !== KEY_BYTES) {
      throw new MissionStoreError(
        'unauthenticated',
        `the Mission key must be ${KEY_BYTES} bytes, received ${options.key.length}`,
      )
    }
    const store = new EncryptedMissionStore(options)
    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch (error) {
      throw new MissionStoreError('unavailable', `the Mission store directory could not be created: ${describe(error)}`)
    }

    let raw: string
    try {
      raw = await readFile(options.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        await writeFile(options.path, '', { encoding: 'utf8', flag: 'a' })
        return store
      }
      throw new MissionStoreError('unavailable', `the Mission store could not be read: ${describe(error)}`)
    }

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      store.replay(line)
      if (store.degraded !== null) break
    }
    return store
  }

  /**
   * Read the store, stopping at the first record that does not verify.
   *
   * Reported and stopped rather than skipped, because a store that quietly serves
   * the records it could read is a store whose contents depend on what an attacker
   * chose to damage.
   */
  private replay(line: string): void {
    let stored: StoredLine
    try {
      stored = JSON.parse(line) as StoredLine
    } catch {
      this.degrade('a Mission record is not valid JSON')
      return
    }
    if (typeof stored !== 'object' || stored === null || typeof stored.missionId !== 'string') {
      this.degrade('a Mission record has an unrecognised shape')
      return
    }
    try {
      // Decrypted once and discarded: the plaintext must not sit in memory for the
      // life of the process when the caller only ever wants it once.
      const plaintext = this.open(stored)
      const parsed = JSON.parse(plaintext.toString('utf8')) as MissionContent
      if (parsed.missionId !== stored.missionId) {
        this.degrade('a Mission record decrypted to a different Mission')
        return
      }
    } catch {
      this.degrade('a Mission record failed authentication and was not read')
      return
    }
    this.records.set(stored.missionId, stored)
  }

  private open(stored: StoredLine): Buffer {
    const nonce = Buffer.from(stored.nonce, 'base64')
    const tag = Buffer.from(stored.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new MissionStoreError('unauthenticated', 'a Mission record has the wrong nonce or tag size')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(this.aad(stored.missionId))
    return Buffer.concat([decipher.update(Buffer.from(stored.cipher, 'base64')), decipher.final()])
  }

  private aad(missionId: string): Buffer {
    return Buffer.from(`freya.mission.v1|${this.context}|${missionId}`, 'utf8')
  }

  async write(content: MissionContent): Promise<MissionContent> {
    if (this.closed) throw new MissionStoreError('unavailable', 'the Mission store is closed')
    const validated = validate(content)
    if (!validated.ok) throw new MissionStoreError('invalid', validated.reason)

    const task = (): Promise<MissionContent> => this.writeOne(validated.value)
    const result = this.writeTail.then(task, task)
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeOne(content: MissionContent): Promise<MissionContent> {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    cipher.setAAD(this.aad(content.missionId))
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(content), 'utf8')), cipher.final()])
    const stored: StoredLine = {
      v: 1,
      missionId: content.missionId,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
    const serialised = `${JSON.stringify(stored)}\n`
    if (Buffer.byteLength(serialised, 'utf8') > MAX_MISSION_RECORD_BYTES) {
      throw new MissionStoreError('too_large', 'Mission content exceeds the per-record limit')
    }

    const next = new Map(this.records)
    next.set(content.missionId, stored)
    try {
      // Rewritten whole rather than appended, because a Mission has one current
      // value. Atomic via temp+rename so a crash cannot leave a half-written file
      // that reads as "no Missions at all".
      await writeFile(`${this.path}.tmp`, serialise(next), { encoding: 'utf8', mode: 0o600 })
      await replaceFile(`${this.path}.tmp`, this.path)
    } catch (error) {
      throw new MissionStoreError('write_failed', `Mission content could not be written: ${describe(error)}`)
    }
    this.records = next
    return content
  }

  async read(missionId: string): Promise<MissionContentResult> {
    if (this.closed) {
      return { ok: false, code: 'unavailable', reason: 'the Mission store is closed' }
    }
    if (this.degraded !== null) {
      // Refusing to serve partial content rather than returning whatever survived:
      // a Mission shown with half its intent is a Mission that reads as true.
      return { ok: false, code: 'degraded', reason: this.degraded }
    }
    const stored = this.records.get(missionId)
    if (stored === undefined) {
      return { ok: false, code: 'not_found', reason: 'no Mission content is stored for that Mission' }
    }
    try {
      const parsed = JSON.parse(this.open(stored).toString('utf8')) as MissionContent
      return { ok: true, value: parsed }
    } catch {
      return { ok: false, code: 'unauthenticated', reason: 'Mission content could not be read' }
    }
  }

  async remove(missionId: string): Promise<boolean> {
    if (this.closed) throw new MissionStoreError('unavailable', 'the Mission store is closed')
    if (!this.records.has(missionId)) return false
    const next = new Map(this.records)
    next.delete(missionId)
    try {
      await writeFile(`${this.path}.tmp`, serialise(next), { encoding: 'utf8', mode: 0o600 })
      await replaceFile(`${this.path}.tmp`, this.path)
    } catch (error) {
      throw new MissionStoreError('write_failed', `Mission content could not be removed: ${describe(error)}`)
    }
    this.records = next
    return true
  }

  health(): MissionStoreHealth {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writeTail
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}

function serialise(records: ReadonlyMap<string, StoredLine>): string {
  return [...records.values()].map((record) => `${JSON.stringify(record)}\n`).join('')
}

/** `rename` without a Windows fallback chain, kept separate so the intent is named. */
async function replaceFile(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises')
  await rename(from, to)
}

/**
 * Shape check on the way in.
 *
 * The engine normalises content before it gets here, so this is a second,
 * independent gate: a store that trusted its only caller would put the burden of
 * every bound on that one caller.
 */
function validate(content: MissionContent): { ok: true; value: MissionContent } | { ok: false; reason: string } {
  if (typeof content !== 'object' || content === null) return { ok: false, reason: 'Mission content is malformed' }
  const c = content as unknown as Record<string, unknown>
  if (typeof c.missionId !== 'string' || c.missionId.length === 0 || c.missionId.length > 256) {
    return { ok: false, reason: 'Mission content has no usable id' }
  }
  if (typeof c.title !== 'string' || typeof c.intent !== 'string') {
    return { ok: false, reason: 'Mission content is missing its title or intent' }
  }
  if (!Array.isArray(c.successCriteria)) return { ok: false, reason: 'Mission content has malformed criteria' }
  if (c.successCriteria.some((item) => typeof item !== 'string')) {
    return { ok: false, reason: 'Mission content has malformed criteria' }
  }
  if (typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt))) {
    return { ok: false, reason: 'Mission content has no usable creation time' }
  }
  return { ok: true, value: content }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/** Used by the tests to prove the ephemeral store writes nothing at all. */
export const MISSION_CONTENT_SUFFIX = '.tmp'

export { rm as removeFile }