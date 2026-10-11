export interface ExplorerNode {
  id: string
  name: string
  type: string
  purpose: string
  status: string
  process: string
  source: string
  updatedAt: string | null
  version: string | null
  actions: string[]
  detail?: Readonly<Record<string, unknown>>
}
export interface ExplorerEdge { id: string; from: string; to: string; kind: 'architecture' | 'activity' | 'record'; label: string }
export interface ExplorerSnapshot { generatedAt: string; source: string; nodes: ExplorerNode[]; edges: ExplorerEdge[]; limitations: string[] }
export interface SourceRequest {
  operation: 'list' | 'read' | 'write' | 'create' | 'rename' | 'delete' | 'diff' | 'validate' | 'test' | 'commit' | 'rollback' | 'search'
  path?: string
  target?: string
  content?: string
  revision?: string
  query?: string
  message?: string
}
export interface SourceResult { worktree: string; files?: string[]; content?: string; revision?: string; output?: string }
