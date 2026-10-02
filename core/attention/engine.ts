/**
 * THE ATTENTION ENGINE — authorized ingest, deterministic decisions, bounded wake.
 *
 * This is the only code that turns an event into a decision, and it is written so
 * that the properties the phase claims are structural rather than remembered:
 *
 *   - **The source is never taken from a payload.** `ingestFromPayload` fixes it to
 *     the source its caller passed; the command layer passes `owner`, and an
 *     internal subsystem passes its own closed id. A window cannot claim `system`.
 *   - **Every decision is a journal append.** There is no in-memory decision that
 *     is not also an `attention.decision.made` line, so budgets and cooldowns
 *     survive a restart without a second store.
 *   - **No decision reaches cognition.** This file imports no gateway, no
 *     authority and no provider. An attention outcome is a label; it spends
 *     nothing, mints nothing and clears nothing.
 *   - **STOP ALL is read fresh, per decision.** A stopped Core does not shout
 *     louder; the policy returns `do-nothing` with reason `stop-all`.
 *   - **Dedupe happens before anything is appended.** A re-delivered event is
 *     recognised by a stable key and produces no new journal line and no second
 *     decision, so a replay storm cannot amplify.
 *   - **The wake is explicit and bounded.** `tick()` evaluates only schedules that
 *     are already due, and only through a condition checked against
 *     already-authorized state. There is no timer in this file.
 *
 * ## Text is process-local
 *
 * An event's text is held in `inbox` for the life of the process and is never
 * written to the journal or a projection. A schedule's text is held in
 * `scheduleText` for the same reason. On restart, a pending schedule whose text is
 * gone is cancelled with a stated reason rather than fired without its content —
 * the same honesty Work applies to an interrupted run.
 */

import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  type AttentionDirectiveView,
  type AttentionEventDetail,
  type AttentionProjection,
} from '../protocol/attention'
import {
  buildAttentionEvent,
  parseIngestPayload,
  parseSchedulePayload,
  type AttentionIngestInput,
} from './ingest'
import { decideAttention, type AttentionHistoryEntry, type AttentionIngestHistoryEntry } from './policy'
import { projectAttention } from './projection'
import {
  ATTENTION_LIMITS,
  isAttentionSource,
  outcomeRank,
  type AttentionDecision,
  type AttentionEvent,
  type AttentionEventKind,
  type AttentionInboxEntry,
  type AttentionOutcome,
  type AttentionScheduleRecord,
  type AttentionSource,
  type FocusState,
  type SeverityHint,
} from './types'
import {
  hasSeenKey,
  pendingSchedules,
  type AttentionState,
} from './state'

export interface AttentionEngineOptions {
  fabric: EventFabric
  now?: () => Date
  newId?: () => string
  /** Re-publish the mirror after any decision. */
  onChange?: () => void
  /** The focus reading, derived by Core from already-authorized state. */
  focus: () => FocusState
  /** Read fresh at each decision; never copied into state. */
  stopAll: () => boolean
  /** The folded attention state, owned by Core's reducer. */
  getState: () => AttentionState
  /** Whether a referenced goal is still open in Core's own Mission/Work state. */
  goalOpen?: (goalRef: string) => boolean
}

export type AttentionIngestOutcome =
  | { readonly ok: true; readonly decision: AttentionDecision }
  | { readonly ok: false; readonly reason: string }

/** What an internal Core subsystem passes. The source is a parameter, not a field. */
export interface AttentionInternalInput {
  readonly kind: AttentionEventKind
  readonly text: string
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly severityHint?: SeverityHint
  readonly dueAt?: string | null
  readonly occurredAt?: string
}

/** A narrow scope one authorized source holds. It can ingest, and nothing else. */
export interface AttentionSourceScope {
  readonly source: AttentionSource
  ingest(payload: unknown): Promise<AttentionIngestOutcome>
  ingestInternal(input: AttentionInternalInput): Promise<AttentionIngestOutcome>
}

/** A closed reason code for a budget refusal, so the journal names what ran out. */
export type AttentionBudgetLimit = 'interrupts-per-window' | 'speaks-per-window-per-source'

export class AttentionEngine {
  private readonly fabric: EventFabric
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly onChange: () => void
  private readonly focus: () => FocusState
  private readonly stopAll: () => boolean
  private readonly getState: () => AttentionState
  private readonly goalOpen: (goalRef: string) => boolean

  private inbox: AttentionInboxEntry[] = []
  private directive: AttentionDirectiveView | null = null
  private readonly scheduleText = new Map<string, string>()
  private open = false

