import { clearMicLevel, publishMicLevel } from '../../presence/micLevel'

/**
 * Microphone capture.
 *
 * The one place in the renderer that touches a device, and it is deliberately
 * small and deliberately explicit:
 *
 * - it opens **only** when called, and only from a control the user pressed;
 * - it closes when the capture ends, on any path, including an error;
 * - it holds a bounded buffer and stops itself at the limit;
 * - it never uploads, never stores, and never writes audio anywhere.
 *
 * The samples go through the configured Core recognition adapter and are dropped. There is no direct code
 * path from here to a network, and no code path from here to the conversation
 * store — a recording is not a memory.
 *
 * ## Why PCM
 *
 * The wire format is 16 kHz mono signed 16-bit PCM, which is what a local
 * speech-to-text engine wants and what Core's bounds are expressed in. A
 * compressed container would need decoding somewhere, and putting a decoder in
 * the renderer to feed a local engine would be more moving parts than the phase
 * is worth.
 */

export interface CaptureLimits {
  maxDurationMs: number
  maxBytes: number
  sampleRate: number
  deviceId?: string
  signal?: AbortSignal
  standby?: boolean
  onPcm?: (audio: Uint8Array) => void
  silenceMs?: number
  onSpeechStart?: () => void
  onComplete?: (result: { audio: Uint8Array; durationMs: number; speechDetected: boolean }) => void
}

export interface MicCapture {
  promote?(): void
  /** Release the device and hand back what was captured. */
  stop(cancelled: boolean): Promise<{ audio: Uint8Array; durationMs: number }>
  /** Release the device without keeping anything. */
  abandon(): Promise<void>
}

export type MicError =
  | 'permission-denied'
  | 'no-device'
  | 'unsupported'
  | 'already-open'
  | 'capture-failed'

export class MicrophoneError extends Error {
  constructor(
    readonly reason: MicError,
    message: string,
  ) {
    super(message)
    this.name = 'MicrophoneError'
  }
}

/** Owner activation allows the initial device prompt; the probe retains no audio. */
export async function requestMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  releaseStream(stream)
}

/**
 * Ask the operating system for microphone access and release the probe
 * immediately. Core must already have opened its short-lived permission window;
 * this helper never records or retains a sample.
 */
export async function requestMicrophonePermission(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError('unsupported', 'this environment has no microphone API')
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicrophoneError('permission-denied', 'microphone permission was not granted')
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new MicrophoneError('no-device', 'no microphone was found')
    }
    throw new MicrophoneError('capture-failed', 'the microphone permission check failed')
  }
  releaseStream(stream)
}

/**
 * Open the microphone and begin capturing.
 *
 * `getUserMedia` is called here and nowhere else, which is what makes the
 * permission prompt traceable to a button press. The host grants it only while
 * Core reports a capture open, so a window cannot obtain a stream by asking.
 */
