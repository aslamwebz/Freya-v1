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
 * The samples go to a local engine inside Core and are dropped. There is no code
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
}

export interface MicCapture {
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

  const context = new AudioContextCtor()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Int16Array[] = []
  let bytes = 0
  let frames = 0
  let closed = false

  const sampleRate = context.sampleRate
  const startedAt = performance.now()

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
    const durationMs = performance.now() - startedAt
    const collected = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      collected.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset)
      offset += chunk.byteLength
    }
    await teardown()
    // A cancelled capture returns nothing, so a release mid-sentence cannot leave
    // a partial buffer anywhere for a later phase to find.
    return { audio: cancelled ? new Uint8Array(0) : collected, durationMs }
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
    // A perceptual curve rather than raw RMS: a linear level makes normal speech
    // look like a whisper and a shout look like a shout.
    publishMicLevel(Math.min(1, Math.max(0, (rms - 0.01) * 6)))

    const pcm = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    chunks.push(pcm)
    bytes += pcm.byteLength
    frames += input.length

    // Stop at the bound rather than growing until something else notices. A
    // microphone left open for an afternoon is a bug, not a long recording.
    if (bytes >= limits.maxBytes || (frames / sampleRate) * 1000 >= limits.maxDurationMs) {
      void finish(false)
    }
  }

  source.connect(processor)
  // A script processor only runs while connected to a destination. Routing it to a
  // muted gain node keeps it alive without echoing the microphone to the speakers.
  const sink = context.createGain()
  sink.gain.value = 0
  processor.connect(sink)
  sink.connect(context.destination)

  return {
    stop: finish,
    abandon: async () => {
      await finish(true)
    },
  }
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
