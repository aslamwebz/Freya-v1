import { describe, expect, it } from 'vitest'
import { MicrophoneGate } from '../../electron/microphoneGate'
import { absentVoiceProjection } from '../core/voice/fixture'
describe('host microphone gate', () => {
  it('allows standby only with both Core arming and a ready trusted detector', () => {
    const gate = new MicrophoneGate()
    const p = absentVoiceProjection({ micEnabled: true, permission: 'granted' })
    p.wake.armed = true
    gate.update(p)
    expect(gate.allowed).toBe(false)
    gate.standbyReady = true
    expect(gate.allowed).toBe(true)
    p.wake.armed = false
    expect(gate.allowed).toBe(false)
    p.wake.armed = true
    p.micEnabled = false
    expect(gate.allowed).toBe(false)
  })

  it('limits permission bootstrap and otherwise requires a Core capture', () => {
    let time = 0
    const gate = new MicrophoneGate(() => time)
    gate.update(absentVoiceProjection({ micEnabled: true, permission: 'unknown' }))
    expect(gate.allowed).toBe(false)
    gate.beginPermission()
    expect(gate.allowed).toBe(true)
    time = 10_001
    expect(gate.allowed).toBe(false)
    gate.update(absentVoiceProjection({ micEnabled: true, permission: 'granted', capturing: true }))
    expect(gate.allowed).toBe(true)
    gate.update(absentVoiceProjection({ micEnabled: true, permission: 'granted' }))
    expect(gate.allowed).toBe(false)
  })
  it('denies STOP ALL even with the microphone enabled and an unexpired bootstrap', () => {
    const gate = new MicrophoneGate(() => 0)
    gate.update(absentVoiceProjection({ micEnabled: true }))
    gate.beginPermission()
    gate.update(absentVoiceProjection({ micEnabled: true, state: 'stopped-by-STOP-ALL' }))
    expect(gate.allowed).toBe(false)
  })
})

