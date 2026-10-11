import { randomUUID } from 'node:crypto'
import type { OwnerNote, VaultRequest, VaultResult } from '../../shared/contracts/vault-explorer'
import type { Vault } from './vault'
import type { ExplorerSnapshot } from '../../shared/contracts/explorer'

const DOMAIN = 'owner-notes', HISTORY = 'owner-notes-history'
const OPS = ['catalog', 'read', 'create', 'update', 'archive', 'restore', 'delete', 'history', 'export', 'import', 'relate']
const FIELDS = ['operation', 'id', 'expectedVersion', 'title', 'content', 'category', 'links', 'items']
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
export function validateVaultRequest(value: unknown): asserts value is VaultRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vault request is missing')
  const request = value as VaultRequest
  if (!OPS.includes(request.operation) || Object.keys(value).some(key => !FIELDS.includes(key))) throw new Error('Unknown Vault operation or field')
  if (request.id !== undefined && !idValid(request.id)) throw new Error('Invalid record id')
  if (request.expectedVersion !== undefined && (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1)) throw new Error('Invalid record version')
  if (request.title !== undefined && (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 160)) throw new Error('Title must contain 1–160 characters')
  if (request.content !== undefined && (typeof request.content !== 'string' || request.content.length > 16000)) throw new Error('Content exceeds 16000 characters')
  if (request.category !== undefined && !['knowledge', 'memory', 'artifact'].includes(request.category)) throw new Error('Unknown owner record category')
  if (request.links !== undefined && (!Array.isArray(request.links) || request.links.length > 32 || request.links.some(id => !idValid(id)))) throw new Error('Invalid record links')
  if (request.items !== undefined) {
    if (!Array.isArray(request.items) || request.items.length > 100) throw new Error('Import supports up to 100 owner records')
    for (const item of request.items) {
      if (!item || !idValid(item.id) || Object.keys(item).some(key => !['id', 'title', 'content', 'category', 'links'].includes(key))) throw new Error('Import contains unsupported fields')
      validateVaultRequest({ operation: 'create', title: item.title, content: item.content, category: item.category, links: item.links })
      if (!item.title || typeof item.content !== 'string' || !item.category) throw new Error('Import record content is missing')
    }
    if (new Set(request.items.map(item => item.id)).size !== request.items.length) throw new Error('Import contains duplicate ids')
  }
}

