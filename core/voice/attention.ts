/**
 * Freya's conversational attention for voice.
 *
 * This is not cognition and never calls a model. It decides only whether a
 * transcribed hands-free utterance addressed Freya, belongs to an already-open
 * spoken conversation, or asks her to return to standby.
 */

export const DEFAULT_WAKE_PHRASE = 'Freya'
export const DEFAULT_FOLLOW_UP_WINDOW_MS = 45_000

export type VoiceAttentionState = 'standby' | 'attentive'

export type VoiceAddress =
  | { kind: 'ignore' }
  | { kind: 'wake-only' }
  | { kind: 'command'; text: string }
  | { kind: 'standby' }

const STANDBY = /^(?:stand\s*by|that's\s+all|that\s+is\s+all|go\s+quiet|stop\s+listening|thanks(?:\s+freya)?|thank\s+you(?:\s+freya)?)\s*[.!?]*$/i

/**
 * Interpret a final transcript without giving it authority.
 *
 * In standby, Freya's name must be at the beginning (optionally after "hey").
 * While attentive, ordinary follow-ups are accepted until the bounded window
 * expires. A name occurring in the middle of unrelated speech is ignored.
 */
export function interpretVoiceAddress(
  transcript: string,
  attentive: boolean,
  wakePhrase = DEFAULT_WAKE_PHRASE,
): VoiceAddress {
  const text = transcript.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return { kind: 'ignore' }

  const escaped = wakePhrase.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
  const addressed = new RegExp(
    `^(?:hey\\s+)?${escaped}\\b(?:\\s*[,;:—-]?\\s*)?(.*)$`,
    'i',
  ).exec(text)

  if (!attentive && addressed === null) return { kind: 'ignore' }

  const remainder = (addressed?.[1] ?? text).trim()
  if (remainder.length === 0) return { kind: 'wake-only' }
  if (STANDBY.test(remainder)) return { kind: 'standby' }
  return { kind: 'command', text: remainder }
}

export class VoiceAttentionSession {
  private attentiveUntilMs: number | null = null

  constructor(
    private readonly followUpWindowMs = DEFAULT_FOLLOW_UP_WINDOW_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get state(): VoiceAttentionState {
    return this.isAttentive() ? 'attentive' : 'standby'
  }

  get attentiveUntil(): string | null {
    if (!this.isAttentive() || this.attentiveUntilMs === null) return null
    return new Date(this.attentiveUntilMs).toISOString()
  }

  get windowMs(): number {
    return this.followUpWindowMs
  }

  activate(): void {
    this.attentiveUntilMs = this.now().getTime() + this.followUpWindowMs
  }

  touch(): void {
    if (this.isAttentive()) this.activate()
  }

  standby(): void {
    this.attentiveUntilMs = null
  }

  isAttentive(): boolean {
    if (this.attentiveUntilMs === null) return false
    if (this.now().getTime() >= this.attentiveUntilMs) {
      this.attentiveUntilMs = null
      return false
    }
    return true
  }
}

/**
 * Compatibility attention controller used by the newer hands-free runtime.
 *
 * It exposes the same bounded state as VoiceAttentionSession, but keeps the
 * runtime-configurable timeout callback used by the current desktop settings.
 */
export class VoiceAttention {
  private touchedAt: number | null = null

  constructor(
    private readonly now: () => number,
    private readonly timeout: () => number = () => DEFAULT_FOLLOW_UP_WINDOW_MS,
  ) {}

  private effectiveWindowMs(): number {
    return Math.max(5_000, Math.min(300_000, this.timeout()))
  }

  get active(): boolean {
    if (this.touchedAt === null) return false
    if (this.now() - this.touchedAt >= this.effectiveWindowMs()) this.close()
    return this.touchedAt !== null
  }

  get state(): VoiceAttentionState {
    return this.active ? 'attentive' : 'standby'
  }

  get attentiveUntil(): string | null {
    if (!this.active || this.touchedAt === null) return null
    return new Date(this.touchedAt + this.effectiveWindowMs()).toISOString()
  }

  get windowMs(): number {
    return this.effectiveWindowMs()
  }

  close(): void {
    this.touchedAt = null
  }

  standby(): void {
    this.close()
  }

  touch(): void {
    this.touchedAt = this.now()
  }

  activate(): void {
    this.touch()
  }

  isAttentive(): boolean {
    return this.active
  }

  receive(transcript: string): { kind: 'ignore' | 'wake' | 'close' | 'stop' | 'turn'; text: string } {
    const wake = /^(?:hey\s+)?freya\b[\s,.:!?-]*/i
    const addressed = wake.test(transcript.trim())
    const text = transcript.trim().replace(wake, '').trim()
    if (!addressed && !this.active) return { kind: 'ignore', text: '' }
    if (/^(?:(?:okay|ok|thank you|thanks)[,\s]+)?(?:stand\s*by|that(?:'s| is) all|go to sleep)[.!?]*$/i.test(text)) {
      this.close()
      return { kind: 'close', text: '' }
    }
    this.touch()
    if (/^(?:stop|cancel|be quiet)[.!?]*$/i.test(text)) {
      this.close()
      return { kind: 'stop', text: '' }
    }
    return { kind: text ? 'turn' : 'wake', text }
  }
}
