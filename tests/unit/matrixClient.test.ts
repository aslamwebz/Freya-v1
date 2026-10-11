import { afterEach, describe, expect, it } from 'vitest'
import { createMatrixClient } from '../../src/platform/matrixClient'
import { ABSENT_MATRIX_PROJECTION } from '../../core/protocol/matrix'

afterEach(() => { delete window.freyaHost })
describe('Matrix renderer client', () => {
  it('reports a missing Core bridge and refuses local mutations', async () => {
    const client = createMatrixClient()
    expect(await client.read()).toEqual(ABSENT_MATRIX_PROJECTION)
    expect((await client.submit('matrix.spaces.create', { name: 'Unsaved' })).ok).toBe(false)
    expect(client.projection?.spaces).toEqual([])
  })
  it('publishes only committed Core results and preserves the previous view on refusal', async () => {
    const view = { health: 'ready' as const, durable: true, reason: null, spaces: [] }
    window.freyaHost = { coreSubmit: async (command: string) => command === 'matrix.spaces.read'
      ? { ok: true, matrix: { ok: true, operation: 'read', projection: view } }
      : { ok: false, matrix: { ok: false, operation: 'refused', reason: 'Disk full' } } } as never
    const client = createMatrixClient()
    await client.read()
    const outcome = await client.submit('matrix.spaces.create', { name: 'Unsaved' })
    expect(outcome.reason).toBe('Disk full')
    expect(client.projection).toEqual(view)
  })
})
