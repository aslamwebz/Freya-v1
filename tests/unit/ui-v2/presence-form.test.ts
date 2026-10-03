import { describe, expect, it } from 'vitest'
import { selectForm } from '../../../src/ui-v2/presence/form'

describe('presence form selection', () => {
  it('is always the Brain in App Mode, whatever the work', () => {
    expect(selectForm({ mode: 'app', hasWork: false })).toBe('brain')
    expect(selectForm({ mode: 'app', hasWork: true })).toBe('brain')
  })

  it('is Adult when Freya leads real work in Immersive', () => {
    expect(selectForm({ mode: 'immersive', hasWork: true })).toBe('adult')
  })

  it('is Chibi when there is no work to lead', () => {
    expect(selectForm({ mode: 'immersive', hasWork: false })).toBe('chibi')
  })
})
