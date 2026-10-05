import { VOICE_LIMITS, type SttRequest, type SttResult, type VoiceAdapterKind, type VoiceAdapterAvailability, type VoiceSttAdapter, type VoiceTranscriptKind } from './types'

/**
 * Speech-to-text adapters.
 *
 * Three of them ship in this file and all three are honest:
 *
 * - {@link UnavailableSttAdapter} is what a build with no engine configured
 *   uses. It refuses, it says why, and it cannot be talked into trying.
 * - {@link DeterministicSttAdapter} is the test and development stand-in. It
 *   names itself so a status line cannot present it as a real engine, and it
 *   reads nothing from the audio.
 * - {@link ScriptedSttAdapter} is the adapter tests use to exercise interim
 *   fragments, timeouts, cancellation and engine failure without mocking a
 *   promise.
 *
 * ## What is deliberately absent
 *
 * There is no HTTP adapter here. A hosted recogniser is a *host* decision: it
 * needs a credential that stays in the main process, an endpoint that goes
 * through the same provider-endpoint security discipline as a model request, and
 * a consent surface that says the audio leaves the machine. Putting that in Core
 * next to the conversation would make the *default* path a network path, and the
 * default path is the one nobody audits.
 *
 * So the seam is real and it is provider-neutral — `kind: 'provider'` is a legal
 * value of {@link VoiceAdapterKind} and the port signature fits a hosted engine
 * unchanged — but nothing in this repository constructs one. A build that wants
 * one supplies it through `CoreOptions.voiceStt`, and the projection reports
 * `kind` so the UI can warn before the first press rather than after.
 */

/** The only shape of refusal this module produces. */
export class SttUnavailableError extends Error {
  constructor(readonly availability: VoiceAdapterAvailability, message: string) {
    super(message)
    this.name = 'SttUnavailableError'
  }
}

/** Whether this error is the adapter declining rather than failing. */
export function isSttUnavailable(error: unknown): error is SttUnavailableError {
  return error instanceof SttUnavailableError
}

/**
 * An engine that is not configured.
 *
 * The default for every build in this repository. It exists so that "no speech
 * engine" is an object with a stated reason rather than an `undefined` that five
 * call sites each have to remember to check — and so the recording path can end
 * in `no-engine` with a sentence a person can read.
 */
export class UnavailableSttAdapter implements VoiceSttAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind
  readonly availability: VoiceAdapterAvailability
  readonly detail: string
  readonly streaming = false

  constructor(options: { id?: string; kind?: VoiceAdapterKind; availability?: VoiceAdapterAvailability; detail?: string } = {}) {
    this.id = options.id ?? 'no-speech-engine'
    this.kind = options.kind ?? 'local'
    this.availability = options.availability ?? 'configuration-required'
    this.detail =
      options.detail ??
      (this.availability === 'configuration-required'
        ? 'No speech-to-text engine is configured. Capture works, and recordings are discarded rather than sent anywhere.'
        : 'No speech-to-text engine is available on this platform, so Freya cannot transcribe speech.')
  }

  async transcribe(): Promise<SttResult> {
    throw new SttUnavailableError(this.availability, this.detail)
  }
}

/**
 * A stand-in that returns a fixed string.
 *
 * It exists for tests and for a development machine with no engine, and it says
 * so in its own id. It reads nothing from the audio: identical output for
 * silence and for noise, because a stand-in that responded to loudness would be
 * one more thing a test could accidentally come to depend on.
 */
export class DeterministicSttAdapter implements VoiceSttAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind = 'local'
  readonly availability: VoiceAdapterAvailability = 'available'
  readonly streaming = false
  readonly detail: string
  calls = 0

  constructor(
    private readonly text: string,
    id = 'fake-local-transcriber',
    detail = 'A deterministic stand-in for a local engine. It recognises nothing.',
  ) {
    this.id = id
    this.detail = detail
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (request.signal.aborted) throw request.signal.reason ?? new Error('the transcription was cancelled')
    this.calls += 1
    return { text: this.text, engine: this.id }
  }
}

/**
 * A scripted adapter: a fixed sequence of interim fragments, then a final.
 *
 * This is how interim-vs-final becomes a testable property rather than a comment.
 * `delayMs` per fragment exercises the timeout and cancellation paths; `failWith`
 * exercises an engine that breaks mid-capture.
 */
export class ScriptedSttAdapter implements VoiceSttAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind
  readonly availability: VoiceAdapterAvailability = 'available'
  readonly detail: string
  readonly streaming: boolean
  calls = 0

  constructor(
    private readonly plan: {
      interim?: readonly string[]
      final: string
      delayMs?: number
      failWith?: Error
      engine?: string
    },
    options: { id?: string; kind?: VoiceAdapterKind; streaming?: boolean } = {},
  ) {
    this.id = options.id ?? 'scripted-stt-adapter'
    this.kind = options.kind ?? 'local'
    this.streaming = options.streaming ?? true
    this.detail = 'A scripted engine used by tests. It recognises nothing.'
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    return this.stream(request, () => {})
  }

  async stream(
    request: SttRequest,
    onFragment: (fragment: { kind: VoiceTranscriptKind; text: string }) => void,
  ): Promise<SttResult> {
    this.calls += 1
    const delay = this.plan.delayMs ?? 0
    for (const text of this.plan.interim ?? []) {
      await waitOrAbort(request.signal, delay)
      if (request.signal.aborted) throw request.signal.reason ?? new Error('the transcription was cancelled')
      onFragment({ kind: 'interim', text })
    }
    await waitOrAbort(request.signal, delay)
    if (this.plan.failWith) throw this.plan.failWith
    if (request.signal.aborted) throw request.signal.reason ?? new Error('the transcription was cancelled')
    onFragment({ kind: 'final', text: this.plan.final })
    return { text: this.plan.final, engine: this.plan.engine ?? this.id }
  }
}

/**
 * The deadline an adapter must honour.
 *
 * A recogniser that never returns is a stuck `transcribing` indicator and a
 * microphone session that never closes, so the deadline is enforced *here* rather
 * than requested of the adapter. An adapter that ignores `signal` still cannot
 * hold the session open.
 */
export async function withTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const bounded = Math.max(1, Math.min(timeoutMs, VOICE_LIMITS.transcriptionTimeoutMs))
  const controller = new AbortController()
  const abort = (reason: unknown) => controller.abort(reason)
  if (signal.aborted) controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new SttTimeout())
      reject(new SttTimeout())
    }, bounded)
  })

  try {
    return await Promise.race([task(controller.signal), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** A distinct error, so "the engine was too slow" never reads as "the engine broke". */
export class SttTimeout extends Error {
  constructor() {
    super(`no speech engine produced a transcript within ${VOICE_LIMITS.transcriptionTimeoutMs}ms`)
    this.name = 'SttTimeout'
  }
}

/** Sleep, or reject the moment the signal fires. Never a bare `setTimeout`. */
function waitOrAbort(signal: AbortSignal, ms: number): Promise<void> {
  if (ms <= 0) {
    return signal.aborted ? Promise.reject(signal.reason ?? new Error('aborted')) : Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}