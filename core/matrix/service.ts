import { randomUUID } from 'node:crypto'
import {
  MATRIX_COMMANDS, MATRIX_LIMITS,
  type MatrixCommandName, type MatrixCommandOutcome, type MatrixEntry, type MatrixEntryKind,
  type MatrixProjection, type MatrixSpace,
} from '../protocol/matrix'
import { emptyMatrixSnapshot, MatrixPersistence, type MatrixSnapshot } from './persistence'

export interface MatrixScope { readonly attachedSpaceIds: readonly string[] }
const kinds: readonly MatrixEntryKind[] = ['knowledge', 'person', 'file']
const refuse = (reason: string): MatrixCommandOutcome => ({ ok: false, operation: 'refused', reason })
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Matrix needs an object payload.')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit) throw new Error(`${label} must contain ${empty ? 'at most' : '1 to'} ${limit} characters.`)
  return value
}
function id(value: unknown): string { return text(value, 'ID', 160) }
function allowed(payload: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(payload).some(key => !keys.includes(key))) throw new Error('The Matrix request contains an unsupported field.')
}
function fileData(value: unknown): { dataBase64: string; sizeBytes: number } {
  const dataBase64 = text(value, 'File bytes', Math.ceil(MATRIX_LIMITS.fileBytes / 3) * 4, true)
  if (dataBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw new Error('File bytes must be valid base64.')
  const decoded = Buffer.from(dataBase64, 'base64')
  if (decoded.length > MATRIX_LIMITS.fileBytes || decoded.toString('base64') !== dataBase64) throw new Error('Files must be no larger than 1 MB.')
  return { dataBase64, sizeBytes: decoded.length }
}
function entryFields(payload: Record<string, unknown>, previous?: MatrixEntry): Pick<MatrixEntry, 'kind' | 'title' | 'content' | 'mimeType' | 'dataBase64' | 'sizeBytes'> {
  const kind = previous?.kind ?? payload.kind
  if (!kinds.includes(kind as MatrixEntryKind)) throw new Error('Choose knowledge, person, or file.')
  const title = text(payload.title ?? previous?.title, 'Title', MATRIX_LIMITS.titleChars)
  const content = text(payload.content ?? previous?.content ?? '', 'Content', MATRIX_LIMITS.contentChars, true)
  if (kind !== 'file' && (payload.dataBase64 !== undefined || payload.mimeType !== undefined)) throw new Error('Only files may contain file bytes or a media type.')
  return {
    kind: kind as MatrixEntryKind, title: title.trim(), content,
    ...(kind === 'file' ? {
      mimeType: text(payload.mimeType ?? previous?.mimeType ?? 'application/octet-stream', 'File type', 120),
      ...(payload.dataBase64 === undefined ? previous?.dataBase64 === undefined ? {} : { dataBase64: previous.dataBase64, sizeBytes: previous.sizeBytes } : fileData(payload.dataBase64)),
    } : {}),
  }
}

/** Core owns this state. Mutations become visible only after their durable commit. */
export class MatrixService {
  private snapshot: MatrixSnapshot = emptyMatrixSnapshot()
  private tail: Promise<unknown> = Promise.resolve()
  private fault: string | null = null
  private closed = false
  private constructor(private readonly persistence: MatrixPersistence | null, private readonly onChange: () => void) {}
  static async open(options: { path: string; key: Uint8Array | null; onChange?: () => void }): Promise<MatrixService> {
    let persistence: MatrixPersistence | null = null
    let reason: string | null = null
    try {
      if (options.key === null) throw new Error('Matrix needs secure storage before spaces can be saved.')
      persistence = await MatrixPersistence.open({ path: options.path, key: options.key })
    } catch (error) { reason = error instanceof Error ? error.message : 'Matrix storage is unavailable.' }
    const service = new MatrixService(persistence, options.onChange ?? (() => {}))
    service.fault = reason
    if (persistence) {
      try { service.snapshot = decodeSnapshot(await persistence.load()) }
      catch { service.fault = 'Matrix storage could not be read safely. The saved data has been preserved.' }
    }
    return service
  }
  projection(scope?: MatrixScope): MatrixProjection {
    return {
      health: this.closed || !this.persistence ? 'unavailable' : this.fault ? 'degraded' : 'ready',
      durable: !this.closed && this.persistence !== null && this.fault === null,
      reason: this.closed ? 'Matrix is closed.' : this.fault,
      spaces: this.snapshot.spaces.filter(space => !scope || scope.attachedSpaceIds.includes(space.id)).map(space => ({
        ...space, counts: {
          knowledge: this.snapshot.entries.filter(entry => entry.spaceId === space.id && entry.kind === 'knowledge').length,
          person: this.snapshot.entries.filter(entry => entry.spaceId === space.id && entry.kind === 'person').length,
          file: this.snapshot.entries.filter(entry => entry.spaceId === space.id && entry.kind === 'file').length,
        },
      })),
    }
  }
  attachedSpaceIds(conversationId: string): readonly string[] { return Object.hasOwn(this.snapshot.attachments, conversationId) ? [...this.snapshot.attachments[conversationId]!] : [] }
  hasSpace(spaceId: string): boolean { return this.snapshot.spaces.some(space => space.id === spaceId) }
  execute(command: MatrixCommandName | string, raw: unknown = {}, scope?: MatrixScope): Promise<MatrixCommandOutcome> {
    const operation = this.tail.then(() => this.perform(command, raw, scope))
    this.tail = operation.catch(() => {})
    return operation
  }
  async close(): Promise<void> { await this.tail; this.closed = true; this.persistence?.close() }

  private async perform(command: string, raw: unknown, scope?: MatrixScope): Promise<MatrixCommandOutcome> {
    if (this.closed || this.fault || !this.persistence) return refuse(this.projection().reason ?? 'Matrix storage is unavailable.')
    try {
      if (!MATRIX_COMMANDS.includes(command as MatrixCommandName)) return refuse('Unknown Matrix command.')
      const p = object(raw)
      if (command === 'matrix.spaces.read') {
        allowed(p, ['conversationId'])
        if (scope && p.conversationId !== undefined) return refuse('Chat bindings are owner-only.')
        return { ok: true, operation: 'read', projection: this.projection(scope), ...(p.conversationId !== undefined ? { attachedSpaceIds: this.attachedSpaceIds(id(p.conversationId)) } : {}) }
      }
      if (command === 'matrix.spaces.attach') {
        if (scope) return refuse('Only the owner can attach Matrix spaces to a chat.')
        allowed(p, ['conversationId', 'spaceIds'])
        const conversationId = id(p.conversationId)
        if (!Array.isArray(p.spaceIds) || p.spaceIds.length > MATRIX_LIMITS.attachments) throw new Error('Attach up to eight Matrix spaces.')
        const spaceIds = [...new Set(p.spaceIds.map(id))]
        if (spaceIds.some(spaceId => !this.hasSpace(spaceId))) throw new Error('A selected Matrix space no longer exists.')
        const attachments = Object.fromEntries([
          ...Object.entries(this.snapshot.attachments).filter(([chat]) => chat !== conversationId),
          ...(spaceIds.length ? [[conversationId, spaceIds] as const] : []),
        ])
        await this.save({ ...this.snapshot, attachments })
        return { ok: true, operation: 'attached', attachedSpaceIds: [...spaceIds], projection: this.projection() }
      }
      if (command === 'matrix.spaces.create') {
        if (scope) return refuse('Freya can manage attached spaces. Create a space in Matrix first.')
        allowed(p, ['name', 'description'])
        if (this.snapshot.spaces.length >= MATRIX_LIMITS.spaces) throw new Error('Matrix has reached its space limit.')
        const now = new Date().toISOString()
        const space: MatrixSpace = { id: randomUUID(), name: text(p.name, 'Space name', MATRIX_LIMITS.titleChars).trim(), description: text(p.description ?? '', 'Description', MATRIX_LIMITS.descriptionChars, true), createdAt: now, updatedAt: now }
        await this.save({ ...this.snapshot, spaces: [...this.snapshot.spaces, space] })
        return { ok: true, operation: 'created', space: { ...space }, projection: this.projection() }
      }
      const spaceId = id(p.spaceId)
      if (scope && !scope.attachedSpaceIds.includes(spaceId)) return refuse('This Matrix space is not attached to the current chat.')
      const space = this.snapshot.spaces.find(space => space.id === spaceId)
      if (!space) return refuse('This Matrix space no longer exists.')
      if (command === 'matrix.spaces.update') {
        allowed(p, ['spaceId', 'name', 'description'])
        const updated: MatrixSpace = { ...space, name: text(p.name ?? space.name, 'Space name', MATRIX_LIMITS.titleChars).trim(), description: text(p.description ?? space.description, 'Description', MATRIX_LIMITS.descriptionChars, true), updatedAt: new Date().toISOString() }
        await this.save({ ...this.snapshot, spaces: this.snapshot.spaces.map(item => item.id === spaceId ? updated : item) })
        return { ok: true, operation: 'updated', space: { ...updated }, projection: this.projection(scope) }
      }
      if (command === 'matrix.spaces.delete') {
        allowed(p, ['spaceId'])
        const attachments = Object.fromEntries(Object.entries(this.snapshot.attachments).map(([chat, ids]) => [chat, ids.filter(item => item !== spaceId)]).filter(([, ids]) => (ids as readonly string[]).length > 0)) as Record<string, readonly string[]>
        await this.save({ ...this.snapshot, spaces: this.snapshot.spaces.filter(item => item.id !== spaceId), entries: this.snapshot.entries.filter(item => item.spaceId !== spaceId), attachments })
        return { ok: true, operation: 'deleted', projection: this.projection(scope) }
      }
      if (command === 'matrix.entries.read') {
        allowed(p, ['spaceId', 'entryId', 'kind', 'query'])
        if (p.entryId !== undefined) {
          const entry = this.snapshot.entries.find(item => item.id === id(p.entryId) && item.spaceId === spaceId)
          return entry ? { ok: true, operation: 'read', entry: { ...entry } } : refuse('This Matrix record no longer exists.')
        }
        if (p.kind !== undefined && !kinds.includes(p.kind as MatrixEntryKind)) throw new Error('Unknown Matrix record kind.')
        const query = text(p.query ?? '', 'Search', 500, true).toLowerCase()
        return { ok: true, operation: 'read', entries: this.snapshot.entries.filter(entry => entry.spaceId === spaceId && (p.kind === undefined || p.kind === entry.kind) && `${entry.title}\n${entry.content}`.toLowerCase().includes(query)).map(entry => { const { dataBase64: _bytes, ...summary } = entry; return summary }) }
      }
      if (command === 'matrix.entries.create') {
        allowed(p, ['spaceId', 'kind', 'title', 'content', 'mimeType', 'dataBase64'])
        if (this.snapshot.entries.filter(entry => entry.spaceId === spaceId).length >= MATRIX_LIMITS.entriesPerSpace) throw new Error('This space has reached its record limit.')
        const now = new Date().toISOString()
        const entry: MatrixEntry = { ...entryFields(p), id: randomUUID(), spaceId, createdAt: now, updatedAt: now }
        await this.save({ ...this.snapshot, entries: [...this.snapshot.entries, entry] })
        return { ok: true, operation: 'created', entry: { ...entry }, projection: this.projection(scope) }
      }
      const entryId = id(p.entryId)
      const entry = this.snapshot.entries.find(item => item.id === entryId && item.spaceId === spaceId)
      if (!entry) return refuse('This Matrix record no longer exists.')
      if (command === 'matrix.entries.update') {
        allowed(p, ['spaceId', 'entryId', 'title', 'content', 'mimeType', 'dataBase64'])
        const updated = { ...entry, ...entryFields(p, entry), updatedAt: new Date().toISOString() }
        await this.save({ ...this.snapshot, entries: this.snapshot.entries.map(item => item.id === entryId ? updated : item) })
        return { ok: true, operation: 'updated', entry: { ...updated }, projection: this.projection(scope) }
      }
      allowed(p, ['spaceId', 'entryId'])
      await this.save({ ...this.snapshot, entries: this.snapshot.entries.filter(item => item.id !== entryId) })
      return { ok: true, operation: 'deleted', projection: this.projection(scope) }
    } catch (error) { return refuse(error instanceof Error ? error.message : 'The Matrix request could not be completed.') }
  }
  private async save(next: MatrixSnapshot): Promise<void> {
    try { await this.persistence!.commit(next) }
    catch (error) {
      this.fault = 'Matrix could not save changes. Previously saved data has been preserved.'
      this.onChange()
      throw error
    }
    this.snapshot = next
    this.onChange()
  }
}

/** Authenticate first, then reject malformed recovered data as a whole. */
function decodeSnapshot(raw: unknown): MatrixSnapshot {
  const value = object(raw)
  allowed(value, ['v', 'spaces', 'entries', 'attachments'])
  if (value.v !== 1 || !Array.isArray(value.spaces) || !Array.isArray(value.entries) || value.spaces.length > MATRIX_LIMITS.spaces) throw new Error('Invalid Matrix snapshot.')
  const spaces: MatrixSpace[] = value.spaces.map(rawSpace => {
    const space = object(rawSpace)
    allowed(space, ['id', 'name', 'description', 'createdAt', 'updatedAt'])
    return { id: id(space.id), name: text(space.name, 'Space name', MATRIX_LIMITS.titleChars), description: text(space.description, 'Description', MATRIX_LIMITS.descriptionChars, true), createdAt: instant(space.createdAt), updatedAt: instant(space.updatedAt) }
  })
  if (new Set(spaces.map(space => space.id)).size !== spaces.length) throw new Error('Duplicate Matrix spaces.')
  const entries: MatrixEntry[] = value.entries.map(rawEntry => {
    const entry = object(rawEntry)
    allowed(entry, ['id', 'spaceId', 'kind', 'title', 'content', 'mimeType', 'dataBase64', 'sizeBytes', 'createdAt', 'updatedAt'])
    const spaceId = id(entry.spaceId)
    if (!spaces.some(space => space.id === spaceId)) throw new Error('Orphaned Matrix record.')
    const fields = entryFields(entry)
    if (entry.sizeBytes !== fields.sizeBytes) throw new Error('Invalid Matrix file size.')
    return { ...fields, id: id(entry.id), spaceId, createdAt: instant(entry.createdAt), updatedAt: instant(entry.updatedAt) }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || spaces.some(space => entries.filter(entry => entry.spaceId === space.id).length > MATRIX_LIMITS.entriesPerSpace)) throw new Error('Invalid Matrix record collection.')
  const attachments = Object.fromEntries(Object.entries(object(value.attachments)).map(([chat, rawIds]) => {
    id(chat)
    if (!Array.isArray(rawIds) || rawIds.length > MATRIX_LIMITS.attachments) throw new Error('Invalid Matrix attachments.')
    const ids = rawIds.map(id)
    if (ids.some(spaceId => !spaces.some(space => space.id === spaceId)) || new Set(ids).size !== ids.length) throw new Error('Invalid Matrix attachment references.')
    return [chat, ids]
  }))
  return { v: 1, spaces, entries, attachments }
}
function instant(value: unknown): string {
  const result = text(value, 'Timestamp', 40)
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid Matrix timestamp.')
  return result
}
