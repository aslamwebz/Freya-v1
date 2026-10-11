export const VOICE_EVENT_TYPES = [
// Voice — metadata only. Audio never reaches this file, and neither does a
  // transcript: an interim fragment is not even offered to the journal, and a
  // final one is recorded as a length and a turn reference.
  'voice.capture.started',
'voice.capture.completed',
'voice.capture.cancelled',
'voice.transcribe.started',
'voice.transcribe.completed',
'voice.transcribe.failed',
'voice.submitted',
'voice.speech.started',
'voice.speech.stopped',
'voice.speech.interrupted',
'voice.permission.changed',
'voice.wake.armed',
'voice.wake.fired',
'voice.wake.disarmed',
'voice.stopped',
] as const
export interface VoiceEventPayloads {
/* --------------------------------------------------------------- voice */

  'voice.capture.started': {
    sessionId: string
    /** Chosen before any audio exists, so this is a format not a measurement. */
    format: string
    sampleRate: number
    channels: number
    /**
     * How this session opened.
     *
     * `explicit` means a person pressed something. `wake` means a local
     * speech-activity gate asked — which is recorded separately precisely so an
     * operator can tell a hands-free capture from a deliberate one without the
     * audio either way.
     */
    activation: 'explicit' | 'wake'
  }

'voice.capture.completed': {
    sessionId: string
    /** Bytes of audio handled and then discarded. Never the audio itself. */
    byteLength: number
    durationMs: number
    /** Sample frames. A second ceiling, because metadata is attacker-controlled. */
    frames: number
    /** Whether an engine produced a transcript. Never implies a model call. */
    transcribed: boolean
    transcriptLength: number
    /** How many times the engine revised its guess. A count, never the guesses. */
    interimFragments: number
  }

'voice.capture.cancelled': {
    sessionId: string
    byteLength: number
    durationMs: number
    reason: string
  }

'voice.transcribe.started': {
    sessionId: string
    /** A named engine, or a stand-in that names itself as one. Never a credential. */
    engine: string
    /** Where the engine runs: this machine, the OS, or a configured provider. */
    kind: string
    frames: number
  }

'voice.transcribe.completed': {
    sessionId: string
    engine: string
    transcriptLength: number
    interimFragments: number
  }

'voice.transcribe.failed': {
    sessionId: string
    engine: string
    /** A closed vocabulary of *causes*, never an engine's error text. */
    reason: 'timeout' | 'unconfigured' | 'engine-failed'
  }

/**
   * A confirmed transcript entered the canonical conversation path.
   *
   * `turnId` is the reference that makes this auditable without being a
   * transcript: an operator can follow it to the turn event and see what the
   * Mind, the Governor and the provider each did. The words themselves live in
   * the encrypted conversation store and are not here.
   */
  'voice.submitted': {
    sessionId: string
    turnId: string
    outcome: string
    transcriptLength: number
  }

'voice.speech.started': {
    utteranceId: string
    /** Which stored turn is being read. Freya never says anything she did not write. */
    turnId: string
    characters: number
    voice: 'default' | 'selected'
    queued: number
  }

'voice.speech.stopped': { utteranceId: string; turnId: string; completed: boolean }

'voice.speech.interrupted': { utteranceId: string; turnId: string; reason: string }

'voice.permission.changed': {
    /** Which capability the owner was asked about. One category today. */
    category: 'microphone'
    outcome: 'granted' | 'denied' | 'revoked'
    source: 'idle' | 'capturing'
  }

'voice.wake.armed': { gate: string; threshold: number; maxArmedMs: number }

'voice.wake.fired': { gate: string; sustainedMs: number }

'voice.wake.disarmed': { gate: string; reason: string }

/** STOP ALL reached the voice subsystem. The only `scope` is `all`, today. */
  'voice.stopped': { scope: 'all'; reason: string }
}