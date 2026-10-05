import { BrowserWindow, ipcMain } from 'electron'
import type {
  VoiceAdapterAvailability,
  VoiceOption,
  VoiceTtsAdapter,
} from '../core/voice/types'
import type { TtsRequest } from '../core/voice/types'

/**
 * Speech output, hosted.
 *
 * ## Why this file exists
 *
* Core decides *what* Freya says and Core decides when she stops. Core cannot make
 * a sound: there is no audio device in a Node process, and there should not be —
 * the OS speech engine belongs to the desktop platform, which is Electron's
 * renderer.
 *
 * So the adapter sits here, in the main process, as the meeting point. Core calls
 * `speak` on it; it forwards an instruction to whichever window is attached; the
 * window plays through `speechSynthesis` and reports back through Core's own
 * `voice.tts.settle` command. The promise `speak` returns resolves when Core says
 * the utterance is over, which means the *trusted* half decides when playback
 * finished rather than the window announcing it.
 *
 * ## The security properties this preserves
 *
 * - **Core supplies the words.** A window never sends text to be spoken. It
 *   receives an instruction containing text that Core already read out of the
 *   conversation store, and it plays it.
 * - **No credential crosses.** `speechSynthesis` is an operating-system facility;
*   there is no endpoint and no key, and nothing in this file has a field for one.
 *   A hosted engine would need a credential that stays here in the main process —
 *   which is exactly why `detail` says what the platform gives us and no more.
 * - **Availability is reported, never assumed.** The adapter starts
 *   `unavailable`, because until a window says it has found a speech engine this
 *   process genuinely does not know. A build where every window reports nothing
 *   ends up with a truthful `synthesis.unavailable` rather than a microphone-free
 *   lie about being able to talk.
 */

/** The wording used until a window has said what the platform actually offers. */
const DEFAULT_DETAIL =
  "The operating system's built-in speech engine, reached through the window. Audio never leaves this machine."

/** What a window is told to do. The only four things it can be told. */
export type VoiceOutputInstruction =
  | {
      kind: 'speak'
      utteranceId: string
      text: string
      voiceId: string | null
      rate: number
      pitch: number
    }
  | { kind: 'stop' }
  | { kind: 'cancel' }

export class HostVoiceOutput implements VoiceTtsAdapter {
  readonly id = 'desktop-platform-speech'
  readonly kind = 'platform' as const
  /**
   * What the window found, in its own words, once it has told us.
   *
   * A getter so the projection reflects the last report rather than the wording
   * this file was written with: "Microsoft David Desktop - English (United
   * Kingdom)" is a more useful thing to read than "the platform speech engine".
   */
  get detail(): string {
    return this.reportedDetail ?? DEFAULT_DETAIL
  }

  /**
   * Live, not captured at construction.
   *
   * A getter rather than a field because the truth arrives late: this process has
   * no way to know whether the platform offers speech until a window reports it.
   * `VoiceService` reads it on every `speakTurn`, so a window that reports nothing
   * makes every attempt fail honestly rather than silently queueing into a void.
   */
  get availability(): VoiceAdapterAvailability {
    return this.reported === true ? 'available' : 'unavailable'
  }

  private reported = false
  private knownVoices: readonly VoiceOption[] = []
  private reportedDetail: string | null = null
  private readonly windows = new Set<BrowserWindow>()
  private readonly pending = new Map<string, { resolve: (completed: boolean) => void; reject: (error: Error) => void }>()
  private readonly onAvailabilityChanged: (() => void)[] = []

  /** A window attached. Voice can only ever be heard from one. */
  add(window: BrowserWindow): () => void {
    this.windows.add(window)
    return () => {
      this.windows.delete(window)
      // A window going away takes every utterance with it. Leaving promises pending
      // would hold Core's `speaking` state open for a window that no longer exists,
      // which is the one indicator that must never outlive its cause.
      this.settleAll(false)
    }
  }

  /** Whether a window is one of ours, and so allowed to speak for the platform. */
  hasWindow(window: BrowserWindow): boolean {
    return this.windows.has(window)
  }

  /** A window reported what it found. Flips availability and refreshes the voices. */
  report(options: { available: boolean; voices?: readonly VoiceOption[]; detail?: string }): void {
    const changed = this.reported !== options.available
    this.reported = options.available
    if (options.voices !== undefined) this.knownVoices = options.voices
    if (options.detail !== undefined) this.reportedDetail = options.detail
    if (changed) for (const listener of this.onAvailabilityChanged) listener()
  }