  constructor(options: AttentionEngineOptions) {
    this.fabric = options.fabric
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.onChange = options.onChange ?? (() => {})
    this.focus = options.focus
    this.stopAll = options.stopAll
    this.getState = options.getState
    this.goalOpen = options.goalOpen ?? (() => false)
  }

  /**
   * Reconcile schedules recovered from the journal.
   *
   * A pending schedule whose text was in a previous process's memory cannot be
   * fired — firing it would either lose the content or invent one. It is cancelled
   * with a stated reason, which is the truthful outcome and the same one Work
   * records for a run that was executing when the process died.
   */
  async reconcile(): Promise<void> {
    if (this.open) return
    this.open = true
    for (const schedule of pendingSchedules(this.getState())) {
      if (this.scheduleText.has(schedule.scheduleId)) continue
      await this.fabric.append(
        'attention.schedule.cancelled',
        { scheduleId: schedule.scheduleId, reason: 'restart' },
        { actor: 'system', correlationId: schedule.scheduleId },
      )
    }
  }

  projection(): AttentionProjection {
    return projectAttention({
      sequence: this.fabric.lastSequence,
      state: this.getState(),
      inbox: this.inbox,
      focus: this.focus(),
      directive: this.directive,
    })
  }

  /** The owner's explicit read of one retained event's text, or null. */
  detail(eventId: string): AttentionEventDetail | null {
    const entry = this.inbox.find((item) => item.event.eventId === eventId)
    if (entry === undefined) return null
    return {
      eventId: entry.event.eventId,
      source: entry.event.source,
      kind: entry.event.kind,
      goalRef: entry.event.goalRef,
      text: entry.event.text,
      severityHint: entry.event.severityHint,
      observedAt: entry.event.observedAt,
      dueAt: entry.event.dueAt,
      outcome: entry.outcome,
    }
  }

  sourceScope(source: AttentionSource): AttentionSourceScope {
    return {
      source,
      ingest: (payload) => this.ingestFromPayload(payload, source),
      ingestInternal: (input) => this.ingestInternal(source, input),
    }
  }

  /** The renderer's route. The source is fixed by the caller, never by the payload. */
  async ingestFromPayload(payload: unknown, source: AttentionSource = 'owner'): Promise<AttentionIngestOutcome> {
    const occurredAt = this.now().toISOString()
    const parsed = parseIngestPayload(payload, source, occurredAt)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    return await this.ingest(parsed.value)
  }

  /** An internal Core subsystem's route. Validated by construction, then sanitized. */
  async ingestInternal(source: AttentionSource, input: AttentionInternalInput): Promise<AttentionIngestOutcome> {
    if (!isAttentionSource(source)) return { ok: false, reason: 'the attention source is not authorized' }
    const occurredAt = input.occurredAt ?? this.now().toISOString()
    const parsed = parseIngestPayload(
      {
        kind: input.kind,
        text: input.text,
        goalRef: input.goalRef ?? null,
        sourceRef: input.sourceRef ?? null,
        severityHint: input.severityHint ?? 'none',
        dueAt: input.dueAt ?? null,
      },
      source,
      occurredAt,
    )
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    return await this.ingest(parsed.value)
  }

  private async ingest(input: AttentionIngestInput): Promise<AttentionIngestOutcome> {
    const now = this.now()
    const observedAt = now.toISOString()
    const eventId = this.newId()
    const { event, dedupeKey } = buildAttentionEvent(input, eventId, observedAt)

    // Dedupe first, and before any append. A re-delivered event must not add a
    // journal line, a decision or an inbox entry, because that is exactly how a
    // replay storm would amplify.
    if (hasSeenKey(this.getState(), dedupeKey)) {
      return {
        ok: true,
        decision: this.duplicateDecision(event, now),
      }
    }

    const actor: PrincipalId = event.source === 'owner' ? 'owner' : 'system'
    await this.fabric.append(
      'attention.event.ingested',
      {
        eventId: event.eventId,
        dedupeKey,
        source: event.source,
        kind: event.kind,
        goalRef: event.goalRef,
        textLength: event.text.length,
        severityHint: event.severityHint,
        occurredAt: event.occurredAt,
        dueAt: event.dueAt,
      },
      { actor, correlationId: event.eventId },
    )

    const decision = await this.decide(event, now, false)

    // Retain the event text in memory for an explicit owner read. A `do-nothing`
    // is not retained: the whole point of the outcome is that Core chose not to
    // keep it in the foreground.
    if (outcomeRank(decision.outcome) >= outcomeRank('remember')) {
      this.retain(event, decision.outcome)
    }

    this.directive =
      outcomeRank(decision.outcome) >= outcomeRank('subtle-cue')
        ? {
            eventId: decision.eventId,
            source: decision.source,
            kind: decision.kind,
            outcome: decision.outcome as AttentionDirectiveView['outcome'],
            cueCode: decision.cueCode,
            importance: decision.importance,
            urgency: decision.urgency,
            decidedAt: decision.decidedAt,
          }
        : null

    this.onChange()
    return { ok: true, decision }
  }

