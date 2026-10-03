import { describe, expect, it } from 'vitest'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'

describe('provider resource', () => {
  it('preview labels the provider as sample data', () => {
    const snap = createPreviewAdapter().getSnapshot()
    expect(snap.provider.status).toBe('ready')
    if (snap.provider.status === 'ready') expect(snap.provider.data.detail).toContain('preview')
  })
})
