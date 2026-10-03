import { describe, expect, it } from 'vitest'
import { brainState } from '../../../src/ui-v2/presence/state'

describe('brain state', () => {
  it('idle Core is calm', () => {
    expect(brainState({ activeRequests: 0, working: 0, faultCount: 0, lifecycle: 'ready' })).toBe('calm')
  })
  it('active requests are thinking', () => {
    expect(brainState({ activeRequests: 2, working: 0, faultCount: 0, lifecycle: 'ready' })).toBe('thinking')
  })
  it('many concurrent requests are load', () => {
    expect(brainState({ activeRequests: 3, working: 0, faultCount: 0, lifecycle: 'ready' })).toBe('load')
  })
  it('working workers are delegating', () => {
    expect(brainState({ activeRequests: 0, working: 3, faultCount: 0, lifecycle: 'ready' })).toBe('delegating')
  })
  it('faults are uncertainty', () => {
    expect(brainState({ activeRequests: 0, working: 0, faultCount: 1, lifecycle: 'ready' })).toBe('uncertainty')
  })
  it('a degraded lifecycle is uncertainty even when idle', () => {
    expect(brainState({ activeRequests: 0, working: 0, faultCount: 0, lifecycle: 'degraded' })).toBe('uncertainty')
  })
})
