/**
 * THE EXECUTIVE EVENT SYSTEM — Phase 4C Event-Driven Decisions.
 *
 * Decisions in Freya are strictly event-driven.
 * - NO infinite polling loops.
 * - NO background setInterval / setTimeout outside of LifeLoop.
 * - NO hidden model calls.
 *
 * LifeLoop remains the wake authority for scheduled and heartbeat ticks.
 * Authoritative events from the event journal trigger bounded evaluation passes.
 */

import type { ExecutiveDecisionInput, ExecutiveDecisionOutcome } from './decision'
import { evaluateExecutiveDecision } from './decision'

/** Closed set of event prefixes/types that trigger Executive re-evaluation. */
export const EXECUTIVE_TRIGGER_EVENT_PREFIXES = [
  'mission.',
  'work.',
  'workforce.',
  'security.stop_all.',
  'stop_all.',
  'lifeloop.',
  'approval.',
] as const

/** Closed set of specific non-triggering event types (e.g. purely observational/diagnostic). */
export const EXECUTIVE_IGNORED_EVENT_TYPES = new Set([
  'core.health',
  'diagnostics.',
  'learning.recalled',
])

/**
 * Determine whether a given event type warrants an Executive decision re-evaluation.
 * Pure, deterministic.
 */
export function isExecutiveTriggerEvent(eventType: string): boolean {
  if (typeof eventType !== 'string' || eventType.length === 0) return false
  if (EXECUTIVE_IGNORED_EVENT_TYPES.has(eventType)) return false
  for (const prefix of EXECUTIVE_TRIGGER_EVENT_PREFIXES) {
    if (eventType.startsWith(prefix)) return true
  }
  return false
}

export interface EventDrivenExecutiveEvaluationInput {
  readonly event: { readonly type: string; readonly occurredAt?: string; readonly payload?: unknown }
  readonly decisionInput: ExecutiveDecisionInput
}

/**
 * Pure function: Given an event and current authoritative decision input, evaluates
 * whether an executive decision should be computed, and if so, computes it deterministically.
 */
export function evaluateExecutiveOnEvent(
  input: EventDrivenExecutiveEvaluationInput,
): { readonly triggered: boolean; readonly outcome: ExecutiveDecisionOutcome | null } {
  const { event, decisionInput } = input
  if (!isExecutiveTriggerEvent(event.type)) {
    return { triggered: false, outcome: null }
  }

  // Use event timestamp as effective clock if present
  const effectiveNow = event.occurredAt ?? decisionInput.now
  const outcome = evaluateExecutiveDecision({
    ...decisionInput,
    now: effectiveNow,
  })

  return {
    triggered: true,
    outcome,
  }
}