  /** Called when the reported detail changes, so Core re-projects. */
  onDetailChanged(listener: () => void): () => void {
    this.onAvailabilityChanged.push(listener)
    return () => {
      const index = this.onAvailabilityChanged.indexOf(listener)
      if (index >= 0) this.onAvailabilityChanged.splice(index, 1)
    }
  }

  /**
   * What the window last reported about the platform's engine.
   *
   * Separate from `detail` because the projection wants one sentence and Core
   * builds it from `detail` alone. When a window names a voice ("Microsoft David
   * Desktop — English (United Kingdom)") that is genuinely more useful than
   * anything written here, so it becomes the detail.
   */
  async voices(): Promise<VoiceOption[]> {
    return [...this.knownVoices]
  }

  async speak(request: TtsRequest): Promise<{ engine: string; completed: boolean }> {
    if (this.reported !== true) {
      throw new Error('no window has reported a speech output engine')
    }
    this.broadcast({
      kind: 'speak',
      utteranceId: request.utteranceId,
      text: request.text,
      voiceId: request.voiceId,
      rate: request.rate,
      pitch: request.pitch,
    })

    return new Promise<{ engine: string; completed: boolean }>((resolve, reject) => {
      this.pending.set(request.utteranceId, {
        resolve: (completed) => resolve({ engine: this.id, completed }),
        reject,
      })
      // An abort is how `stop`, `cancel` and STOP ALL reach an utterance that is
      // already playing, and it is checked as well as signalled because a window
      // can be gone and therefore never going to answer.
      const abort = (): void => {
        if (!this.pending.has(request.utteranceId)) return
        this.pending.delete(request.utteranceId)
        reject(new Error('the utterance was cancelled'))
      }
      if (request.signal.aborted) {
        abort()
        return
      }
      request.signal.addEventListener('abort', abort, { once: true })
    })
  }

  async stop(): Promise<void> {
    this.broadcast({ kind: 'stop' })
    this.settleAll(false)
  }

  async cancel(): Promise<void> {
    this.broadcast({ kind: 'cancel' })
    this.settleAll(false)
  }

  /**
   * A window reported that an utterance is over.
   *
   * Called from Core's own `voice.tts.settle` handler rather than straight off the
   * window's message, which is what keeps Core in charge: the window says
   * "finished", Core decides what that means for the state machine, and only then
   * does the promise here resolve.
   */
  settle(utteranceId: string, completed: boolean): void {
    const entry = this.pending.get(utteranceId)
    if (entry === undefined) return
    this.pending.delete(utteranceId)
    entry.resolve(completed)
  }

  /** Anything still pending when the process is going down. Never left hanging. */
  settleAll(completed: boolean): void {
    for (const utteranceId of [...this.pending.keys()]) this.settle(utteranceId, completed)
  }

  private broadcast(instruction: VoiceOutputInstruction): void {
    for (const window of [...this.windows]) {
      if (window.isDestroyed()) {
        this.windows.delete(window)
        continue
      }
      window.webContents.send('freya:voice:output', instruction)
    }
  }
}

/**
 * Wire the two messages a window sends that are not Core commands.
 *
 * The first is capability reporting: what the platform's speech engine is, if any.
 * It arrives once at start-up and again on `voiceschanged`, and it is the only way
 * this process learns it can speak.
 *
 * The second is the voice list, so `voice.tts.voice.read` can answer from a cache
 * rather than opening a round trip to a window from inside a Core command handler.
 * A round trip there would mean Core awaiting a renderer mid-dispatch, which is the
 * shape of deadlock this codebase has avoided everywhere else.
 */
export function registerVoiceOutputIpc(output: HostVoiceOutput): void {
  ipcMain.on('freya:voice:capabilities', (event, payload: unknown) => {
    if (!isCapabilityReport(payload)) return
    // A report from a window that is not one of ours is ignored rather than
    // trusted: only an attached window may say what the platform offers.
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (sender === null || !output.hasWindow(sender)) return
    output.report({ available: payload.available, voices: payload.voices, detail: payload.detail })
  })
}

/** The closed shape a window may report. Nothing else is read. */
function isCapabilityReport(
  value: unknown,
): value is { available: boolean; voices: readonly VoiceOption[]; detail?: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.available !== 'boolean') return false
  if (!Array.isArray(record.voices)) return false
  for (const entry of record.voices) {
    if (typeof entry !== 'object' || entry === null) return false
    const voice = entry as Record<string, unknown>
    if (typeof voice.voiceId !== 'string' || voice.voiceId.length === 0) return false
    if (typeof voice.label !== 'string') return false
    if (voice.language !== null && typeof voice.language !== 'string') return false
    if (voice.isDefault !== null && typeof voice.isDefault !== 'boolean') return false
  }
  return true
}