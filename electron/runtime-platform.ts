import { randomUUID } from 'node:crypto'
import type { RpcPeer } from '../shared/runtime/rpc'
import type { CoreHostOptions, ElectronCoreHost } from './coreHost'
type VoiceSttAdapter = NonNullable<CoreHostOptions['voiceStt']>
type VoiceTtsAdapter = NonNullable<CoreHostOptions['voiceTts']>
type VoiceAdapterDescriptor = Pick<VoiceTtsAdapter, 'id' | 'kind' | 'availability' | 'detail'>
type BrowserTaskPort = Parameters<ElectronCoreHost['attachDualBrowser']>[0]
type BrowserTabsPort = Parameters<ElectronCoreHost['attachBrowserTabs']>[0]
import type { DeviceHandsEffects } from './devicehands'
type WindowProvider = NonNullable<CoreHostOptions['windowObservation']>['provider']
type WindowReading = ReturnType<WindowProvider['read']>

/** Core calls admitted effects on the currently connected desktop; never replays them. */
export class RuntimePlatform {
  private peer: RpcPeer | null = null
  private descriptors: { stt?: VoiceAdapterDescriptor; tts?: VoiceAdapterDescriptor; window?: WindowReading } = {}
  connect(peer: RpcPeer, value: unknown): void {
    const changed = this.peer !== peer
    this.peer = peer
    this.descriptors = value as typeof this.descriptors
    if (changed) peer.onClose(() => { if (this.peer === peer) { this.peer = null; this.descriptors = {} } })
  }
  private descriptor(kind: 'stt' | 'tts'): VoiceAdapterDescriptor {
    return this.peer?.connected && this.descriptors[kind] || { id: 'superapp-disconnected', kind: 'platform', availability: 'unavailable', detail: 'The desktop speech adapter is disconnected.' }
  }
  private call<T>(method: string, value?: unknown): Promise<T> {
    if (!this.peer?.connected) return Promise.reject(new Error('Superapp is disconnected; the effect was not executed'))
    return this.peer.call<T>(method, value)
  }
  private async cancellable<T>(method: string, value: unknown, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error('The effect was cancelled before execution')
    const id = randomUUID(), peer = this.peer
    const cancel = () => { void peer?.call('effect.cancel', { id }, 5_000).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try { return await this.call<T>(method, { id, request: value }) }
    finally { signal.removeEventListener('abort', cancel) }
  }
  readonly stt: VoiceSttAdapter = (() => {
    const descriptor = () => this.descriptor('stt')
    return {
    get id() { return descriptor().id },
    get kind() { return descriptor().kind },
    get availability() { return descriptor().availability },
    get detail() { return descriptor().detail },
    streaming: false,
    transcribe: request => this.cancellable('voice.transcribe', { ...request, signal: undefined, audio: { ...request.audio, bytes: Buffer.from(request.audio.bytes).toString('base64') } }, request.signal),
    }
  })()
  readonly tts: VoiceTtsAdapter = (() => {
    const descriptor = () => this.descriptor('tts')
    return {
    get id() { return descriptor().id },
    get kind() { return descriptor().kind },
    get availability() { return descriptor().availability },
    get detail() { return descriptor().detail },
    voices: () => this.call('voice.voices'),
    speak: request => this.cancellable('voice.speak', { ...request, signal: undefined }, request.signal),
    stop: () => this.cancelPlayback('voice.stop'), cancel: () => this.cancelPlayback('voice.cancel'),
    }
  })()
  readonly browser: BrowserTaskPort = { execute: request => this.call('browser.execute', request) }
  private async cancelPlayback(method: 'voice.stop' | 'voice.cancel'): Promise<void> {
    const peer = this.peer
    if (!peer?.connected) return // The desktop already cancels playback when its channel closes.
    try { await peer.call(method) }
    catch { if (peer.connected) console.error('[core] the desktop could not confirm speech cancellation') }
  }
  readonly tabs: BrowserTabsPort = { run: request => this.call('browser.tabs', request) }
  readonly window: WindowProvider = {
    providerId: 'freya-own-window', reach: 'own-app', availability: () => this.peer?.connected ? 'ready' : 'unavailable',
    read: () => this.peer?.connected && this.descriptors.window || { availability: 'unavailable', window: null, reason: 'Superapp window observation is disconnected.' },
  }
  readonly hands: DeviceHandsEffects = {
    probeSurface: request => this.call('hands.probeSurface', request),
    performBrowser: request => this.call('hands.performBrowser', request),
    runTerminal: request => this.call('hands.runTerminal', request),
    readClipboard: request => this.call('hands.readClipboard', request),
    writeClipboard: request => this.call('hands.writeClipboard', request),
    clearClipboard: request => this.call('hands.clearClipboard', request),
    fetchDownload: request => this.call('hands.fetchDownload', request),
    sendUpload: request => this.call('hands.sendUpload', request),
    onChange: () => {},
  }
}
