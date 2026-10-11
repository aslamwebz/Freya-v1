import type { ExplorerSnapshot } from './explorer'
export interface OwnerNote {
  id: string
  title: string
  content: string
  category: 'knowledge' | 'memory' | 'artifact'
  status: 'active' | 'archived' | 'deleted'
  version: number
  createdAt: string
  updatedAt: string
  links: string[]
  source: 'owner-assertion'
  verification: 'unverified'
}
export interface VaultRequest {
  operation: 'catalog' | 'read' | 'create' | 'update' | 'archive' | 'restore' | 'delete' | 'history' | 'export' | 'import' | 'relate'
  id?: string
  expectedVersion?: number
  title?: string
  content?: string
  category?: OwnerNote['category']
  links?: string[]
  items?: Pick<OwnerNote, 'id' | 'title' | 'content' | 'category' | 'links'>[]
}
export interface VaultResult {
  explorer?: ExplorerSnapshot
  note?: OwnerNote
  notes?: OwnerNote[]
  history?: OwnerNote[]
  cipherVersion: string
  imported?: number
}
