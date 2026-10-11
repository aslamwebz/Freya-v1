import type { CoreHostOptions } from './coreHost'
import type { DeviceHandsEffects } from './devicehands'

export interface DesktopEffects {
  stt: NonNullable<CoreHostOptions['voiceStt']>
  tts: NonNullable<CoreHostOptions['voiceTts']>
  hands: DeviceHandsEffects
  window?: NonNullable<CoreHostOptions['windowObservation']>['provider']
}

/** Only a connected Core can request these already-admitted physical effects. */
export class ProcessEffects {
  private readonly active = new Map<string, AbortController>()
  constructor(private readonly ports: DesktopEffects) {}
  descriptors() {
    const descriptor = (port: DesktopEffects['stt'] | DesktopEffects['tts']) => ({ id: port.id, kind: port.kind, availability: port.availability, detail: port.detail })
    return { stt: descriptor(this.ports.stt), tts: descriptor(this.ports.tts), window: this.ports.window?.read(new Date()) }
  }
  disconnected(): void { for (const controller of this.active.values()) controller.abort(); this.active.clear(); void this.ports.tts.cancel().catch(() => {}) }
  async handle(method: string, value: unknown): Promise<unknown> {
    const { hands, stt, tts } = this.ports
    if (method === 'effect.cancel') { this.active.get((value as { id: string }).id)?.abort(); return true }
    if (method === 'voice.voices') return tts.voices()
    if (method === 'voice.stop') return tts.stop()
    if (method === 'voice.cancel') return tts.cancel()
    if (method === 'voice.transcribe' || method === 'voice.speak') {
      const { id, request } = value as { id: string; request: Record<string, unknown> }
      if (this.active.has(id)) throw new Error('Duplicate effect request')
      const controller = new AbortController(); this.active.set(id, controller)
      try {
        if (method === 'voice.speak') return await tts.speak({ ...request, signal: controller.signal } as Parameters<typeof tts.speak>[0])
        const audio = request.audio as Omit<Parameters<typeof stt.transcribe>[0]['audio'], 'bytes'> & { bytes: string }
        if (typeof audio.bytes !== 'string' || audio.bytes.length > 6 * 1024 * 1024) throw new Error('Audio exceeded its existing capture limit')
        const bytes = Buffer.from(audio.bytes, 'base64')
        if (bytes.length > 4 * 1024 * 1024) throw new Error('Audio exceeded its existing capture limit')
        return await stt.transcribe({ ...request, sessionId: request.sessionId as string, timeoutMs: request.timeoutMs as number, audio: { ...audio, bytes }, signal: controller.signal } as Parameters<typeof stt.transcribe>[0])
      } finally { this.active.delete(id) }
    }
    switch (method) {
      case 'hands.probeSurface': return hands.probeSurface(value as Parameters<typeof hands.probeSurface>[0])
      case 'hands.performBrowser': return hands.performBrowser(value as Parameters<typeof hands.performBrowser>[0])
      case 'hands.runTerminal': return hands.runTerminal(value as Parameters<typeof hands.runTerminal>[0])
      case 'hands.readClipboard': return hands.readClipboard(value as Parameters<typeof hands.readClipboard>[0])
      case 'hands.writeClipboard': return hands.writeClipboard(value as Parameters<typeof hands.writeClipboard>[0])
      case 'hands.clearClipboard': return hands.clearClipboard(value as Parameters<typeof hands.clearClipboard>[0])
      case 'hands.fetchDownload': return hands.fetchDownload(value as Parameters<typeof hands.fetchDownload>[0])
      case 'hands.sendUpload': return hands.sendUpload(value as Parameters<typeof hands.sendUpload>[0])
      default: throw new Error('operation unavailable in Superapp')
    }
  }
}