  private duplicateDecision(event: AttentionEvent, now: Date): AttentionDecision {
    return {
      decisionId: this.newId(),
      eventId: event.eventId,
      source: event.source,
      kind: event.kind,
      goalRef: event.goalRef,
      importance: 'trivial',
      urgency: 'background',
      outcome: 'do-nothing',
      reason: 'duplicate',
      cueCode: null,
      focus: this.focus(),
      decidedAt: now.toISOString(),
    }
  }

  private history(): {
    decisions: AttentionHistoryEntry[]
    ingests: AttentionIngestHistoryEntry[]
  } {
    const state = this.getState()
    const decisions: AttentionHistoryEntry[] = state.decisions.map((record) => ({
      source: record.source,
      goalRef: record.goalRef,
      outcome: record.outcome,
      at: record.decidedAt,
    }))
    const ingests: AttentionIngestHistoryEntry[] = state.ingests.map((entry) => ({
      source: entry.source,
      at: entry.at,
    }))
    return { decisions, ingests }
  }

  private async decide(event: AttentionEvent, now: Date, scheduled: boolean): Promise<AttentionDecision> {
    const { decisions, ingests } = this.history()
    const result = decideAttention({
      event,
      now,
      focus: this.focus(),
      stopAll: this.stopAll(),
      recentDecisions: decisions,
      recentIngests: ingests,
      scheduled,
    })
    const decision: AttentionDecision = {
      decisionId: this.newId(),
      eventId: event.eventId,
      source: event.source,
      kind: event.kind,
      goalRef: event.goalRef,
      importance: result.importance,
      urgency: result.urgency,
      outcome: result.outcome,
      reason: result.reason,
      cueCode: result.cueCode,
      focus: this.focus(),
      decidedAt: now.toISOString(),
    }
    const actor: PrincipalId = event.source === 'owner' ? 'owner' : 'system'
    await this.fabric.append(
      'attention.decision.made',
      {
        decisionId: decision.decisionId,
        eventId: decision.eventId,
        source: decision.source,
        kind: decision.kind,
        goalRef: decision.goalRef,
        outcome: decision.outcome,
        importance: decision.importance,
        urgency: decision.urgency,
        reason: decision.reason,
        cueCode: decision.cueCode,
        focus: decision.focus,
      },
      { actor, correlationId: decision.decisionId },
    )
    if (result.reason === 'budget') {
      const limit: AttentionBudgetLimit =
        decision.outcome === 'subtle-cue' && result.urgency !== 'urgent'
          ? 'speaks-per-window-per-source'
          : 'interrupts-per-window'
      await this.fabric.append(
        'attention.budget.exceeded',
        { source: decision.source, goalRef: decision.goalRef, limit, observed: 0 },
        { actor: 'system', correlationId: decision.decisionId },
      )
    }
    return decision
  }

  private retain(event: AttentionEvent, outcome: AttentionOutcome): void {
    const without = this.inbox.filter((entry) => entry.event.eventId !== event.eventId)
    without.push({ event, outcome })
    this.inbox =
      without.length > ATTENTION_LIMITS.maxInboxEntries
        ? without.slice(without.length - ATTENTION_LIMITS.maxInboxEntries)
        : without
  }

  /* ------------------------------------------------------------- schedules */