export async function openMicrophone(limits: CaptureLimits): Promise<MicCapture> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError('unsupported', 'this environment has no microphone API')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(limits.deviceId ? { deviceId: { exact: limits.deviceId } } : {}),
        channelCount: 1,
        // `ideal`, not `exact`: a device that cannot do 16k still works, and the
        // engine resamples. Demanding exactly 16k would refuse hardware that is
        // perfectly good.
        sampleRate: { ideal: limits.sampleRate },
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicrophoneError('permission-denied', 'microphone permission was not granted')
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new MicrophoneError('no-device', 'no microphone was found')
    }
    throw new MicrophoneError('capture-failed', 'the microphone could not be opened')
  }

  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    releaseStream(stream)
    throw new MicrophoneError('unsupported', 'this environment has no Web Audio support')
  }

  if (limits.signal?.aborted) { releaseStream(stream); throw new MicrophoneError('capture-failed', 'capture cancelled') }
  let cleanupContext: AudioContext | null = null
  try {
  const context = new AudioContextCtor({ sampleRate: limits.sampleRate })
  cleanupContext = context
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Int16Array[] = []
  let standby = limits.standby === true
  const preRoll: Int16Array[] = []
  let bytes = 0
  let frames = 0
  let closed = false
  let speechMs = 0
  let silenceMs = 0
  let speechDetected = false
  let result: { audio: Uint8Array; durationMs: number; speechDetected: boolean } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const sampleRate = context.sampleRate
  let startedAt = performance.now()

  /**
   * Release the device. Safe to call twice, and called on every exit path.
   *
   * A `ScriptProcessorNode` only runs while it is connected, so the muted sink
   * exists purely to keep it alive. Disconnecting is what actually stops the
   * audio graph; stopping the tracks is what actually frees the device.
   */
  async function teardown(): Promise<void> {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    limits.signal?.removeEventListener('abort', abort)
    clearMicLevel()
    try {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      sink.disconnect()
    } catch {
      /* already torn down */
    }
    releaseStream(stream)
    try {
      await context.close()
    } catch {
      /* a context that will not close must not stop us releasing the device */
    }
  }

  /** Collect what was captured, then let the device go. */
  const finish = async (
    cancelled: boolean,
  ): Promise<{ audio: Uint8Array; durationMs: number }> => {
    if (result) return result
    const durationMs = Math.min(limits.maxDurationMs, frames / limits.sampleRate * 1000)
    const collected = new Uint8Array(cancelled ? 0 : bytes)
    let offset = 0
    for (const chunk of cancelled ? [] : chunks) {
      collected.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset)
      offset += chunk.byteLength
    }
    result = { audio: collected, durationMs, speechDetected }
    chunks.length = 0
    preRoll.length = 0
    await teardown()
    // A cancelled capture returns nothing, so a release mid-sentence cannot leave
    // a partial buffer anywhere for a later phase to find.
    return result
  }

  processor.onaudioprocess = (event) => {
    if (closed) return
    const input = event.inputBuffer.getChannelData(0)
    if (!input || input.length === 0) return

    // A level for the presence, and only a level. Published through a channel
    // rather than state, so a frame of audio does not re-render React.
    let sum = 0
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i] ?? 0
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / input.length)
    const frameMs = input.length / sampleRate * 1000
    if (rms >= 0.018) { speechMs += frameMs; silenceMs = 0 }
    else { silenceMs += frameMs; if (!speechDetected) speechMs = 0 }
    if (!standby && !speechDetected && speechMs >= 120) { speechDetected = true; limits.onSpeechStart?.() }
    // A perceptual curve rather than raw RMS: a linear level makes normal speech
    // look like a whisper and a shout look like a shout.
    publishMicLevel(Math.min(1, Math.max(0, (rms - 0.01) * 6)))

    const length = Math.min(Math.floor(input.length * limits.sampleRate / sampleRate), Math.floor((limits.maxBytes - bytes) / 2))
    const pcm = new Int16Array(length)
    for (let i = 0; i < length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[Math.floor(i * sampleRate / limits.sampleRate)] ?? 0))
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    if (standby) {
      preRoll.push(pcm)
      while (preRoll.reduce((total, frame) => total + frame.length, 0) > limits.sampleRate * 1.5) preRoll.shift()
      limits.onPcm?.(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      return
    }
    chunks.push(pcm)
    bytes += pcm.byteLength
    frames += length

    // Stop at the bound rather than growing until something else notices. A
    // microphone left open for an afternoon is a bug, not a long recording.
    if (bytes >= limits.maxBytes || (frames / limits.sampleRate) * 1000 >= limits.maxDurationMs || (limits.silenceMs && ((speechDetected && silenceMs >= limits.silenceMs) || (!speechDetected && performance.now() - startedAt >= 6_000)))) {
      void finish(false).then(value => limits.onComplete?.({ ...value, speechDetected }))
    }
  }

  source.connect(processor)
  // A script processor only runs while connected to a destination. Routing it to a
  // muted gain node keeps it alive without echoing the microphone to the speakers.
  const sink = context.createGain()
  sink.gain.value = 0
  processor.connect(sink)
  sink.connect(context.destination)
  const abort = (): void => { void finish(true) }
  limits.signal?.addEventListener('abort', abort, { once: true })
  timer = setTimeout(() => { void finish(false).then(value => limits.onComplete?.({ ...value, speechDetected })) }, limits.maxDurationMs)
  if (limits.signal?.aborted) abort()

  return {
    promote: () => {
      if (closed || !standby) return
      standby = false
      for (const frame of preRoll) { chunks.push(frame); bytes += frame.byteLength; frames += frame.length }
      preRoll.length = 0
      speechMs = 0; silenceMs = 0; speechDetected = true; startedAt = performance.now()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void finish(false).then(value => limits.onComplete?.({ ...value, speechDetected })) }, Math.min(30_000, limits.maxDurationMs))
    },
    stop: finish,
    abandon: async () => {
      await finish(true)
    },
  }
  } catch (error) {
    releaseStream(stream)
    try { await cleanupContext?.close() } catch { /* already closed */ }
    throw error
  }
}

export function resampleFloat32ToInt16(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Int16Array {
  if (input.length === 0) return new Int16Array(0)
  if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new MicrophoneError('capture-failed', 'the microphone reported an invalid sample rate')
  }

  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate))
  const output = new Int16Array(outputLength)
  const ratio = sourceRate / targetRate

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const left = Math.min(input.length - 1, Math.floor(position))
    const right = Math.min(input.length - 1, left + 1)
    const fraction = position - left
    const sample = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction
    const bounded = Math.max(-1, Math.min(1, sample))
    output[index] = bounded < 0 ? Math.round(bounded * 0x8000) : Math.round(bounded * 0x7fff)
  }
  return output
}

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* a track that will not stop is not worth failing a release over */
    }
  }
}