/** Narrow owner records on the existing SQLCipher store. No schema change, SQL input or key output. */
export class VaultExplorer {
  constructor(private readonly vault: Vault) {}
  private notes(): OwnerNote[] { return this.vault.all<{ body: string }>('SELECT body FROM vault_kv WHERE domain = ? ORDER BY key LIMIT 1001', [DOMAIN]).map(row => this.decode(row.body)) }
  private decode(body: string): OwnerNote {
    const note = JSON.parse(body) as OwnerNote
    if (!idValid(note.id) || !Number.isSafeInteger(note.version) || note.version < 1 || note.source !== 'owner-assertion' || note.verification !== 'unverified' || !['active', 'archived', 'deleted'].includes(note.status)) throw new Error('Owner record integrity check failed')
    validateVaultRequest({ operation: 'create', title: note.title, content: note.content, category: note.category, links: note.links })
    return note
  }
  private get(id: string | undefined): OwnerNote {
    if (!idValid(id)) throw new Error('Record id is required')
    const row = this.vault.get<{ body: string }>('SELECT body FROM vault_kv WHERE domain = ? AND key = ?', [DOMAIN, id])
    if (!row) throw new Error('Owner record does not exist. System facts and histories cannot be rewritten here.')
    return this.decode(row.body)
  }
  private put(note: OwnerNote): void {
    this.vault.run('INSERT INTO vault_kv(domain,key,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at', [DOMAIN, note.id, JSON.stringify(note), note.updatedAt])
    this.vault.run('INSERT INTO vault_kv(domain,key,body,updated_at) VALUES(?,?,?,?)', [HISTORY, `${note.id}:${note.version}`, JSON.stringify(note), note.updatedAt])
  }
  catalog(): ExplorerSnapshot {
    const notes = this.notes()
    const nodes: ExplorerSnapshot['nodes'] = notes.slice(0, 1000).map(({ content, ...note }) => ({ id: `note:${note.id}`, name: note.title, type: `owner ${note.category}`, purpose: `Owner assertion · ${content.length} characters · ${note.verification}`, status: note.status, process: 'Core', source: 'SQLCipher Vault · owner-notes', updatedAt: note.updatedAt, version: String(note.version), actions: ['note'], detail: { ...note, contentLength: content.length } }))
    const known = new Set(nodes.map(node => node.id))
    const edges: ExplorerSnapshot['edges'] = notes.flatMap(note => note.links.filter(id => known.has(`note:${id}`)).map(id => ({ id: `${note.id}:${id}`, from: `note:${note.id}`, to: `note:${id}`, kind: 'record', label: 'owner linked record' })))
    return { source: 'Authenticated Core · canonical encrypted SQLCipher Vault', generatedAt: new Date().toISOString(), nodes, edges, limitations: [notes.length > 1000 ? 'Catalogue limited to 1000 owner notes.' : 'Owner notes are unverified assertions. They never grant authority or rewrite Freya’s identity.', 'Immutable records retain their original history. Archive/restore/delete apply only to owner-managed notes.'] }
  }
  execute(value: unknown): VaultResult {
    validateVaultRequest(value)
    const request = value
    const base = { cipherVersion: this.vault.health().cipherVersion }
    if (request.operation === 'catalog') return { ...base, explorer: this.catalog() }
    if (request.operation === 'read') return { ...base, note: this.get(request.id) }
    if (request.operation === 'history') {
      if (!idValid(request.id)) throw new Error('Record id is required')
      const prefix = `${request.id}:`
      return { ...base, history: this.vault.all<{ body: string }>('SELECT body FROM vault_kv WHERE domain = ? AND substr(key, 1, ?) = ? ORDER BY updated_at DESC LIMIT 100', [HISTORY, prefix.length, prefix]).map(row => this.decode(row.body)).sort((a, b) => a.version - b.version) }
    }
    if (request.operation === 'export') return { ...base, notes: this.notes().slice(0, 1000) }
    return this.vault.transaction(() => {
      if (request.operation === 'create') {
        if (!request.title || request.content === undefined || !request.category) throw new Error('Title, content and category are required')
        if (this.notes().length >= 1000) throw new Error('Owner notes retention limit reached')
        const now = new Date().toISOString()
        const note: OwnerNote = { id: randomUUID(), title: request.title, content: request.content, category: request.category, links: request.links ?? [], createdAt: now, updatedAt: now, status: 'active', version: 1, source: 'owner-assertion', verification: 'unverified' }
        for (const id of note.links) this.get(id)
        this.put(note); return { ...base, note }
      }
      if (request.operation === 'import') {
        const items = request.items
        if (!items || this.notes().length + items.length > 1000) throw new Error('Import requires records within the retention limit')
        const ids = new Map(items.map(item => [item.id, randomUUID()]))
        for (const item of items) if (item.links.some(id => !ids.has(id))) throw new Error('Import links must refer to another imported owner record')
        const now = new Date().toISOString()
        for (const item of items) this.put({ ...item, id: ids.get(item.id)!, links: item.links.map(id => ids.get(id)!), createdAt: now, updatedAt: now, status: 'active', version: 1, source: 'owner-assertion', verification: 'unverified' })
        return { ...base, imported: items.length }
      }
      const note = this.get(request.id)
      if (note.version !== request.expectedVersion) throw new Error('Record version changed. Reload before writing.')
      if (request.operation === 'delete') {
        if (this.notes().some(other => other.id !== note.id && other.links.includes(note.id))) throw new Error('Remove incoming owner-note relationships before deleting this record')
        this.vault.run('DELETE FROM vault_kv WHERE domain = ? AND key = ?', [DOMAIN, note.id])
        const tombstone = { ...note, status: 'deleted', version: note.version + 1, updatedAt: new Date().toISOString() }
        this.vault.run('INSERT INTO vault_kv(domain,key,body,updated_at) VALUES(?,?,?,?)', [HISTORY, `${note.id}:${tombstone.version}`, JSON.stringify(tombstone), tombstone.updatedAt])
        return base
      }
      const next = { ...note, version: note.version + 1, updatedAt: new Date().toISOString() }
      if (request.operation === 'archive') next.status = 'archived'
      else if (request.operation === 'restore') next.status = 'active'
      else if (request.operation === 'update') {
        if (request.title !== undefined) next.title = request.title
        if (request.content !== undefined) next.content = request.content
        if (request.category !== undefined) next.category = request.category
      } else if (request.operation === 'relate') {
        if (!request.links) throw new Error('Relationship list is required')
        for (const id of request.links) { if (id === note.id) throw new Error('Self relationships are not supported'); this.get(id) }
        next.links = [...new Set(request.links)]
      }
      this.put(next); return { ...base, note: next }
    })
  }
}
