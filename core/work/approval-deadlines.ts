export interface ApprovalDeadlineSchedulerOptions {
  readonly now: () => Date
  readonly isClosed: () => boolean
  readonly isPending: (approvalId: string) => boolean
  readonly expire: (approvalId: string, reason: string) => Promise<unknown>
}

/** Owns only the bounded timer handles for pending Work approvals. */
export class ApprovalDeadlineScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: ApprovalDeadlineSchedulerOptions) {}

  get size(): number {
    return this.timers.size
  }

  clear(approvalId: string): void {
    const timer = this.timers.get(approvalId)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(approvalId)
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  arm(approvalId: string, requestedAt: string, ttlMs: number, reason: string): void {
    this.clear(approvalId)
    if (this.options.isClosed() || !this.options.isPending(approvalId)) return

    const elapsed = Math.max(0, this.options.now().getTime() - Date.parse(requestedAt))
    const remaining = Math.max(0, ttlMs - elapsed)
    const timer = setTimeout(async () => {
      this.timers.delete(approvalId)
      if (this.options.isClosed()) return
      try {
        await this.options.expire(approvalId, reason)
      } catch {
        // Persistence failure is already owned by the Event Fabric; never print
        // the thrown diagnostic here because it may contain a local path.
        console.error('[freya.work] an approval expiry could not be persisted')
      }
    }, remaining)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.set(approvalId, timer)
  }
}
