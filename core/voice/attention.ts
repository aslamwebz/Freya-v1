/** Attention is conversation policy, independent of the recognition engine. */
export class VoiceAttention {
  private touchedAt: number | null = null
  constructor(private readonly now: () => number, private readonly timeout: () => number = () => 60_000) {}

  get active(): boolean {
    if (this.touchedAt === null) return false
    if (this.now() - this.touchedAt >= Math.max(5_000, Math.min(300_000, this.timeout()))) this.close()
    return this.touchedAt !== null
  }
  close(): void { this.touchedAt = null }
  touch(): void { this.touchedAt = this.now() }

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
    if (/^(?:stop|cancel|be quiet)[.!?]*$/i.test(text)) { this.close(); return { kind: 'stop', text: '' } }
    return { kind: text ? 'turn' : 'wake', text }
  }
}

