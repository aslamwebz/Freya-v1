import type { VoiceProjection } from '../core/protocol/conversation'

/** Host permission follows Core, with a short owner-requested initial prompt. */
export class MicrophoneGate {
  private voice: VoiceProjection | null = null
  standbyReady = false
  private bootstrapUntil = 0
  constructor(private readonly now: () => number = Date.now) {}
  update(voice: VoiceProjection | null): void {
    this.voice = voice
    if (!voice?.micEnabled || voice.state === 'stopped-by-STOP-ALL' || voice.permission !== 'unknown') this.bootstrapUntil = 0
  }
  beginPermission(): void {
    if (this.voice?.micEnabled && this.voice.permission === 'unknown' && this.voice.state !== 'stopped-by-STOP-ALL') this.bootstrapUntil = this.now() + 10_000
  }
  get allowed(): boolean {
    const voice = this.voice
    return !!voice?.micEnabled && voice.state !== 'stopped-by-STOP-ALL' &&
      ((voice.permission === 'granted' && (voice.capturing || (voice.wake.armed && this.standbyReady))) || (voice.permission === 'unknown' && this.now() < this.bootstrapUntil))
  }
}
