// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { MindExecution } from '../../../core/mind/execution-state'
import type { ToolObservation } from '../../../core/mind/tools'

const ok: ToolObservation = { kind: 'ok', tool: 'measure', capability: 'cognition.request', summary: 'size is 6', sources: [] }
function state() { return new MindExecution({ taskId: 't', scopeId: 's', objective: 'Measure a component and produce a report', grantId: 'g' }) }
describe('shared Mind evidence and task decisions', () => {
  it('keeps known outstanding requirements when a model proposes premature completion', () => {
    const task = state()
    task.decide({ action: 'plan', requirements: [{ id: 'measurement', description: 'Measure the component', kind: 'observation' }, { id: 'report', description: 'Save a report', kind: 'artifact' }] })
    task.observe('measure', {}, true, ok, 'observation')
    task.decide({ action: 'satisfy', requirementId: 'measurement', evidenceIds: ['o1'] })
    expect(() => task.decide({ action: 'complete', answer: 'All done.' })).toThrow(/report/)
    expect(task.snapshot().status).toBe('running')
  })
  it('distinguishes attempted, successful and verified operations', () => {
    const task = state()
    task.decide({ action: 'plan', requirements: [{ id: 'check', description: 'Verify the size', kind: 'verification' }] })
    task.observe('measure', {}, true, { kind: 'failed', tool: 'measure', capability: 'cognition.request', reason: 'sensor offline' }, 'observation')
    expect(() => task.decide({ action: 'satisfy', requirementId: 'check', evidenceIds: ['o1'] })).toThrow()
    task.observe('search', {}, true, { ...ok, tool: 'search' }, 'snippet')
    expect(() => task.decide({ action: 'satisfy', requirementId: 'check', evidenceIds: ['o2'] })).toThrow(/verification/)
    task.observe('check', {}, true, { ...ok, tool: 'check' }, 'verification')
    task.decide({ action: 'satisfy', requirementId: 'check', evidenceIds: ['o3'] })
    task.decide({ action: 'complete', answer: 'The check returned 6.' })
    expect(task.snapshot().status).toBe('completed')
  })
  it('requires evidence to complete after acting and rejects invented references', () => {
    const task = state()
    task.observe('measure', {}, true, ok, 'observation')
    expect(() => task.decide({ action: 'complete', answer: 'Done' })).toThrow(/requirements/)
    task.decide({ action: 'plan', requirements: [{ id: 'x', description: 'Measure', kind: 'observation' }] })
    expect(() => task.decide({ action: 'satisfy', requirementId: 'x', evidenceIds: ['imaginary'] })).toThrow()
  })
  it('restores actual partial progress without granting a new budget or discarding obligations', () => {
    const task = state()
    task.decide({ action: 'plan', requirements: [{ id: 'x', description: 'Report', kind: 'artifact' }] })
    task.observe('measure', {}, true, ok, 'observation')
    task.boundary('provider call budget exhausted')
    const restored = new MindExecution({ taskId: 't', scopeId: 's', objective: 'ignored', grantId: 'g' }, task.snapshot())
    expect(restored.snapshot().status).toBe('incomplete')
    expect(restored.snapshot().requirements[0]?.satisfied).toBe(false)
    expect(restored.snapshot().observations).toHaveLength(1)
    expect(restored.snapshot().grantId).toBe('g')
  })
  it('does not accept removal or weakening of a requirement during replanning', () => {
    const task = state()
    task.decide({ action: 'plan', requirements: [{ id: 'x', description: 'Verified quantity', kind: 'verification' }] })
    expect(() => task.decide({ action: 'plan', requirements: [{ id: 'x', description: 'Guess', kind: 'answer' }] })).toThrow()
    task.decide({ action: 'plan', approach: 'Use a different sensor', requirements: [] })
    expect(task.snapshot().requirements).toHaveLength(1)
  })
})