  async registerSchedule(payload: unknown): Promise<{ ok: true; scheduleId: string } | { ok: false; reason: string }> {
    const parsed = parseSchedulePayload(payload)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const state = this.getState()
    if (pendingSchedules(state).length >= ATTENTION_LIMITS.maxSchedules) {
      return { ok: false, reason: `attention holds at most ${ATTENTION_LIMITS.maxSchedules} schedules` }
    }
    const now = this.now()
    const due = Date.parse(parsed.value.dueAt)
    if (!Number.isFinite(due)) return { ok: false, reason: 'the schedule due time is not an instant' }
    if (due > now.getTime() + ATTENTION_LIMITS.maxScheduleHorizonMs) {
      return { ok: false, reason: 'the schedule is further ahead than attention will hold' }
    }

    const scheduleId = this.newId()
    this.scheduleText.set(scheduleId, parsed.value.text)
    await this.fabric.append(
      'attention.schedule.registered',
      {
        scheduleId,
        kind: parsed.value.kind,
        goalRef: parsed.value.goalRef,
        severityHint: parsed.value.severityHint,
        dueAt: parsed.value.dueAt,
        intervalMs: parsed.value.intervalMs,
        maxRepeats: parsed.value.maxRepeats,
        condition: parsed.value.condition,
      },
      { actor: 'owner', correlationId: scheduleId },
    )
    this.onChange()
    return { ok: true, scheduleId }
  }

  async cancelSchedule(scheduleId: string): Promise<boolean> {
    const schedule = this.getState().schedules.find((item) => item.scheduleId === scheduleId)
    if (schedule === undefined || schedule.status !== 'pending') return false
    this.scheduleText.delete(scheduleId)
    await this.fabric.append(
      'attention.schedule.cancelled',
      { scheduleId, reason: 'owner-cancelled' },
      { actor: 'owner', correlationId: scheduleId },
    )
    this.onChange()
    return true
  }

  /**
   * Evaluate due schedules. The only wake mechanism, and it does nothing else.
   *
   * A schedule fires only when its condition holds against already-authorized
   * state. `tick` performs no model call, reaches no provider, and appends nothing
   * for a schedule that is not due or whose condition is unmet.
   */
  async tick(now: Date = this.now()): Promise<number> {
    let fired = 0
    for (const schedule of pendingSchedules(this.getState())) {
      const due = Date.parse(schedule.dueAt)
      if (!Number.isFinite(due) || due > now.getTime()) continue
      if (!this.conditionHolds(schedule)) continue

      const text = this.scheduleText.get(schedule.scheduleId)
      if (text === undefined) {
        // Recovered from a previous process: no content, so it cannot fire.
        await this.fabric.append(
          'attention.schedule.cancelled',
          { scheduleId: schedule.scheduleId, reason: 'content-unavailable' },
          { actor: 'system', correlationId: schedule.scheduleId },
        )
        continue
      }

      const eventId = this.newId()
      await this.fabric.append(
        'attention.schedule.fired',
        { scheduleId: schedule.scheduleId, eventId, repeats: schedule.repeats + 1 },
        { actor: 'system', correlationId: schedule.scheduleId },
      )

      const input: AttentionIngestInput = {
        source: 'system',
        kind: schedule.kind,
        text,
        goalRef: schedule.goalRef,
        sourceRef: `${schedule.scheduleId}:${schedule.repeats + 1}`,
        severityHint: schedule.severityHint,
        dueAt: schedule.dueAt,
        occurredAt: schedule.dueAt,
      }
      const { event, dedupeKey } = buildAttentionEvent(input, eventId, now.toISOString())
      if (hasSeenKey(this.getState(), dedupeKey)) continue
      await this.fabric.append(
        'attention.event.ingested',
        {
          eventId: event.eventId,
          dedupeKey,
          source: event.source,
          kind: event.kind,
          goalRef: event.goalRef,
          textLength: event.text.length,
          severityHint: event.severityHint,
          occurredAt: event.occurredAt,
          dueAt: event.dueAt,
        },
        { actor: 'system', correlationId: event.eventId },
      )
      const decision = await this.decide(event, now, true)
      if (outcomeRank(decision.outcome) >= outcomeRank('remember')) {
        this.retain(event, decision.outcome)
      }
      this.directive =
        outcomeRank(decision.outcome) >= outcomeRank('subtle-cue')
          ? {
              eventId: decision.eventId,
              source: decision.source,
              kind: decision.kind,
              outcome: decision.outcome as AttentionDirectiveView['outcome'],
              cueCode: decision.cueCode,
              importance: decision.importance,
              urgency: decision.urgency,
              decidedAt: decision.decidedAt,
            }
          : null
      fired += 1
    }
    if (fired > 0) this.onChange()
    return fired
  }

  private conditionHolds(schedule: AttentionScheduleRecord): boolean {
    switch (schedule.condition) {
      case 'always':
        return true
      case 'focus-available':
        return this.focus() !== 'focused'
      case 'goal-open':
        return schedule.goalRef !== null && this.goalOpen(schedule.goalRef)
    }
  }
}
