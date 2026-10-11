/** Owner-managed spaces. Bodies are returned only by explicit Matrix reads. */
export const MATRIX_COMMANDS = [
  'matrix.spaces.read', 'matrix.spaces.create', 'matrix.spaces.update', 'matrix.spaces.delete', 'matrix.spaces.attach',
  'matrix.entries.read', 'matrix.entries.create', 'matrix.entries.update', 'matrix.entries.delete',
] as const
export type MatrixCommandName = typeof MATRIX_COMMANDS[number]
export type MatrixEntryKind = 'knowledge' | 'person' | 'file'
export interface MatrixSpace {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: string
  readonly updatedAt: string
}
export interface MatrixEntry {
  readonly id: string
  readonly spaceId: string
  readonly kind: MatrixEntryKind
  readonly title: string
  readonly content: string
  readonly mimeType?: string
  readonly dataBase64?: string
  readonly sizeBytes?: number
  readonly createdAt: string
  readonly updatedAt: string
}
export interface MatrixSpaceView extends MatrixSpace {
  readonly counts: Readonly<Record<MatrixEntryKind, number>>
}
export interface MatrixProjection {
  readonly health: 'ready' | 'unavailable' | 'degraded'
  readonly durable: boolean
  readonly reason: string | null
  readonly spaces: readonly MatrixSpaceView[]
}
export interface MatrixCommandOutcome {
  readonly ok: boolean
  readonly operation: 'read' | 'created' | 'updated' | 'deleted' | 'attached' | 'refused'
  readonly reason?: string
  readonly projection?: MatrixProjection
  readonly space?: MatrixSpace
  readonly entry?: MatrixEntry
  /** Lists include descriptions and byte counts, never file payloads. */
  readonly entries?: readonly MatrixEntry[]
  readonly attachedSpaceIds?: readonly string[]
}
export const ABSENT_MATRIX_PROJECTION: MatrixProjection = Object.freeze({
  health: 'unavailable', durable: false, reason: 'Matrix is not connected to Freya Core.', spaces: Object.freeze([]),
})
export const MATRIX_LIMITS = Object.freeze({
  spaces: 128, entriesPerSpace: 512, attachments: 8, titleChars: 160, descriptionChars: 2_000,
  contentChars: 32_000, fileBytes: 1_000_000, snapshotBytes: 64_000_000,
})
