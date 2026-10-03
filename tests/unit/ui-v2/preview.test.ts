import { describe, expect, it } from 'vitest'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
describe('UI design preview', () => {
  it('marks every resource as sample data and keeps its presentation snapshot immutable', () => {
    const adapter = createPreviewAdapter()
    const state = adapter.getSnapshot()
    for (const resource of Object.values(state)) {
      expect(resource.status).toBe('ready')
      if (resource.status === 'ready') expect(resource.source).toBe('preview')
    }
    expect(adapter.getSnapshot()).toBe(state)
    expect(Object.isFrozen(state)).toBe(true)
    if (state.mission.status === 'ready') {
      expect(Object.isFrozen(state.mission.data.rows[0])).toBe(true)
    }
    expect('submitCommand' in adapter).toBe(false)
  })
})
