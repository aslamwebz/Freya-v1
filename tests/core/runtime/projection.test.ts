import { describe, expect, it } from 'vitest'
import { RuntimeActivationController, runtimeAnswers, runtimeSummary } from '../../../core/runtime'
import { descriptor, facts, makeHandler, makeJournal, requires } from './harness'

describe('the diagnostics projection', () => {
  it('answers the questions a surface actually asks', async () => {
    const active = descriptor({ id: 'core.active', activation: 'activatable' })
    const blocked = descriptor({
      id: 'core.blocked',
      activation: 'activatable',
      requirements: [requires('transport', 'a device transport')],
    })
    const failClosed = descriptor({ id: 'core.economic', activation: 'fail-closed', note: 'fail-closed' })
    const controller = new RuntimeActivationController({ journal: makeJournal() })
    controller.register([active, blocked, failClosed], [makeHandler(active.id, [])])
    const projection = await controller.load(facts())
    const answers = runtimeAnswers(projection)

    expect(answers.active).toContain('core.active')
    expect(answers.blocked.map((entry) => entry.id)).toContain('core.blocked')
    expect(answers.blocked.map((entry) => entry.id)).toContain('core.economic')
    expect(answers.blocked.find((entry) => entry.id === 'core.blocked')?.missing).toEqual([
      'a device transport',
    ])
    expect(runtimeSummary(projection)).toMatch(/active/)
  })
})
