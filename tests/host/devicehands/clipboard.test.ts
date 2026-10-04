import { describe, expect, it } from 'vitest'
import { createDeviceHandsEffects } from '../../../electron/devicehands/effects'
import { browserFake, hostHarness, terminalFake, transferFake } from './harness'

describe('clipboard host adapter', () => {
  it('reads the buffer and hands the text to the boundary', async () => {
    const h = await hostHarness()
    const result = await h.effects.readClipboard({ actionId: 'a' })
    expect(result.text).toBe('harmless text')
    expect(h.counts.clipboardRead).toBe(1)
  })

  it('observes a write by reading the buffer back', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.writeClipboard({ actionId: 'a', text: 'hello' })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('observed')
    expect(h.clipboard.value).toBe('hello')
  })

  it('observes a clear by reading the buffer back empty', async () => {
    const h = await hostHarness()
    await h.effects.writeClipboard({ actionId: 'a', text: 'hello' })
    const outcome = await h.effects.clearClipboard({ actionId: 'b' })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('observed')
    expect(h.clipboard.value).toBe('')
  })

  it('reports rather than observes a write the buffer did not confirm', async () => {
    const effects = createDeviceHandsEffects({
      terminal: terminalFake(),
      // A clipboard that accepts a write and returns something else: the write is a
      // report, not an observation, and the evidence must say so.
      clipboard: { readText: () => 'something else', writeText: () => {}, clear: () => {} },
      browser: browserFake(),
      transfer: transferFake(),
    })
    const outcome = await effects.writeClipboard({ actionId: 'a', text: 'hello' })
    expect(outcome.holds).toBe(true)
    expect(outcome.evidence).toBe('reported')
  })

  it('reports a clipboard primitive that throws as not held', async () => {
    const effects = createDeviceHandsEffects({
      terminal: terminalFake(),
      clipboard: {
        readText: () => '',
        writeText: () => {
          throw new Error('clipboard unavailable')
        },
        clear: () => {},
      },
      browser: browserFake(),
      transfer: transferFake(),
    })
    const outcome = await effects.writeClipboard({ actionId: 'a', text: 'hello' })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('clipboard-write-failed')
  })

  it('never returns clipboard content from the write path', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.writeClipboard({ actionId: 'a', text: 'hello' })
    expect(Object.keys(outcome).sort()).toEqual(['code', 'evidence', 'holds'])
  })
})
