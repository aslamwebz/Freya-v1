import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ATTENTION_LIMITS } from './types'

/** Private schedule bodies are separate from the journal's timing metadata. */
export interface AttentionScheduleTextStore {
  readonly durable: boolean
  readonly faultReason?: string | null
  listIds(): Promise<readonly string[]>
  read(scheduleId: string): Promise<string | null>
  write(scheduleId: string, text: string): Promise<void>
  remove(scheduleId: string): Promise<void>
  close(): Promise<void>
}

/** Preserve the journal's pending metadata while encrypted storage is unavailable. */
export class UnavailableAttentionScheduleStore implements AttentionScheduleTextStore {
  readonly durable = false
  constructor(readonly faultReason: string) {}
  async listIds(): Promise<readonly string[]> { throw new Error(this.faultReason) }
  async read(): Promise<string | null> { throw new Error(this.faultReason) }
  async write(): Promise<void> { throw new Error(this.faultReason) }
  async remove(): Promise<void> { throw new Error(this.faultReason) }
  async close(): Promise<void> {}
}

export class EncryptedAttentionScheduleStore implements AttentionScheduleTextStore {
  readonly durable = true
  private records = new Map<string, string>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly key: Buffer

  private constructor(private readonly path: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error('Attention persistence requires a dedicated 32-byte key.')
    this.key = Buffer.from(key)
  }

  static async open(options: { path: string; key: Uint8Array }): Promise<EncryptedAttentionScheduleStore> {
    const store = new EncryptedAttentionScheduleStore(options.path, options.key)
    await mkdir(dirname(options.path), { recursive: true })
    let bytes: string
    try { bytes = await readFile(options.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error }
    if (bytes.length > 512_000) throw new Error('Attention schedule store exceeds its bound.')
    const row = JSON.parse(bytes) as { v: number; nonce: string; tag: string; ciphertext: string }
    if (row.v !== 1) throw new Error('Unknown Attention schedule store version.')
    const decrypt = createDecipheriv('aes-256-gcm', store.key, Buffer.from(row.nonce, 'base64'))
    decrypt.setAAD(Buffer.from(`freya.attention.schedules.v1:${options.path}`))
    decrypt.setAuthTag(Buffer.from(row.tag, 'base64'))
    const content: unknown = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(row.ciphertext, 'base64')), decrypt.final()]).toString('utf8'))
    if (!Array.isArray(content) || content.length > ATTENTION_LIMITS.maxSchedules) throw new Error('Attention schedule store is malformed.')
    for (const entry of content) {
      if (!Array.isArray(entry) || entry.length !== 2 || !valid(entry[0], entry[1])) throw new Error('Attention schedule content is malformed.')
      store.records.set(entry[0] as string, entry[1] as string)
    }
    return store
  }

  async read(scheduleId: string): Promise<string | null> {
    if (this.closed) throw new Error('Attention schedule store is closed.')
    await this.tail
    return this.records.get(scheduleId) ?? null
  }
  async listIds(): Promise<readonly string[]> {
    if (this.closed) throw new Error('Attention schedule store is closed.')
    await this.tail
    return [...this.records.keys()]
  }
  write(scheduleId: string, text: string): Promise<void> {
    if (!valid(scheduleId, text)) return Promise.reject(new Error('Attention schedule content is malformed.'))
    return this.mutate(next => {
      if (!next.has(scheduleId) && next.size >= ATTENTION_LIMITS.maxSchedules) throw new Error('Attention schedule store is full.')
      next.set(scheduleId, text)
    })
  }
  remove(scheduleId: string): Promise<void> { return this.mutate(next => { next.delete(scheduleId) }) }

  private mutate(change: (next: Map<string, string>) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Attention schedule store is closed.'))
    const operation = this.tail.then(async () => {
      const next = new Map(this.records)
      change(next)
      const nonce = randomBytes(12)
      const encrypt = createCipheriv('aes-256-gcm', this.key, nonce)
      encrypt.setAAD(Buffer.from(`freya.attention.schedules.v1:${this.path}`))
      const ciphertext = Buffer.concat([encrypt.update(JSON.stringify([...next]), 'utf8'), encrypt.final()])
      const data = JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: encrypt.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
      const temporary = `${this.path}.tmp`
      const handle = await open(temporary, 'w', 0o600)
      try { await handle.writeFile(data, 'utf8'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.path)
      this.records = next
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  async close(): Promise<void> { this.closed = true; await this.tail; this.key.fill(0); this.records.clear() }
}

function valid(id: unknown, text: unknown): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    && typeof text === 'string' && text.length > 0 && text.length <= ATTENTION_LIMITS.maxEventTextChars
}
