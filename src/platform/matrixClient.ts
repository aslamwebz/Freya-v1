import {
  ABSENT_MATRIX_PROJECTION, type MatrixCommandName, type MatrixCommandOutcome,
  type MatrixEntry, type MatrixEntryKind, type MatrixProjection,
} from '../../core/protocol/matrix'
import { hostBridge } from './host'

export interface MatrixClient {
  readonly projection: MatrixProjection | null
  subscribe(listener: (projection: MatrixProjection | null) => void): () => void
  read(): Promise<MatrixProjection>
  readAttachments(conversationId: string): Promise<MatrixCommandOutcome>
  submit(command: MatrixCommandName, payload: unknown): Promise<MatrixCommandOutcome>
  readEntries(spaceId: string, options?: { kind?: MatrixEntryKind; query?: string }): Promise<MatrixCommandOutcome>
  readEntry(spaceId: string, entryId: string): Promise<MatrixEntry | null>
  attachSpaces(conversationId: string, spaceIds: readonly string[]): Promise<MatrixCommandOutcome>
}
let shared: MatrixClient | null = null
export function matrixClient(): MatrixClient { return shared ??= createMatrixClient() }
export function resetMatrixClient(): void { shared = null }

/** The renderer holds Core's committed answers; it never saves private state locally. */
export function createMatrixClient(): MatrixClient {
  let current: MatrixProjection | null = null
  const listeners = new Set<(projection: MatrixProjection | null) => void>()
  const publish = (view: MatrixProjection): void => { current = view; for (const listener of listeners) listener(view) }
  const submit = async (command: MatrixCommandName, payload: unknown): Promise<MatrixCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge?.coreSubmit) return { ok: false, operation: 'refused', reason: ABSENT_MATRIX_PROJECTION.reason! }
    try {
      const envelope = await bridge.coreSubmit(command as never, payload)
      const result = (envelope as typeof envelope & { matrix?: MatrixCommandOutcome }).matrix
      if (!result) return { ok: false, operation: 'refused', reason: envelope.refusal?.reason ?? envelope.error?.message ?? 'Core did not answer the Matrix request.' }
      if (result.projection) publish(result.projection)
      return result
    } catch (error) { return { ok: false, operation: 'refused', reason: error instanceof Error ? error.message : 'Freya Core could not be reached.' } }
  }
  return {
    get projection() { return current },
    subscribe(listener) { listeners.add(listener); listener(current); return () => { listeners.delete(listener) } },
    async read() {
      const result = await submit('matrix.spaces.read', {})
      if (result.projection) return result.projection
      const absent = { ...ABSENT_MATRIX_PROJECTION, reason: result.reason ?? ABSENT_MATRIX_PROJECTION.reason }
      publish(absent)
      return absent
    },
    submit,
    readAttachments(conversationId) { return submit('matrix.spaces.read', { conversationId }) },
    readEntries(spaceId, options = {}) { return submit('matrix.entries.read', { spaceId, ...options }) },
    async readEntry(spaceId, entryId) { return (await submit('matrix.entries.read', { spaceId, entryId })).entry ?? null },
    attachSpaces(conversationId, spaceIds) { return submit('matrix.spaces.attach', { conversationId, spaceIds: [...spaceIds] }) },
  }
}
