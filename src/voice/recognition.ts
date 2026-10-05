/**
 * Browser speech recognition: feature detection, and an honest answer.
 *
 * The brief for Phase 45 asks for this specifically — "if a safe native/browser
 * speech-recognition API is available in Electron, feature-detect and support it
 * under explicit permission" — and the honest finding is that it is **not**
 * available in this build.
 *
 * `SpeechRecognition` and its `webkit` prefix are Google's cloud recogniser
 * exposed through a browser API. Chromium in an Electron build does not ship it:
 * `webkitSpeechRecognition` is `undefined` in the renderer, and where the API does
 * exist in a browser it sends audio to a remote service. Neither is acceptable
 * here, and neither is worth pretending about.
 *
 * So this file exists to answer the question *at runtime, from the platform*,
 * rather than to claim either way:
 *
 * - `available` is read from the window, not from a constant. A future Chromium,
 *   or a different runtime, that does expose it gets a working path with no edit
 *   to Core.
 * - `remote` is detected too, and it is reported separately, because "this API
 *   exists" and "this API keeps audio on this machine" are different claims and
 *   only the second one is a reason to enable it.
 *
 * Nothing here records, buffers or transmits. It is a detector.
 */

export interface RecognitionSupport {
  /** The platform exposes a recognition API at all. */
  available: boolean
  /**
   * Whether that API is known to keep audio on this machine.
   *
   * `false` for a cloud recogniser, which is the only kind this API has ever been.
   * Freya does not enable it, so this exists so the UI can say *why* rather than
   * saying "unavailable" and leaving somebody to wonder whether they could fix it.
   */
  local: boolean
  /** In words, for a person. Never an exception message. */
  detail: string
}

/** The shape of the constructor this file looks for. Nothing is ever called. */
type RecognitionCtor = unknown

function findRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/**
 * Whether this build can transcribe locally.
 *
 * Returns a *reason*, not a boolean, and the reason is the useful part: "the
 * platform has no recognition API" and "the platform has one that would send
 * audio to a third party" are the two answers a person might be able to act on,
 * and they are different.
 */
export function detectRecognitionSupport(): RecognitionSupport {
  const ctor = findRecognitionCtor()
  if (ctor === null) {
    return {
      available: false,
      local: false,
      detail:
        'This build has no browser speech-recognition API, which is why Freya needs a configured ' +
        'speech-to-text engine before a recording can become text. Recordings are discarded rather than sent anywhere.',
    }
  }
  return {
    available: true,
    // The only implementation of this API has ever been a hosted recogniser. Marking
    // it local would be the single most dishonest line in this file.
    local: false,
    detail:
      'This platform exposes a speech-recognition API, but it is a cloud service that would send audio ' +
      'off this machine, so Freya does not enable it.',
  }
}

/**
 * Whether a recording can be transcribed on this build at all.
 *
 * The single place that decides, so a surface cannot answer "yes" by asking a
 * different question. It answers false whenever the engine would have to be
 * somewhere other than this machine, and that includes the "a browser API exists"
 * case above.
 */
export function canTranscribeLocally(): boolean {
  return detectRecognitionSupport().local
}