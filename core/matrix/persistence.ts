import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { MATRIX_LIMITS, type MatrixEntry, type MatrixSpace } from '../protocol/matrix'

export interface MatrixSnapshot {
  readonly v: 1
  readonly spaces: readonly MatrixSpace[]
  readonly entries: readonly MatrixEntry[]
  readonly attachments: Readonly<Record<string, readonly string[]>>
}
export function emptyMatrixSnapshot(): MatrixSnapshot { return { v: 1, spaces: [], entries: [], attachments: {} } }

/** A single-writer encrypted snapshot. An unreadable snapshot stays untouched. */
export class MatrixPersistence {
  private closed = false
  private readonly aad: Buffer
  private constructor(private readonly path: string, private readonly key: Buffer) {
    this.aad = Buffer.from(`freya.matrix.v1\0${resolve(path)}`)
  }
  static async open(options: { path: string; key: Uint8Array }): Promise<MatrixPersistence> {
    if (!options.path || options.key.length !== 32) throw new Error('Matrix needs a secure 32-byte storage key and a file path.')
    await mkdir(dirname(options.path), { recursive: true })
    return new MatrixPersistence(options.path, Buffer.from(options.key))
  }
  async load(): Promise<unknown> {
    this.assertOpen()
    try {
      if ((await stat(this.path)).size > MATRIX_LIMITS.snapshotBytes * 2) throw new Error('Matrix storage exceeds its size limit.')
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!raw || typeof raw !== 'object') throw new Error('Invalid Matrix storage.')
      const item = raw as Record<string, unknown>
      if (item.v !== 1 || typeof item.nonce !== 'string' || typeof item.tag !== 'string' || typeof item.cipher !== 'string') throw new Error('Invalid Matrix storage format.')
      const nonce = Buffer.from(item.nonce, 'base64')
      const tag = Buffer.from(item.tag, 'base64')
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid Matrix encryption metadata.')
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
      decipher.setAAD(this.aad)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(Buffer.from(item.cipher, 'base64')), decipher.final()])
      if (plain.byteLength > MATRIX_LIMITS.snapshotBytes) throw new Error('Matrix storage exceeds its size limit.')
      return JSON.parse(plain.toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyMatrixSnapshot()
      throw error
    }
  }
  async commit(snapshot: MatrixSnapshot): Promise<void> {
    this.assertOpen()
    const plain = Buffer.from(JSON.stringify(snapshot), 'utf8')
    if (plain.byteLength > MATRIX_LIMITS.snapshotBytes) throw new Error('Matrix is full. Remove files before adding more.')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(this.aad)
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const raw = JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), cipher: encrypted.toString('base64') })
    const staging = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const file = await open(staging, 'wx', 0o600)
      try { await file.writeFile(raw, 'utf8'); await file.sync() } finally { await file.close() }
      await rename(staging, this.path)
    } finally { await rm(staging, { force: true }).catch(() => {}) }
  }
  close(): void { this.closed = true; this.key.fill(0) }
  private assertOpen(): void { if (this.closed) throw new Error('Matrix storage is closed.') }
}
